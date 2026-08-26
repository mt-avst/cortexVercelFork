import crypto from "node:crypto";

import type express from "express";
// A VALUE import, not `import type`: the verification helpers below construct
// their own pg.Client so they never read through the pool under test.
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * POST /api/sessions IS ALL-OR-NOTHING, AGAINST A REAL DATABASE (#42).
 *
 * The property: a batch that fails at element k leaves ZERO rows, not k.
 *
 * WHY THIS CANNOT BE A MOCK TEST. Jest owns `src/**\/__tests__/**\/*.test.ts`
 * with a MOCKED pool (jest.config.js), so `BEGIN` and `ROLLBACK` there are two
 * strings pushed onto a `jest.fn()`. Asserting the handler SENT them is not the
 * same as asserting the rows went away, and a mock happily "rolls back" writes
 * that never existed. Only a real transaction boundary can demonstrate that the
 * rows before the failure are gone. Hence the `-postgres.test.ts` suffix, which
 * jest.config.js ignores and vitest.config.ts collects, run in CI by
 * `test-backend-db` against a Postgres `services:` container.
 *
 * HOW ELEMENT k IS MADE TO FAIL. A NUL character in
 * `location_or_meet_link_optional`. It is a genuine end-to-end failure and not
 * a fault injected into the handler:
 *
 *   - it passes every application check. `validateSessionData` delegates the
 *     field to `isSafeMeetingLocation`, which calls `new URL(raw)`, catches the
 *     throw and returns true - "not a URL at all, which is the common case";
 *   - Postgres then refuses the INSERT server-side with SQLSTATE 22021,
 *     `invalid byte sequence for encoding "UTF8": 0x00`. Measured against
 *     postgres:17 before this test was written.
 *
 * So it reproduces exactly the shape #42 names: an error that no amount of
 * up-front validation catches, arriving after earlier elements have been
 * written. A real user hits the same door by pasting a string out of a document
 * that carries a stray NUL.
 *
 * The app pool (`../../config`) is a singleton built from the environment at
 * import time, so DATABASE_URL is set to the test database BEFORE the handler is
 * imported. Everything DB-facing is a dynamic import inside `beforeAll`, so when
 * the suite is skipped nothing touches a database or the config env.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

/**
 * The NUL is built at runtime rather than written as a literal: a raw control
 * character in a source file is invisible in review and does not survive every
 * editor. `\0` in a template would also work; this says out loud what it is.
 */
const NUL = String.fromCharCode(0);

// autoCloseOpportunityIfNeeded runs after the batch commits and is not under
// test here; the email service it can reach would attempt real network I/O.
vi.mock("../../services/email", () => ({
  __esModule: true,
  default: { sendEmail: vi.fn(async () => ({ success: true, messageId: "test" })) },
  EmailService: {
    getBookingCancellationTemplate: vi.fn(() => ({})),
    getBookingConfirmationTemplate: vi.fn(() => ({})),
    getAdminNotificationTemplate: vi.fn(() => ({})),
  },
}));

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

interface Fixture {
  ownerId: string;
  opportunityId: string;
}

async function seedOwnedOpportunity(): Promise<Fixture> {
  const ownerId = crypto.randomUUID();
  const opportunityId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', $2, 'researcher_admin')`,
    [ownerId, `owner-${ownerId}@example.com`]
  );
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
     VALUES ($1, 'interview', 'Batch atomicity opportunity',
             'Proving a failed session batch leaves no rows behind', $2, 'published')`,
    [opportunityId, ownerId]
  );

  return { ownerId, opportunityId };
}

/** Three consecutive, non-overlapping one-hour slots, k days out. */
function slot(dayOffset: number, location?: string) {
  return {
    start_time: new Date(Date.UTC(2030, 0, 1 + dayOffset, 9, 0, 0)).toISOString(),
    end_time: new Date(Date.UTC(2030, 0, 1 + dayOffset, 10, 0, 0)).toISOString(),
    capacity: 1,
    ...(location === undefined ? {} : { location_or_meet_link_optional: location }),
  };
}

/**
 * Counts committed rows on a connection THIS SUITE OWNS, never the app pool.
 *
 * READ THIS BEFORE CHANGING IT BACK. It used `pool.query`, and that made the
 * COMMIT control unable to see a missing COMMIT - the defect it is named for.
 *
 * pg hands out the most recently released connection first. The handler
 * releases its client the instant the request finishes, so the very next
 * `pool.query` is handed THE SAME CONNECTION - and with the COMMIT deleted that
 * connection is still inside the open transaction. The count then reads the
 * transaction's OWN uncommitted rows and reports 3, so
 * "CONTROL: the same batch with no failing element commits all three rows"
 * passed with no COMMIT anywhere. Measured, with `await client.query('COMMIT')`
 * commented out: that arm and the overlap arm both passed in isolation, and the
 * full file only went red on a LATER arm with "expected +0 to be 1" - a message
 * about a surviving pre-existing row that says nothing about COMMIT, and which
 * disappears if the arms are reordered.
 *
 * A separate connection cannot see another transaction's uncommitted rows under
 * any isolation level, so this reads what actually committed. It does not block
 * either: MVCC readers do not wait on writers, so a stuck transaction shows up
 * as a wrong count rather than as a hung suite.
 */
async function sessionCount(opportunityId: string): Promise<number> {
  const verifier = new pg.Client({ connectionString: postgres.connectionString });
  await verifier.connect();
  try {
    const { rows } = await verifier.query(
      "SELECT count(*)::int AS n FROM sessions WHERE opportunity_id = $1",
      [opportunityId]
    );
    return rows[0].n;
  } finally {
    await verifier.end().catch(() => {});
  }
}

/**
 * How many backends are sitting in an open transaction, seen from outside.
 *
 * The second, independent detector for a missing COMMIT: the row count says the
 * data was not persisted, this says the connection went back to the pool still
 * holding a transaction open. Both are real harms and only one of them is about
 * rows, so neither alone covers it.
 */
async function idleInTransactionCount(): Promise<number> {
  const verifier = new pg.Client({ connectionString: postgres.connectionString });
  await verifier.connect();
  try {
    const { rows } = await verifier.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE state = 'idle in transaction' AND pid <> pg_backend_pid()
         AND datname = current_database()`
    );
    return rows[0].n;
  } finally {
    await verifier.end().catch(() => {});
  }
}

describe.skipIf(skipDbTests)("POST /api/sessions batch atomicity against real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("sessions-batch-atomicity");

    // BEFORE importing ../../config: the pool reads DATABASE_URL once, at import.
    process.env.DATABASE_URL = postgres.connectionString;
    // shared/config/environment.ts validates a >= 32 char session secret at
    // config import; this suite signs nothing, so a fixed constant.
    process.env.SESSION_SECRET ||=
      "vitest-postgres-batch-atomicity-constant-not-a-real-secret"; // gitleaks:allow
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
    // Stand in for the real session/auth middleware: requireAdmin only needs
    // req.session.user. The header names which seeded user is acting.
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id");
      const role = req.header("x-test-user-role") ?? "researcher_admin";
      if (userId) {
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id: userId, name: "Test", email: "t@example.com", role },
        };
      }
      next();
    });
    app.use("/api/sessions", sessionsRouter);
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

  // `object` rather than `unknown`: supertest's .send() takes `string | object`,
  // and every body here is a batch payload. Typed `unknown` this does not
  // compile, which the CI typecheck job caught and the local one in a symlinked
  // worktree can hide behind its two pre-existing TS2742 errors.
  const post = (ownerId: string, body: object) =>
    request(listening(app))
      .post("/api/sessions")
      .set("x-test-user-id", ownerId)
      .send(body);

  it("leaves zero sessions when the third element of a three-element batch fails", async () => {
    const { ownerId, opportunityId } = await seedOwnedOpportunity();

    const response = await post(ownerId, {
      opportunity_id: opportunityId,
      sessions: [slot(0, "Room 1"), slot(1, "Room 2"), slot(2, `Room 3${NUL}`)],
    });

    // CONTROL ON THE FAILURE ITSELF. If the batch somehow succeeded, the
    // zero-rows assertion below would be a lie about a route that never ran the
    // failing path. This arm proves element 3 genuinely blew up.
    expect(response.status).not.toBe(201);
    expect(response.status).toBeGreaterThanOrEqual(400);

    // THE GUARANTEE. Before the fix this read 2: elements 1 and 2 were committed
    // by their own pool.query calls before element 3 reached the server.
    // Measured on 150911d - the same request left 2 rows and answered 500.
    expect(await sessionCount(opportunityId)).toBe(0);
  }, 60_000);

  it("leaves zero sessions when the FIRST element of the batch fails", async () => {
    const { ownerId, opportunityId } = await seedOwnedOpportunity();

    // The k=0 arm. It passes on the broken route too - nothing was committed
    // before the failure - which is exactly why it is here: it pins that the
    // fix did not merely move the failure earlier, and it fails by name if the
    // handler starts swallowing the error and answering 201.
    const response = await post(ownerId, {
      opportunity_id: opportunityId,
      sessions: [slot(0, `Room 1${NUL}`), slot(1, "Room 2")],
    });

    expect(response.status).not.toBe(201);
    expect(await sessionCount(opportunityId)).toBe(0);
  }, 60_000);

  it("CONTROL: the same batch with no failing element commits all three rows", async () => {
    const { ownerId, opportunityId } = await seedOwnedOpportunity();

    // Without this arm, "zero rows after a failure" passes just as well against
    // a route that inserts nothing at all, or against a COMMIT deleted from the
    // handler.
    //
    // It only earns that second claim because sessionCount() reads on its own
    // connection - see its docblock. Through the app pool this arm passed with
    // the COMMIT removed, which is the exact "a claim about how well the code
    // was checked" defect this repo keeps finding. Re-measured after the fix:
    // with `await client.query('COMMIT')` commented out this fails by name with
    // "expected +0 to be 3".
    const response = await post(ownerId, {
      opportunity_id: opportunityId,
      sessions: [slot(0, "Room 1"), slot(1, "Room 2"), slot(2, "Room 3")],
    });

    expect(response.status).toBe(201);
    expect(response.body).toHaveLength(3);
    expect(await sessionCount(opportunityId)).toBe(3);
  }, 60_000);

  it("leaves no connection idle in transaction after a successful batch", async () => {
    const { ownerId, opportunityId } = await seedOwnedOpportunity();

    // The other half of what a missing COMMIT costs. Even if every row somehow
    // landed, a client released mid-transaction goes back into the pool holding
    // locks and an open snapshot - it blocks the next writer and pins the xmin
    // horizon. Counted from outside, so it sees the app pool's backends rather
    // than its own.
    //
    // Measured with the COMMIT removed: 1, and this fails by name. It is a
    // second, independent detector - it does not read rows at all, so it stays
    // honest even if the count assertions were ever weakened.
    await post(ownerId, {
      opportunity_id: opportunityId,
      sessions: [slot(0), slot(1)],
    });

    expect(await idleInTransactionCount()).toBe(0);
  }, 60_000);

  it("CONTROL: an overlap against an already-committed session still rolls the batch back", async () => {
    const { ownerId, opportunityId } = await seedOwnedOpportunity();

    // A pre-existing slot on day 2, so element 3 of the batch conflicts with a
    // row that was committed by an earlier request rather than by this one.
    await pool.query(
      `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity)
       VALUES ($1, $2, $3, $4, 1)`,
      [crypto.randomUUID(), opportunityId, slot(2).start_time, slot(2).end_time]
    );

    const response = await post(ownerId, {
      opportunity_id: opportunityId,
      sessions: [slot(0), slot(1), slot(2)],
    });

    expect(response.status).toBe(409);
    // The pre-existing row survives and nothing was added beside it.
    expect(await sessionCount(opportunityId)).toBe(1);
  }, 60_000);

  it("refuses a batch whose own slots overlap each other, and writes nothing", async () => {
    const { ownerId, opportunityId } = await seedOwnedOpportunity();

    // THE INTERLEAVE, PINNED. Running the checks as one phase and the inserts as
    // another - even inside one transaction - would accept this and commit both
    // rows, because neither check can see a row the batch has not inserted yet.
    // Element 2's check runs on the transaction's own client AFTER element 1's
    // insert, so it sees it. The sibling route
    // POST /api/opportunities/:id/sessions already refuses this shape.
    //
    // This is the arm that fails by name if the loops are ever split back apart.
    const duplicate = slot(0);
    const response = await post(ownerId, {
      opportunity_id: opportunityId,
      sessions: [duplicate, { ...duplicate }],
    });

    expect(response.status).toBe(409);
    expect(await sessionCount(opportunityId)).toBe(0);
  }, 60_000);
});
