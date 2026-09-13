import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * DELETE /api/sessions/:id must refuse to remove the LAST bookable slot of a
 * published live session or interview (row 14).
 *
 * A published test/interview advertises "Book a time"; strip its last upcoming
 * slot and it advertises over nothing anyone can book - the a21 defect the
 * publish gate (`findPublishProblem` -> `bookable_slot_required`) exists to
 * stop. The delete path re-asks that same predicate for the POST-delete state
 * and refuses with 409 when it would leave the study slotless. Default is
 * refuse; it never auto-unpublishes.
 *
 * WHY REAL POSTGRES. The guard reads the opportunity status/type and counts the
 * remaining `end_time > NOW()` slots inside the delete transaction; only a real
 * database exercises the count and the FOR UPDATE path. On main the delete only
 * checks `booked_count`, so removing the last slot returns 204 - this fails by
 * name until the guard lands.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;
let ownerId: string;

async function seedStudy(opts: {
  type: string;
  status: string;
  slots: Array<"future" | "past">;
}): Promise<{ opportunityId: string; sessionIds: string[] }> {
  const opportunityId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
     VALUES ($1, $2, 'Slot guard study', 'Proving the last-slot delete guard', $3, $4)`,
    [opportunityId, opts.type, ownerId, opts.status]
  );
  const sessionIds: string[] = [];
  for (const when of opts.slots) {
    const sessionId = crypto.randomUUID();
    const start = when === "future" ? "NOW() + INTERVAL '1 day'" : "NOW() - INTERVAL '2 days'";
    const end = when === "future" ? "NOW() + INTERVAL '1 day 1 hour'" : "NOW() - INTERVAL '2 days' + INTERVAL '1 hour'";
    await pool.query(
      `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
       VALUES ($1, $2, ${start}, ${end}, 5, 0)`,
      [sessionId, opportunityId]
    );
    sessionIds.push(sessionId);
  }
  return { opportunityId, sessionIds };
}

const del = (sessionId: string) =>
  request(listening(app))
    .delete(`/api/sessions/${sessionId}`)
    .set("x-test-user-id", ownerId)
    .set("x-test-user-role", "researcher_admin");

describe.skipIf(skipDbTests)("DELETE session guards the last bookable slot of a published study", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("sessions-delete-last-slot");
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-delete-last-slot-constant-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();

    const { pool: appPool } = await import("../../config");
    pool = appPool;

    const sessionsRouter = (await import("../sessions")).default;
    const { errorHandler } = await import("../../utils/errorHandler");
    const expressModule = (await import("express")).default;

    app = expressModule();
    app.use(expressModule.json());
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id");
      const role = req.header("x-test-user-role") ?? "employee";
      if (userId) {
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id: userId, name: "Owner", email: "owner@example.com", role },
        };
      }
      next();
    });
    app.use("/api/sessions", sessionsRouter);
    app.use(errorHandler);
  }, 180_000);

  afterAll(async () => {
    await closeListeningServers();
    await pool?.end().catch(() => {});
    await postgres?.stop();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE bookings, sessions, opportunities, users CASCADE");
    ownerId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', $2, 'researcher_admin')`,
      [ownerId, `owner-${ownerId}@example.com`]
    );
  });

  it("refuses (409) deleting the only future slot of a published interview", async () => {
    const { sessionIds } = await seedStudy({ type: "interview", status: "published", slots: ["future"] });
    const res = await del(sessionIds[0]);
    expect(res.status).toBe(409);
    const remaining = await pool.query("SELECT count(*)::int AS n FROM sessions");
    expect(remaining.rows[0].n).toBe(1); // nothing deleted
  });

  it("refuses (409) deleting the only future slot of a published test", async () => {
    const { sessionIds } = await seedStudy({ type: "test", status: "published", slots: ["future"] });
    expect((await del(sessionIds[0])).status).toBe(409);
  });

  it("allows deleting a slot from a DRAFT study", async () => {
    const { sessionIds } = await seedStudy({ type: "interview", status: "draft", slots: ["future"] });
    expect((await del(sessionIds[0])).status).toBe(204);
  });

  it("allows deleting one slot when a published study has two future slots", async () => {
    const { sessionIds } = await seedStudy({ type: "interview", status: "published", slots: ["future", "future"] });
    expect((await del(sessionIds[0])).status).toBe(204);
    const remaining = await pool.query("SELECT count(*)::int AS n FROM sessions");
    expect(remaining.rows[0].n).toBe(1);
  });

  it("allows deleting a PAST slot while a future one remains (deleting it does not reduce bookable slots)", async () => {
    const { sessionIds } = await seedStudy({ type: "interview", status: "published", slots: ["past", "future"] });
    // sessionIds[0] is the past slot
    expect((await del(sessionIds[0])).status).toBe(204);
  });

  it("allows deleting a PAST slot when NO future slot remains (booking window already closed)", async () => {
    // A published interview whose slots have all elapsed is already unbookable;
    // deleting an old slot must not be refused as "the last bookable slot",
    // because a past slot is not bookable at all. The guard only engages when
    // the slot being removed is itself upcoming.
    const { sessionIds } = await seedStudy({ type: "interview", status: "published", slots: ["past", "past"] });
    expect((await del(sessionIds[0])).status).toBe(204);
    expect((await del(sessionIds[1])).status).toBe(204);
  });

  it("allows deleting the last slot of a published POLL (polls are not booked)", async () => {
    const { sessionIds } = await seedStudy({ type: "poll", status: "published", slots: ["future"] });
    expect((await del(sessionIds[0])).status).toBe(204);
  });
});
