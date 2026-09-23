import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * THE RESCHEDULE <-> SYNC-BOOKED-COUNTS LOCK ORDER, AGAINST A REAL DATABASE.
 * cto/AdaptaLabs#34.
 *
 * `POST /api/sessions/sync-booked-counts` locks EVERY session row
 * (`SELECT id FROM sessions ORDER BY id FOR UPDATE`) before a set-based
 * recount. `POST /api/bookings/:id/reschedule` locks TWO session rows - the
 * target, then the booking's current session - in a different order, and used
 * to take the second of those with a plain (blocking) `FOR UPDATE`. Two
 * transactions taking shared rows in opposite orders, with at least one of
 * them WILLING TO WAIT, form a cycle Postgres breaks by killing one of them
 * with `40P01 deadlock detected`.
 *
 * `opportunities.delete-sessions-lock-order-postgres.test.ts` next door proves
 * the other leg of this triangle (delete-sessions' `ORDER BY id`, matching the
 * sweep's own ascending scan). This file proves reschedule's leg: reschedule's
 * SECOND session lock is `FOR UPDATE NOWAIT`, so reschedule can never HOLD one
 * session lock while WAITING on another - which is the one thing a party needs
 * to be able to do to sit in a wait-for cycle. A NOWAIT lock either succeeds
 * immediately or fails immediately (55P03, mapped to a retryable 409); either
 * way reschedule is back out of the lock graph within the same statement, so
 * it structurally cannot be the transaction a cycle waits on.
 *
 * HOW THE CYCLE IS FORCED, deterministically, following the pattern the
 * delete-sessions file established rather than racing two copies of a handler
 * and hoping: a locker connection stands in for the sweep, already holding the
 * booking's CURRENT session (the row reschedule locks second) before
 * reschedule starts. If reschedule's second lock ever blocks instead of
 * failing fast, `waitForTheOldSessionLockToBlock` below observes it within a
 * bounded window - the same named-failure discipline
 * `~/.claude/rules/common/testing.md` asks for ("a test must be able to fail
 * BY NAME"), rather than a hang with no failing test name.
 *
 * RUNS IN CI in `test-backend-db` and `mutation-canary`, both of which supply
 * FIRSTHAND_TEST_DATABASE_URL from a `services:` container - the arrangement
 * #32 established.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

/** Postgres's own code for "I broke a lock cycle by killing one of you". */
const DEADLOCK_DETECTED = "40P01";

// The email and calendar services would otherwise attempt real network I/O
// after the transaction commits. Neither is under test here.
vi.mock("../../services/email", () => ({
  __esModule: true,
  default: { sendEmail: vi.fn(async () => ({ success: true, messageId: "test" })) },
  EmailService: {
    getBookingCancellationTemplate: vi.fn(() => ({})),
    getBookingConfirmationTemplate: vi.fn(() => ({})),
    getAdminNotificationTemplate: vi.fn(() => ({})),
  },
}));

vi.mock("../../services/calendar", () => ({
  __esModule: true,
  default: {
    createEvent: vi.fn(async () => ({ success: true, eventId: "evt" })),
    updateEvent: vi.fn(async () => ({ success: true })),
    deleteEvent: vi.fn(async () => ({ success: true })),
  },
}));

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

interface Fixture {
  participantId: string;
  opportunityId: string;
  bookingId: string;
  /** The session the booking starts on - reschedule's SECOND lock. */
  oldSessionId: string;
  /** Where the booking is being moved to - reschedule's FIRST lock. */
  targetSessionId: string;
}

async function seedRescheduleFixture(): Promise<Fixture> {
  const ownerId = crypto.randomUUID();
  const participantId = crypto.randomUUID();
  const opportunityId = crypto.randomUUID();
  const oldSessionId = crypto.randomUUID();
  const targetSessionId = crypto.randomUUID();
  const bookingId = crypto.randomUUID();

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
     VALUES ($1, 'test', 'Reschedule lock-order opportunity',
             'Proving reschedule cannot deadlock against the sync-booked-counts sweep', $2, 'published')`,
    [opportunityId, ownerId]
  );

  for (const id of [oldSessionId, targetSessionId]) {
    await pool.query(
      `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
       VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 1 hour', 5, 0)`,
      [id, opportunityId]
    );
  }
  // The booking's session carries the one booked slot it is moving off.
  await pool.query(`UPDATE sessions SET booked_count = 1 WHERE id = $1`, [oldSessionId]);

  await pool.query(
    `INSERT INTO bookings (id, user_id, session_id, status) VALUES ($1, $2, $3, 'booked')`,
    [bookingId, participantId, oldSessionId]
  );

  return { participantId, opportunityId, bookingId, oldSessionId, targetSessionId };
}

describe.skipIf(skipDbTests)(
  "POST /bookings/:id/reschedule cannot deadlock against the sync-booked-counts sweep, against a real Postgres",
  () => {
    beforeAll(async () => {
      postgres = await startTestPostgres("reschedule-sync-lock-order");

      // BEFORE importing ../../config: the pool reads DATABASE_URL once, at
      // import, so a later assignment would not reach the app pool.
      process.env.DATABASE_URL = postgres.connectionString;
      // shared/config/environment.ts wants >= 32 characters at config import.
      // Nothing here signs anything, so a fixed constant.
      process.env.SESSION_SECRET ||=
        "vitest-postgres-reschedule-lock-order-constant-not-a-secret"; // gitleaks:allow
      process.env.NODE_ENV = "test";

      const { runMigrations } = await import("../../db/migrate");
      await runMigrations();

      const { pool: appPool } = await import("../../config");
      pool = appPool;

      const bookingsRouter = (await import("../bookings")).default;
      const { errorHandler } = await import("../../utils/errorHandler");
      const expressModule = (await import("express")).default;

      app = expressModule();
      app.use(expressModule.json());
      // Stands in for the real session middleware, matching the pattern in
      // bookings-concurrency-postgres.test.ts next door.
      app.use((req, _res, next) => {
        const userId = req.header("x-test-user-id");
        const role = req.header("x-test-user-role") ?? "employee";
        if (userId) {
          (req as unknown as { session: { user: unknown } }).session = {
            user: { id: userId, name: "Test Participant", email: "t@example.com", role },
          };
        }
        next();
      });
      app.use("/api/bookings", bookingsRouter);
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
     * Waits until the given connection's own in-flight `FOR UPDATE` on the old
     * session is genuinely BLOCKED (waiting on a lock), as opposed to having
     * already succeeded or failed fast. Bounded at 3s - reschedule's NOWAIT
     * lock resolves in milliseconds either way, so 3s is generous headroom for
     * "did it ever block" while staying far short of a suite-hanging wait. A
     * timeout here means "never observed blocking", not an error - the caller
     * decides what that means for the assertion under test.
     */
    async function observeBlockedOldSessionLock(): Promise<boolean> {
      const deadline = Date.now() + 3_000;
      for (;;) {
        // `datname = current_database()` is load-bearing, not decoration.
        // startTestPostgres gives every test FILE its own database on a
        // SHARED server (postgres-instance.ts), and pg_stat_activity is
        // server-wide, not database-scoped - so an unqualified ILIKE here
        // matches a same-shaped blocked query in a completely different,
        // concurrently-running test file's database. Measured: this exact
        // query without the datname filter flaked under the full `vitest run
        // postgres` suite (35 files in parallel) while passing every time in
        // isolation - another postgres test's session row lock satisfied the
        // ILIKE and reported a block that never happened in THIS database.
        const { rows } = await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query ILIKE '%FROM sessions WHERE id = $1 FOR UPDATE%'`
        );
        if (rows[0].n >= 1) return true;
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    it("never blocks holding the target lock while waiting on the old session, so a sweep holding that row cannot cycle with it", async () => {
      const { participantId, bookingId, oldSessionId, targetSessionId } =
        await seedRescheduleFixture();

      // Stands in for the sync-booked-counts sweep already holding this
      // session's row lock partway through its ascending scan - the exact
      // moment a real sweep could be at when reschedule starts.
      const locker = await pool.connect();
      let response: request.Response;
      let wasBlocked = false;
      let deadlockOnLockerSide: string | null = null;

      try {
        await locker.query("BEGIN");
        await locker.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [oldSessionId]);

        // `.then()` rather than a bare supertest chain: a `Test` sends nothing
        // until something subscribes to it.
        const pending = request(listening(app))
          .post(`/api/bookings/${bookingId}/reschedule`)
          .set("x-test-user-id", participantId)
          .send({ target_session_id: targetSessionId })
          .then((sent) => sent);

        // THE PROPERTY UNDER TEST. Correct (NOWAIT): this returns false almost
        // immediately, because reschedule's lock on oldSessionId either takes
        // it (impossible here, the locker holds it) or fails fast with 55P03 -
        // it is never seen WAITING. Reverted to a plain `FOR UPDATE`: reschedule
        // blocks on this exact row, and this returns true within the window.
        wasBlocked = await observeBlockedOldSessionLock();

        // Second half of the cycle: the locker now asks for the TARGET
        // session too, exactly as the sweep's ascending scan would reach it
        // next. Correct: reschedule already failed fast and released the
        // target, so this succeeds immediately - no cycle. Reverted: reschedule
        // is blocked HOLDING the target while waiting on the old session, and
        // the locker is now blocked holding the old session while waiting on
        // the target - the cycle - and Postgres's own deadlock detector
        // (default 1s) resolves it by killing one side, bounding this call
        // without any artificial timeout.
        try {
          await locker.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [targetSessionId]);
        } catch (error) {
          deadlockOnLockerSide = (error as { code?: string }).code ?? "unknown";
        }

        await locker.query(deadlockOnLockerSide ? "ROLLBACK" : "COMMIT");
        response = await pending;
      } finally {
        locker.release();
      }

      // THE GUARANTEE. Reschedule's second lock is NOWAIT, so it is never
      // caught mid-wait - this is what makes the cycle structurally
      // impossible, not merely untriggered in this run.
      expect(wasBlocked).toBe(false);
      expect(deadlockOnLockerSide).toBe(null);
      expect(deadlockOnLockerSide).not.toBe(DEADLOCK_DETECTED);

      // The old session was genuinely held by the locker for the whole
      // request, so reschedule's NOWAIT lock on it fails every time - a clean,
      // retryable 409, never an unhandled 500 and never a hang.
      expect(response.status).toBe(409);

      // THE CONTROL. The assertions above are all absences (no block, no
      // deadlock) and would pass just as well if the request never reached its
      // locking statement at all. Confirm the booking really was left alone.
      const booking = await pool.query(
        "SELECT session_id, status FROM bookings WHERE id = $1",
        [bookingId]
      );
      expect(booking.rows[0]).toEqual({ session_id: oldSessionId, status: "booked" });

      const sessions = await pool.query(
        "SELECT id, booked_count FROM sessions WHERE id = ANY($1) ORDER BY id",
        [[oldSessionId, targetSessionId]]
      );
      const byId = Object.fromEntries(sessions.rows.map((row) => [row.id, row.booked_count]));
      expect(byId[oldSessionId]).toBe(1);
      expect(byId[targetSessionId]).toBe(0);
    }, 60_000);

    it("can observe a deadlock at all in this fixture, so the guarantee above is not vacuously green", async () => {
      // THE CONTROL ARM FOR THE WHOLE FILE, mirroring
      // opportunities.delete-sessions-lock-order-postgres.test.ts's own control.
      // `expect(wasBlocked).toBe(false)` above passes just as well against a
      // fixture that can never observe blocking at all - a wrong SQLSTATE, a
      // pool that reconnects underneath, a query text that no longer matches
      // the ILIKE filter. This builds the cycle by hand out of the same two
      // rows with plain (blocking) FOR UPDATE on both sides and proves 40P01
      // arrives and is recognised.
      const { oldSessionId, targetSessionId } = await seedRescheduleFixture();

      const first = await pool.connect();
      const second = await pool.connect();
      let code: string | null = null;

      try {
        await first.query("BEGIN");
        await second.query("BEGIN");
        await first.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [targetSessionId]);
        await second.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [oldSessionId]);

        // Each now wants what the other holds. One of the two is killed.
        const outcomes = await Promise.allSettled([
          first.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [oldSessionId]),
          second.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [targetSessionId]),
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
