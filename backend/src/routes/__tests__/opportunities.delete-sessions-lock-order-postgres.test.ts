import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * THE LOCK ORDER IN `DELETE /opportunities/:id/sessions`, AGAINST A REAL DATABASE.
 *
 *     SELECT id FROM sessions WHERE opportunity_id = $1 ORDER BY id FOR UPDATE
 *
 * has TWO separate properties and they fail in different ways. `FOR UPDATE`
 * closes a TOCTOU: without it the has-bookings? guard reads a row somebody else
 * is about to change. `ORDER BY id` closes a DEADLOCK: this statement and the
 * sync-booked-counts sweep both lock many session rows, and two transactions
 * taking shared rows in opposite orders form a cycle Postgres breaks by killing
 * one of them with `40P01 deadlock detected` (cto/AdaptaLabs#34).
 *
 * WHY THIS FILE EXISTS (cto/AdaptaLabs#52). Both properties were pinned by ONE
 * test, `wraps the deletes in a single committed transaction` in
 * opportunities.delete-sessions-is-scoped.test.ts, and both canary entries named
 * it. That test does NOT assert the SQL text: it asserts two independent
 * SUBSTRINGS, one of them a dedicated `ORDER BY id` assertion. So
 * `ORDER BY id` -> `ORDER BY id DESC` reintroduces the deadlock and STILL
 * CONTAINS THE SUBSTRING - it passes the old jest test and fails this one by
 * name. That is the hole this file closes, and it is why the second entry's id
 * claimed to pin ordering while pinning only the presence of a string.
 *
 * Ordering can only be pinned under genuine concurrency, so this is a real
 * Postgres test, homed under __tests__ with the `*-postgres.test.ts` suffix that
 * jest.config.js ignores and vitest.config.ts collects - the arrangement #32
 * established for `bookings-concurrency-postgres.test.ts` next door. It runs in
 * CI in `test-backend-db`, and in the `mutation-canary` job, both of which
 * supply FIRSTHAND_TEST_DATABASE_URL from a `services:` container.
 *
 * HOW THE CYCLE IS FORCED, deterministically rather than by racing two copies of
 * the handler and hoping. Two sessions are inserted in DESCENDING id order, so
 * the heap order a scan follows is the REVERSE of id order:
 *
 *   this test         BEGIN, lock the LOW id, hold it
 *   the handler       locks in plan order, then blocks
 *                       with ORDER BY:  low first  -> blocked holding NOTHING
 *                       without it:     high first -> blocked holding the HIGH id
 *   this test         now asks for the HIGH id
 *                       with ORDER BY:  free, taken, no cycle
 *                       without it:     held by the handler, which is waiting on
 *                                       this transaction -> 40P01
 *
 * Either party can be Postgres's victim, so both outcomes are asserted: no
 * `40P01` reaches this test, AND the request still succeeds. Under the mutation
 * exactly one of those two fails, depending on which backend was chosen.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

/** Postgres's own code for "I broke a lock cycle by killing one of you". */
const DEADLOCK_DETECTED = "40P01";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

interface Fixture {
  ownerId: string;
  opportunityId: string;
  /** The lower of the two session ids by uuid ordering, inserted SECOND. */
  lowId: string;
  /** The higher of the two, inserted FIRST, so heap order opposes id order. */
  highId: string;
}

async function seedTwoSessions(): Promise<Fixture> {
  const ownerId = crypto.randomUUID();
  const opportunityId = crypto.randomUUID();

  // Sorted, then inserted in reverse. Comparing the uuids rather than assuming
  // `randomUUID` returns them in any order - it does not.
  const [lowId, highId] = [crypto.randomUUID(), crypto.randomUUID()].sort();

  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', $2, 'researcher_admin')`,
    [ownerId, `owner-${ownerId}@example.com`]
  );
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
     VALUES ($1, 'test', 'Lock order test opportunity',
             'Proving the delete takes its row locks in id order', $2, 'published')`,
    [opportunityId, ownerId]
  );

  // THE HIGH ID FIRST. This is the whole fixture: a scan with no ORDER BY
  // follows the heap, so the handler's unordered plan reaches the high id
  // first and the ordered one reaches the low id first. Insert them the other
  // way round and both plans agree, and the mutation survives.
  for (const id of [highId, lowId]) {
    await pool.query(
      `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
       VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 1 hour', 5, 0)`,
      [id, opportunityId]
    );
  }

  return { ownerId, opportunityId, lowId, highId };
}

describe.skipIf(skipDbTests)(
  "DELETE /opportunities/:id/sessions takes its row locks in id order, against a real Postgres",
  () => {
    beforeAll(async () => {
      postgres = await startTestPostgres("opportunities-lock-order");

      // BEFORE importing ../../config: the pool reads DATABASE_URL once, at
      // import, so a later assignment would not reach the app pool.
      process.env.DATABASE_URL = postgres.connectionString;
      // shared/config/environment.ts wants >= 32 characters at config import.
      // Nothing here signs anything, so a fixed constant.
      process.env.SESSION_SECRET ||=
        "vitest-postgres-lock-order-constant-not-a-real-secret"; // gitleaks:allow
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
      // what decides the gate - which is why the owner is seeded as a
      // researcher_admin rather than asserted to be one here.
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
      // The jest global teardown that normally closes these does not run under
      // vitest, so close here or the open server holds the process open.
      await closeListeningServers();
      await pool?.end().catch(() => {});
      await postgres?.stop();
      delete process.env.DATABASE_URL;
    });

    beforeEach(async () => {
      await pool.query("TRUNCATE bookings, sessions, opportunities, users CASCADE");
    });

    /**
     * Waits until the handler's locking SELECT is blocked on a row lock.
     *
     * BOUNDED AT 10s ON PURPOSE, the same bound as the double-cancel race next
     * door: an unbounded concurrency barrier turns a broken fixture into a CI
     * job timeout with no failing test name, which is the hardest kind of
     * regression to read. Returns false and the caller fails BY NAME.
     *
     * Matched on `FROM sessions WHERE opportunity_id`, which is common to both
     * the ordered statement and the mutated one - so the barrier itself cannot
     * be what tells the two arms apart.
     */
    async function waitForTheHandlerToBlock(): Promise<boolean> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock'
             AND query ILIKE '%FROM sessions WHERE opportunity_id%'`
        );
        if (rows[0].n >= 1) return true;
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    it("locks the sessions in id order, so a transaction holding them in the other order cannot deadlock", async () => {
      const { ownerId, opportunityId, lowId, highId } = await seedTwoSessions();

      const locker = await pool.connect();
      let response: request.Response;
      let deadlock: string | null = null;
      let bothInFlight = false;

      try {
        await locker.query("BEGIN");
        // The LOW id, held. The ordered plan wants this one first and gets
        // nothing else; the unordered plan takes the high id on the way here.
        await locker.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [lowId]);

        // `.then()` rather than a bare supertest chain: a `Test` does not send
        // anything until something subscribes to it, so holding the unawaited
        // object would leave the handler unstarted and the barrier below would
        // simply time out.
        const pending = request(listening(app))
          .delete(`/api/opportunities/${opportunityId}/sessions`)
          .set("x-test-user-id", ownerId)
          .then((sent) => sent);

        bothInFlight = await waitForTheHandlerToBlock();

        // THE SECOND HALF OF THE CYCLE. Free under the correct statement,
        // held by the blocked handler under the mutated one.
        try {
          await locker.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [highId]);
        } catch (error) {
          deadlock = (error as { code?: string }).code ?? "unknown";
        }

        await locker.query(deadlock ? "ROLLBACK" : "COMMIT");
        response = await pending;
      } finally {
        locker.release();
      }

      // THE CONTROL, and it is not decoration. Every assertion below is an
      // absence - no deadlock, no 500 - and all of them pass vacuously if the
      // handler never reached its locking SELECT at all, because then the two
      // transactions never overlapped and there was nothing to deadlock.
      expect(bothInFlight).toBe(true);

      // THE GUARANTEE. Ordered, the handler holds nothing while it waits, so no
      // cycle can form. Unordered, it holds the high id while waiting for the
      // low one and this call is 40P01 - unless Postgres picked the handler as
      // its victim instead, which the status assertion below catches.
      expect(deadlock).toBe(null);
      expect(deadlock).not.toBe(DEADLOCK_DETECTED);

      expect(response.status).toBe(200);
      expect(response.body.deleted_count).toBe(2);

      // THE SECOND CONTROL. `deleted_count: 2` is read from the handler's own
      // answer, so ask the database as well: two rows really were there and
      // really are gone. An empty fixture would otherwise satisfy "no deadlock"
      // perfectly.
      const left = await pool.query(
        "SELECT count(*)::int AS n FROM sessions WHERE opportunity_id = $1",
        [opportunityId]
      );
      expect(left.rows[0].n).toBe(0);
    }, 60_000);

    it("can observe a deadlock at all, so the test above is not vacuously green", async () => {
      // THE CONTROL ARM FOR THE WHOLE FILE. `expect(deadlock).toBe(null)` above
      // passes just as well against a fixture that can never produce one - a
      // wrong SQLSTATE, a swallowed error, a pool that reconnects underneath.
      // This builds the cycle by hand out of the same pieces and proves 40P01
      // arrives and is recognised.
      const { lowId, highId } = await seedTwoSessions();

      const first = await pool.connect();
      const second = await pool.connect();
      let code: string | null = null;

      try {
        await first.query("BEGIN");
        await second.query("BEGIN");
        await first.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [lowId]);
        await second.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [highId]);

        // Each now wants what the other holds. One of the two is killed.
        const outcomes = await Promise.allSettled([
          first.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [highId]),
          second.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [lowId]),
        ]);

        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            code = (outcome.reason as { code?: string }).code ?? "unknown";
          }
        }

        await first.query("ROLLBACK").catch(() => {});
        await second.query("ROLLBACK").catch(() => {});
      } finally {
        first.release();
        second.release();
      }

      expect(code).toBe(DEADLOCK_DETECTED);
    }, 60_000);
  }
);
