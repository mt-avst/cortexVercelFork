import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers } from "../../__tests__/helpers/listening";

/**
 * GET /api/me/session-events must carry the opportunity TYPE (row 5, Lane D
 * feeding Lane B).
 *
 * My-bookings "Completed studies" renders one card per session and needs to
 * name the study format ("Quick poll", "Live session", ...). Today the payload
 * omits `type`, so the participant page hard-codes `unmoderated` for every
 * event. Lane B reads a real `type`; this route must supply it.
 *
 * WHY REAL POSTGRES. The handler spreads the row (`{...r}`), so a MOCKED pool
 * that returns a row already carrying `type` would pass whether or not the SQL
 * selects `o.type` - a vacuous green. Only a real JOIN proves the column is
 * actually projected: on main the SELECT has no `o.type`, so `type` comes back
 * undefined and this fails by name.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

async function seedEvent(type: string): Promise<{ participantId: string }> {
  const participantId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const opportunityId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', $2, 'researcher_admin')`,
    [ownerId, `owner-${ownerId}@example.com`]
  );
  await pool.query(
    `INSERT INTO users (id, name, email) VALUES ($1, 'Participant', $2)`,
    [participantId, `participant-${participantId}@example.com`]
  );
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
     VALUES ($1, $2, 'Typed study', 'Proving the type flows to the participant', $3, 'published')`,
    [opportunityId, type, ownerId]
  );
  await pool.query(
    `INSERT INTO opportunity_session_events
       (id, opportunity_id, participant_user_id, firsthand_session_id, event_type, occurred_at)
     VALUES ($1, $2, $3, $4, 'session_completed', NOW())`,
    [crypto.randomUUID(), opportunityId, participantId, `fh-${crypto.randomUUID()}`]
  );
  return { participantId };
}

describe.skipIf(skipDbTests)("GET /api/me/session-events carries the opportunity type", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("me-session-events-type");
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-session-events-constant-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();

    const { pool: appPool } = await import("../../config");
    pool = appPool;

    const apiRouter = (await import("../api")).default;
    const { errorHandler } = await import("../../utils/errorHandler");
    const expressModule = (await import("express")).default;

    app = expressModule();
    app.use(expressModule.json());
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id");
      if (userId) {
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id: userId, name: "Test", email: "t@example.com", role: "employee" },
        };
      }
      next();
    });
    app.use("/api", apiRouter);
    app.use(errorHandler);
  }, 180_000);

  afterAll(async () => {
    await closeListeningServers();
    await pool?.end().catch(() => {});
    await postgres?.stop();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE opportunity_session_events, opportunities, users CASCADE"
    );
  });

  it("returns type 'poll' for a poll session event", async () => {
    const { participantId } = await seedEvent("poll");
    const res = await request(app)
      .get("/api/me/session-events")
      .set("x-test-user-id", participantId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].type).toBe("poll");
  });

  it("returns type 'interview' for an interview session event", async () => {
    const { participantId } = await seedEvent("interview");
    const res = await request(app)
      .get("/api/me/session-events")
      .set("x-test-user-id", participantId);
    expect(res.status).toBe(200);
    expect(res.body[0].type).toBe("interview");
  });
});
