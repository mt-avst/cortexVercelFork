import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../__tests__/helpers/postgres-instance";

/**
 * The participant scope on `findParticipantCompletionsForOpportunities`,
 * against a real Postgres.
 *
 * `WHERE participant_id = $1` is the IDOR filter on the completion trace: it is
 * what stops caller A being told they completed a study that caller B completed.
 * The route tests in `opportunities.test.ts` mock this repository, so nothing
 * there fails if the filter is removed - the scope is only ever evaluated by a
 * database. This file evaluates it: two participants across two opportunities,
 * asserting A's read carries A's rows and never B's.
 *
 * B's session for the shared opportunity is deliberately the NEWEST row in the
 * table, so a dropped `participant_id` filter would not merely widen the result
 * - `DISTINCT ON (opportunity_id) ... ORDER BY created_at DESC` would pick B's
 * row for that opportunity and surface B's `completed` status on A's query.
 * The assertion is therefore on the STATUS A gets back, not just the row count.
 */
const execFileAsync = promisify(execFile);
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

const migrateScript = path.resolve(__dirname, "../../scripts/firsthand-migrate.mjs");

const PARTICIPANT_A = "participant_a";
const PARTICIPANT_B = "participant_b";
const OPP_SHARED = "opp_shared";
const OPP_A_ONLY = "opp_a_only";

// A fixed timeline so "newest row" is a property of the data, not of insertion
// order. B's shared-opportunity session (t3) is the latest row overall.
const T0 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-01T02:00:00.000Z";
const T3 = "2026-01-01T03:00:00.000Z";

let databaseUrl: string;
let pool: pg.Pool;
let postgres: TestPostgres;

const importRepository = async () => await import("./runtime-repository-postgres");

/**
 * One runtime_sessions row. The column list mirrors `session-store`'s own
 * insert (all the NOT NULL columns plus the attempt/opportunity columns later
 * migrations added); only participant_id, opportunity_id, session_status,
 * completed_at and created_at vary between rows here.
 */
const seedSession = async (input: {
  sessionId: string;
  participantId: string;
  opportunityId: string;
  sessionStatus: string;
  completedAt: string | null;
  createdAt: string;
  attemptNumber?: number;
  logicalSessionId?: string;
}): Promise<void> => {
  await pool.query(
    `INSERT INTO firsthand.runtime_sessions
       (session_id, token, study_id, study_title, participant_id,
        participant_display_name, session_status, transcript_status,
        microphone_permission, screen_permission, recording_status,
        upload_status, completed_at, created_at, updated_at, opportunity_id,
        steps, logical_session_id, attempt_number)
     VALUES ($1, $2, 'study_x', 'Study X', $3, 'P', $4, 'none',
             'granted', 'granted', 'idle', 'idle', $5, $6, $6, $7,
             '[]'::jsonb, $8, $9)`,
    [
      input.sessionId,
      `tok_${input.sessionId}`,
      input.participantId,
      input.sessionStatus,
      input.completedAt,
      input.createdAt,
      input.opportunityId,
      input.logicalSessionId ?? input.sessionId,
      input.attemptNumber ?? 1
    ]
  );
};

describe.skipIf(skipDbTests)(
  "participant completion scoping, against a real Postgres",
  () => {
    beforeAll(async () => {
      postgres = await startTestPostgres("completion-scope");
      databaseUrl = postgres.connectionString;

      await execFileAsync("node", [migrateScript], {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        timeout: 60_000
      });

      pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    }, 120_000);

    afterAll(async () => {
      await pool?.end().catch(() => {});
      await postgres?.stop();
    });

    beforeEach(async () => {
      process.env.DATABASE_URL = databaseUrl;
      await pool.query("TRUNCATE firsthand.runtime_sessions CASCADE");
    });

    afterEach(async () => {
      delete process.env.DATABASE_URL;
      const globals = globalThis as typeof globalThis & {
        __firsthandRuntimePool?: { end?: () => Promise<void> };
        __firsthandRuntimeVerification?: unknown;
      };
      await globals.__firsthandRuntimePool?.end?.().catch(() => {});
      delete globals.__firsthandRuntimePool;
      delete globals.__firsthandRuntimeVerification;
    });

    /**
     * A answered OPP_A_ONLY twice (a resumed session) and started OPP_SHARED
     * without finishing it; B completed OPP_SHARED afterwards. B's completion
     * is the newest row in the table.
     */
    const seedTwoParticipants = async (): Promise<void> => {
      // A, OPP_SHARED: an unfinished attempt.
      await seedSession({
        sessionId: "a_shared",
        participantId: PARTICIPANT_A,
        opportunityId: OPP_SHARED,
        sessionStatus: "active",
        completedAt: null,
        createdAt: T0
      });
      // A, OPP_A_ONLY: attempt 1, superseded.
      await seedSession({
        sessionId: "a_only_1",
        participantId: PARTICIPANT_A,
        opportunityId: OPP_A_ONLY,
        sessionStatus: "active",
        completedAt: null,
        createdAt: T0,
        attemptNumber: 1,
        logicalSessionId: "a_only"
      });
      // A, OPP_A_ONLY: attempt 2, the latest and the completed one.
      await seedSession({
        sessionId: "a_only_2",
        participantId: PARTICIPANT_A,
        opportunityId: OPP_A_ONLY,
        sessionStatus: "completed",
        completedAt: T2,
        createdAt: T2,
        attemptNumber: 2,
        logicalSessionId: "a_only"
      });
      // B, OPP_SHARED: completed, and the NEWEST row in the table - the row a
      // dropped participant filter would surface on A's read.
      await seedSession({
        sessionId: "b_shared",
        participantId: PARTICIPANT_B,
        opportunityId: OPP_SHARED,
        sessionStatus: "completed",
        completedAt: T3,
        createdAt: T3
      });
    };

    it("scopes each participant's completions to their own sessions", async () => {
      await seedTwoParticipants();
      const repository = await importRepository();

      const forA = await repository.findParticipantCompletionsForOpportunities({
        participantId: PARTICIPANT_A,
        opportunityIds: [OPP_SHARED, OPP_A_ONLY]
      });

      const byOpp = new Map(forA.map((row) => [row.opportunityId, row]));

      // Exactly A's two opportunities, never a third row leaking in from B.
      expect(forA).toHaveLength(2);

      // THE SCOPING ASSERTION. A never finished OPP_SHARED, so A's own row is
      // `active`. B's `completed` row for the same opportunity is newer, so a
      // dropped `participant_id = $1` filter would let DISTINCT ON pick it and
      // this would read `completed` with B's completed_at.
      expect(byOpp.get(OPP_SHARED)).toEqual({
        opportunityId: OPP_SHARED,
        sessionStatus: "active",
        completedAt: null
      });

      // THE LATEST-ATTEMPT ASSERTION. A's second attempt at OPP_A_ONLY is the
      // newer row, so DISTINCT ON ... created_at DESC must return `completed`,
      // not the earlier `active` attempt.
      expect(byOpp.get(OPP_A_ONLY)).toEqual({
        opportunityId: OPP_A_ONLY,
        sessionStatus: "completed",
        completedAt: T2
      });
    });

    it("returns B's own completion when B asks - the row A must not see is real and reachable", async () => {
      // THE CONTROL. A's read asserting OPP_SHARED is `active` proves nothing on
      // its own: a scope that returned no shared row at all would satisfy it
      // too. This confirms B's newer `completed` row for OPP_SHARED exists and
      // is returned to its own owner, so the assertion above had a wrong answer
      // available to detect.
      await seedTwoParticipants();
      const repository = await importRepository();

      const forB = await repository.findParticipantCompletionsForOpportunities({
        participantId: PARTICIPANT_B,
        opportunityIds: [OPP_SHARED, OPP_A_ONLY]
      });

      expect(forB).toEqual([
        {
          opportunityId: OPP_SHARED,
          sessionStatus: "completed",
          completedAt: T3
        }
      ]);
    });
  }
);
