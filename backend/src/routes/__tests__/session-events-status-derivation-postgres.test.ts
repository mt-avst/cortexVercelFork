import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers } from "../../__tests__/helpers/listening";

const execFileAsync = promisify(execFile);

/**
 * GET /api/opportunities/:id/session-events must derive session status truly
 * (row 10):
 *   - a session whose transcript FAILED carries `transcript_status: 'failed'`,
 *     so the list can say "Transcript failed" rather than a bare "Completed";
 *   - a session the participant DECLINED consent on carries
 *     `consent_declined: true`, so it is its own status and not lumped in with
 *     the genuinely Abandoned.
 *
 * Both facts live in the `firsthand` runtime schema (same database, different
 * schema): `transcript_status` on `runtime_sessions` (latest attempt), and the
 * `consent_declined` event on `runtime_events`. The list is fed from
 * `public.opportunity_session_events`, which records `session_abandoned` for a
 * decline and no transcript state at all, so only a cross-schema JOIN recovers
 * the truth.
 *
 * WHY REAL POSTGRES (mandatory): the derivation is entirely in the SQL. On main
 * the payload carries neither field, so both assertions fail by name.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";
const migrateScript = path.resolve(__dirname, "../../../scripts/firsthand-migrate.mjs");

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;
let ownerId: string;
let opportunityId: string;

async function seedRuntimeSession(opts: {
  logicalSessionId: string;
  sessionStatus: string;
  transcriptStatus: string;
}): Promise<string> {
  const sessionId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO firsthand.runtime_sessions
       (session_id, token, study_id, study_title, participant_id, participant_display_name,
        session_status, transcript_status, microphone_permission, screen_permission,
        recording_status, upload_status, steps, logical_session_id, attempt_number, created_via)
     VALUES ($1, $2, 'study', 'Study', 'p', 'P',
             $3, $4, 'granted', 'granted',
             'stopped', 'complete', '[]'::jsonb, $5, 1, 'manual')`,
    [sessionId, `tok-${sessionId}`, opts.sessionStatus, opts.transcriptStatus, opts.logicalSessionId]
  );
  return sessionId;
}

async function seedEvent(logicalSessionId: string, eventType: string): Promise<void> {
  await pool.query(
    `INSERT INTO public.opportunity_session_events
       (id, opportunity_id, participant_user_id, firsthand_session_id, event_type, occurred_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [crypto.randomUUID(), opportunityId, ownerId, logicalSessionId, eventType]
  );
}

describe.skipIf(skipDbTests)("GET session-events derives transcript-failed and declined-consent", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("session-events-status");
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-status-derivation-constant-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();
    // The firsthand runtime schema is migrated separately from the main schema.
    await execFileAsync("node", [migrateScript], {
      env: { ...process.env, DATABASE_URL: postgres.connectionString },
      timeout: 60_000,
    });

    const { pool: appPool } = await import("../../config");
    pool = appPool;

    const opportunitiesRouter = (await import("../opportunities")).default;
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
    app.use("/api/opportunities", opportunitiesRouter);
    app.use(errorHandler);
  }, 180_000);

  afterAll(async () => {
    await closeListeningServers();
    await pool?.end().catch(() => {});
    await postgres?.stop();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE firsthand.runtime_sessions CASCADE");
    await pool.query("TRUNCATE opportunity_session_events, opportunities, users CASCADE");
    ownerId = crypto.randomUUID();
    opportunityId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', $2, 'researcher_admin')`,
      [ownerId, `owner-${ownerId}@example.com`]
    );
    await pool.query(
      `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
       VALUES ($1, 'unmoderated', 'Status study', 'Deriving true session status', $2, 'published')`,
      [opportunityId, ownerId]
    );
  });

  const fetchEvents = () =>
    request(app)
      .get(`/api/opportunities/${opportunityId}/session-events`)
      .set("x-test-user-id", ownerId)
      .set("x-test-user-role", "researcher_admin");

  const byFhId = (
    rows: Array<{ firsthand_session_id: string; transcript_status?: string | null; consent_declined?: boolean }>,
    id: string
  ) => rows.find((r) => r.firsthand_session_id === id)!;

  it("carries transcript_status: 'failed' for a completed session whose transcript failed", async () => {
    await seedRuntimeSession({ logicalSessionId: "logical-A", sessionStatus: "completed", transcriptStatus: "failed" });
    await seedEvent("logical-A", "session_completed");
    const res = await fetchEvents();
    expect(res.status).toBe(200);
    expect(byFhId(res.body, "logical-A").transcript_status).toBe("failed");
  });

  it("marks a declined-consent session with consent_declined: true, distinct from a plain abandon", async () => {
    const declinedSession = await seedRuntimeSession({ logicalSessionId: "logical-B", sessionStatus: "abandoned", transcriptStatus: "not_requested" });
    await pool.query(
      `INSERT INTO firsthand.runtime_events (id, session_id, event_type, timestamp)
       VALUES ($1, $2, 'consent_declined', NOW())`,
      [crypto.randomUUID(), declinedSession]
    );
    await seedEvent("logical-B", "session_abandoned");

    // A genuinely abandoned session (no consent decline) as the control.
    await seedRuntimeSession({ logicalSessionId: "logical-D", sessionStatus: "abandoned", transcriptStatus: "not_requested" });
    await seedEvent("logical-D", "session_abandoned");

    const res = await fetchEvents();
    expect(res.status).toBe(200);
    expect(byFhId(res.body, "logical-B").consent_declined).toBe(true);
    expect(byFhId(res.body, "logical-D").consent_declined).toBe(false);
  });

  it("leaves a cleanly completed session with a non-failed transcript and no decline", async () => {
    await seedRuntimeSession({ logicalSessionId: "logical-C", sessionStatus: "completed", transcriptStatus: "complete" });
    await seedEvent("logical-C", "session_completed");
    const res = await fetchEvents();
    const row = byFhId(res.body, "logical-C");
    expect(row.transcript_status).toBe("complete");
    expect(row.consent_declined).toBe(false);
  });
});
