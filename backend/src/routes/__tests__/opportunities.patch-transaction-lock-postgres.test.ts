import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";
import { PUBLISH_PROBLEM_MESSAGES } from "../../../../shared/firsthand/publish-readiness";

/**
 * `PATCH /api/opportunities/:id` READS ITS ROW `FOR UPDATE`, AGAINST A REAL
 * DATABASE (cto/AdaptaLabs#151).
 *
 * The SELECT that loaded the current row and the UPDATE that closed the
 * handler used to be two separate, unlocked `pool.query` calls with no
 * transaction between them, so every stored-vs-incoming decision the handler
 * makes - the external-link consent-affirmation reset (#136), the moderated
 * consent/type strip, and the publish guard - could be taken against a row
 * that had already moved by the time the UPDATE landed.
 *
 * This proves the publish guard specifically, because it is the one whose
 * broken form is easiest to pin without racing real wall-clock timing. A
 * concurrent PATCH that is SILENT about `status` falls back to
 * `existingOpp.rows[0].status` to decide whether the row IS published
 * (`willBePublished`). Read that value unlocked while a sibling PATCH is
 * committing `status: 'published'`, and a request that only changes `type`
 * can turn a poll into a moderated interview with no bookable slot on a row
 * that, the instant the sibling commits, is LIVE - the exact a21 defect
 * (cto/AdaptaLabs#118) the bookable-slot gate exists to prevent, reopened by
 * racing it rather than by a hole in the predicate itself.
 *
 * WHY `type` AND NOT THE FIELD #136 NAMES. `external_link_optional` has no
 * representable "clear this" value on the update schema - it is
 * `z.string().url().optional()`, not `.nullable()`, so a PATCH cannot ask to
 * remove a link at all. `type` triggers the exact same fallback
 * (`existingOpp.rows[0].status`) through the exact same `changesPublishShape`
 * predicate, with no schema obstacle in the way - the mechanism under test is
 * the locked read, not which column happens to trigger it.
 *
 * WHY A REAL POSTGRES AND A REAL LOCK, not two mocked `pool.query` calls run
 * back to back. A mock cannot fail to serialise two callers - there is only
 * ever one thread evaluating the two arrangements a test queues, in the order
 * it queues them. The property under test - that the SECOND transaction's
 * `SELECT ... FOR UPDATE` genuinely BLOCKS on the ROW LOCK the first is
 * holding, and only proceeds once that transaction has committed - only
 * exists on a real server with real MVCC and real row locks.
 *
 * Runs in CI's `test-backend-db` (`npx vitest run postgres`); the no-DB
 * vitest job skips it via FIRSTHAND_SKIP_DB_TESTS, exactly like every other
 * `*-postgres.test.ts` file in this directory.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

const SLOT_GATE_MESSAGE = PUBLISH_PROBLEM_MESSAGES.bookable_slot_required;

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

interface Fixture {
  ownerId: string;
  opportunityId: string;
}

/** A draft poll - unmoderated, so it carries no bookable-slot requirement yet. */
async function seedDraftPoll(): Promise<Fixture> {
  const ownerId = crypto.randomUUID();
  const opportunityId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', $2, 'researcher_admin')`,
    [ownerId, `owner-${ownerId}@example.com`]
  );
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
     VALUES ($1, 'poll', 'Transaction lock test opportunity',
             'Proving the PATCH handler reads its row FOR UPDATE', $2, 'draft')`,
    [opportunityId, ownerId]
  );

  return { ownerId, opportunityId };
}

const patchToInterview = (fixture: Fixture) =>
  request(listening(app))
    .patch(`/api/opportunities/${fixture.opportunityId}`)
    .set("x-test-user-id", fixture.ownerId)
    .send({ type: "interview" })
    .then((sent) => sent);

const storedRow = async (
  opportunityId: string
): Promise<{ status: string; type: string }> => {
  const { rows } = await pool.query(
    "SELECT status, type FROM opportunities WHERE id = $1",
    [opportunityId]
  );
  return rows[0];
};

describe.skipIf(skipDbTests)(
  "PATCH /api/opportunities/:id reads its row FOR UPDATE, against a real Postgres",
  () => {
    beforeAll(async () => {
      postgres = await startTestPostgres("opportunities-patch-transaction-lock");

      // BEFORE importing ../../config: the pool reads DATABASE_URL once, at
      // import, so a later assignment would not reach the app pool.
      process.env.DATABASE_URL = postgres.connectionString;
      // shared/config/environment.ts wants >= 32 characters at config import.
      // Nothing here signs anything, so a fixed constant.
      process.env.SESSION_SECRET ||=
        "vitest-postgres-patch-transaction-lock-not-a-real-secret"; // gitleaks:allow
      process.env.NODE_ENV = "test";

      const { runMigrations } = await import("../../db/migrate");
      await runMigrations();

      const { pool: appPool } = await import("../../config");
      pool = appPool;

      const opportunitiesRouter = (await import("../opportunities")).default;
      const { errorHandler } = await import("../../utils/errorHandler");
      const expressModule = (await import("express")).default;

      app = expressModule();
      app.use(expressModule.json());
      // Stands in for the real session middleware. `requireAdmin` re-reads the
      // role from the database itself (#14), so the seeded user's real row is
      // what decides the gate.
      app.use((req, _res, next) => {
        const userId = req.header("x-test-user-id");
        if (userId) {
          (req as unknown as { session: { user: unknown } }).session = {
            user: { id: userId, name: "Test", email: "t@example.com", role: "researcher_admin" },
          };
        }
        next();
      });
      app.use("/api/opportunities", opportunitiesRouter);
      app.use(errorHandler);
    }, 180_000);

    afterAll(async () => {
      // The jest global teardown that normally closes these does not run
      // under vitest, so close here or the open server holds the process open.
      await closeListeningServers();
      await pool?.end().catch(() => {});
      await postgres?.stop();
      delete process.env.DATABASE_URL;
    });

    beforeEach(async () => {
      await pool.query("TRUNCATE sessions, opportunities, users CASCADE");
    });

    /**
     * Waits until SOME session is blocked on the opportunities row lock.
     *
     * BOUNDED AT 10s ON PURPOSE, matching the sibling lock-order file next
     * door: an unbounded concurrency barrier turns a broken fixture into a CI
     * job timeout with no failing test name, which is the hardest kind of
     * regression to read. Returns false and the caller fails BY NAME.
     *
     * Matched on `FROM opportunities WHERE id`, common to both the
     * ownership-check and the existing-row SELECT this handler issues - so
     * the barrier does not care which of the two is the one that blocks.
     */
    async function waitForABlockedOpportunitiesLock(): Promise<boolean> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock'
             AND query ILIKE '%FROM opportunities WHERE id%'`
        );
        if (rows[0].n >= 1) return true;
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    it("blocks a concurrent PATCH until the locking transaction commits, so the publish guard sees the FRESH status", async () => {
      const fixture = await seedDraftPoll();

      const locker = await pool.connect();
      let response: request.Response;
      let bothInFlight = false;

      try {
        await locker.query("BEGIN");
        // Simulates another admin's PATCH { status: 'published' } - already
        // past its own locked read, mid-transaction, not yet committed.
        await locker.query("SELECT id FROM opportunities WHERE id = $1 FOR UPDATE", [
          fixture.opportunityId,
        ]);

        // `.then()` rather than a bare supertest chain: a `Test` sends nothing
        // until something subscribes to it, so holding the unawaited object
        // would leave the handler unstarted and the barrier below would
        // simply time out.
        const pending = patchToInterview(fixture);

        bothInFlight = await waitForABlockedOpportunitiesLock();

        // Commits the state the blocked PATCH's publish guard must see:
        // published, with no bookable slot - the fresh truth the guard is
        // refusing against, once unblocked.
        await locker.query("UPDATE opportunities SET status = 'published' WHERE id = $1", [
          fixture.opportunityId,
        ]);
        await locker.query("COMMIT");

        response = await pending;
      } finally {
        locker.release();
      }

      // THE CONTROL, and it is not decoration. Every assertion below is about
      // what the SECOND transaction saw, and all of them would pass vacuously
      // if the two transactions never actually overlapped - because then
      // there was nothing for the lock to serialise.
      expect(bothInFlight).toBe(true);

      // THE GUARANTEE. Unlocked, this PATCH read `status: 'draft'` before the
      // locker's write landed, `willBePublished` was false, the publish guard
      // never ran, and the type flipped to `interview` on what became - the
      // instant the locker committed - a published interview with no
      // bookable slot. Locked, the SELECT blocks until the locker commits,
      // reads `status: 'published'` for real, and the guard refuses.
      expect(response.status).toBe(400);
      expect(response.body.error).toBe(SLOT_GATE_MESSAGE);

      // THE SECOND CONTROL. The refusal is real, not cosmetic: the row is
      // published (the locker's write) AND still a poll (this PATCH's
      // attempted type change never reached the database at all).
      const stored = await storedRow(fixture.opportunityId);
      expect(stored.status).toBe("published");
      expect(stored.type).toBe("poll");
    }, 60_000);

    it("can observe the row lock at all, so the test above is not vacuously green", async () => {
      // THE CONTROL ARM FOR THE WHOLE FILE. `bothInFlight` above passes just
      // as well against a barrier that can never detect a block - a typo in
      // the ILIKE pattern, a `pg_stat_activity` column that does not exist on
      // the server this suite happens to run against, a permissions gap that
      // makes the count silently read zero rows forever. This builds the same
      // block by hand, with two plain clients and no HTTP handler in the
      // loop, and proves the barrier sees it.
      const fixture = await seedDraftPoll();

      const first = await pool.connect();
      const second = await pool.connect();
      let secondSawTheRow: unknown[] = [];

      try {
        await first.query("BEGIN");
        await first.query("SELECT id FROM opportunities WHERE id = $1 FOR UPDATE", [
          fixture.opportunityId,
        ]);

        const blockedRead = second
          .query("SELECT id FROM opportunities WHERE id = $1 FOR UPDATE", [fixture.opportunityId])
          .then((result) => {
            secondSawTheRow = result.rows;
          });

        const detected = await waitForABlockedOpportunitiesLock();
        expect(detected).toBe(true);

        await first.query("COMMIT");
        await blockedRead;
      } finally {
        await second.query("ROLLBACK").catch(() => {});
        first.release();
        second.release();
      }

      // The second client's own SELECT ... FOR UPDATE only completes once it
      // is unblocked, so this is reachable at all only because the barrier's
      // "true" above was correct rather than a false positive.
      expect(secondSawTheRow).toHaveLength(1);
    }, 60_000);
  }
);
