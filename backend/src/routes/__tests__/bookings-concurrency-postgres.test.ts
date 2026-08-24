import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * THE DOUBLE-CANCEL RACE, AGAINST A REAL DATABASE.
 *
 * Two concurrent cancels of the SAME booking must decrement `booked_count`
 * exactly once. The guarantee is the conditional UPDATE in the cancel handler -
 *
 *     UPDATE bookings SET status = 'cancelled' ...
 *     WHERE id = $1 AND status = 'booked' RETURNING session_id
 *
 * - whose `AND status = 'booked'` is the whole lock: under READ COMMITTED the
 * loser of the row-write-lock race re-evaluates its WHERE against the winner's
 * committed row, matches zero rows, and skips the decrement. Delete that guard
 * and a single cancellation subtracts TWO (!232/#31).
 *
 * WHY THIS FILE EXISTS (#32). Jest owns `src/**\/__tests__/**\/*.test.ts` with a
 * MOCKED pool (jest.config.js), so it cannot execute a real transaction, take a
 * real row lock, or run two connections against one row - the race is
 * unobservable there. The bookings.*.test.ts suites next door assert the SQL
 * TEXT the handler sends; only a real Postgres proves that text actually
 * serialises. This is the first core-route real-PG test, homed under __tests__
 * with the `*-postgres.test.ts` suffix that jest.config.js ignores and
 * vitest.config.ts collects.
 *
 * RUNS IN CI, in `test-backend-db` (`npx vitest run postgres`), which supplies a
 * Postgres `services:` container via FIRSTHAND_TEST_DATABASE_URL. The no-DB
 * vitest job sets FIRSTHAND_SKIP_DB_TESTS=1 and this suite skips. Locally it
 * starts its own container (Docker) or uses FIRSTHAND_TEST_DATABASE_URL.
 *
 * The app pool (`../../config`) is a singleton built from the environment at
 * import time, so DATABASE_URL is set to the test database BEFORE the handler
 * is imported. Everything DB-facing is a dynamic import inside `beforeAll`, so
 * when the suite is skipped nothing touches a database or the config env.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

// The email and calendar services would otherwise attempt real network I/O
// after the transaction commits. The race lives entirely in the transaction;
// the notifications are not under test here, so they are stubbed to no-ops.
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

/** A participant booked into a session with room to spare. */
interface Fixture {
  participantId: string;
  bookingId: string;
  sessionId: string;
}

async function seedBookedSession(): Promise<Fixture> {
  const ownerId = crypto.randomUUID();
  const participantId = crypto.randomUUID();
  const opportunityId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();

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
     VALUES ($1, 'test', 'Concurrency test opportunity',
             'Proving the double-cancel guard against a real database', $2, 'published')`,
    [opportunityId, ownerId]
  );

  // capacity 2, booked_count 2: two participants hold this session. The CHECK
  // (booked_count <= capacity) forbids seeding a count above capacity, and the
  // point of the guarantee is that cancelling ONE of them leaves the other's
  // slot intact - booked_count 1, not 0.
  await pool.query(
    `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
     VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 1 hour', 2, 2)`,
    [sessionId, opportunityId]
  );

  const bookingId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO bookings (id, user_id, session_id, status) VALUES ($1, $2, $3, 'booked')`,
    [bookingId, participantId, sessionId]
  );
  // The second participant's booking, so booked_count = 2 is honest. It is
  // never cancelled here; its slot is exactly what must survive.
  const otherId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, name, email) VALUES ($1, 'Other', $2)`,
    [otherId, `other-${otherId}@example.com`]
  );
  await pool.query(
    `INSERT INTO bookings (id, user_id, session_id, status) VALUES ($1, $2, $3, 'booked')`,
    [crypto.randomUUID(), otherId, sessionId]
  );

  return { participantId, bookingId, sessionId };
}

describe.skipIf(skipDbTests)("core booking routes, double-cancel race against real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("bookings-concurrency");

    // BEFORE importing ../../config: the pool reads DATABASE_URL once, at
    // import. A separate name would not reach the app pool's resolver.
    process.env.DATABASE_URL = postgres.connectionString;
    // shared/config/environment.ts validates a >= 32 char session secret at
    // config import; this suite does not sign anything, so a fixed constant.
    process.env.SESSION_SECRET ||=
      "vitest-postgres-concurrency-constant-not-a-real-secret"; // gitleaks:allow
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
    // Stand in for the real session/auth middleware: requireAuth only needs
    // req.session.user. The header names which seeded user is acting.
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id");
      const role = req.header("x-test-user-role") ?? "employee";
      if (userId) {
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id: userId, name: "Test", email: "t@example.com", role },
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
    // FK-respecting order; TRUNCATE ... CASCADE resets everything the fixture
    // seeds so each test starts from an empty schema.
    await pool.query("TRUNCATE bookings, sessions, opportunities, users CASCADE");
  });

  /**
   * Waits until `expected` backends are blocked on a lock while running an
   * `UPDATE bookings`, i.e. both cancel handlers have passed the unlocked
   * pre-transaction status read and are now contending on the conditional
   * UPDATE - the statement under test. Returns false on timeout.
   *
   * This is the control that stops a false green. The handler has TWO layers:
   * an unlocked `if (status === 'cancelled')` fast path BEFORE the transaction,
   * and the `AND status = 'booked'` guard on the UPDATE inside it. Fired
   * naively, one request commits before the other's fast-path read, so the
   * fast path absorbs the second and the guard is never exercised - the
   * mutation that removes the guard then passes. Blocking both on a row lock
   * held by THIS test forces both past the fast path and onto the guard.
   */
  async function waitForBlockedUpdates(expected: number): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE '%UPDATE bookings%'`
      );
      if (rows[0].n >= expected) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("decrements booked_count exactly once when the same booking is cancelled twice concurrently", async () => {
    const { participantId, bookingId, sessionId } = await seedBookedSession();

    // Through the shared server (listening-call-sites.test.ts forbids a test
    // binding its own port per request). `listening(app)` is cached per app,
    // so calling it inline each time reuses the one server.
    const cancel = () =>
      request(listening(app))
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("x-test-user-id", participantId);

    // Hold the booking row locked, so both handlers block on their conditional
    // UPDATE after their fast-path read has already seen 'booked'. The row is
    // NOT modified here (plain FOR UPDATE), so both fast-path reads return
    // 'booked' and both proceed into the transaction.
    const locker = await pool.connect();
    let a: request.Response;
    let b: request.Response;
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [bookingId]);

      const pending = Promise.all([cancel(), cancel()]);

      // Both must be blocked on the guard before the lock is released. If they
      // are not, the race was never exercised and the test fails loudly rather
      // than passing on the fast path.
      const bothBlocked = await waitForBlockedUpdates(2);
      await locker.query("ROLLBACK");
      expect(bothBlocked).toBe(true);

      [a, b] = await pending;
    } finally {
      locker.release();
    }

    // Both requests succeed idempotently: the winner cancels, the loser gets
    // the "already cancelled" 200. Neither is a 500.
    expect([a.status, b.status].sort()).toEqual([200, 200]);

    // THE GUARANTEE. Two cancels of ONE booking may remove at most one slot.
    // With the `AND status = 'booked'` guard removed, both decrement and this
    // reads 0 - discarding the OTHER participant's slot. Measured: this
    // assertion fails by name under that mutation.
    const session = await pool.query(
      "SELECT booked_count FROM sessions WHERE id = $1",
      [sessionId]
    );
    expect(session.rows[0].booked_count).toBe(1);

    // The booking itself is cancelled exactly once.
    const booking = await pool.query(
      "SELECT status FROM bookings WHERE id = $1",
      [bookingId]
    );
    expect(booking.rows[0].status).toBe("cancelled");

    // CONTROL. The assertions above hold vacuously if the fixture seeded
    // nothing - an empty session table makes booked_count unreadable, and a
    // missing booking makes the status check throw rather than pass, but the
    // count assertion would read `undefined`. Pin that the OTHER booking is
    // still booked, so "1" means "one slot survived" rather than "the table
    // was empty".
    const stillBooked = await pool.query(
      "SELECT count(*)::int AS n FROM bookings WHERE session_id = $1 AND status = 'booked'",
      [sessionId]
    );
    expect(stillBooked.rows[0].n).toBe(1);
  }, 60_000);
});
