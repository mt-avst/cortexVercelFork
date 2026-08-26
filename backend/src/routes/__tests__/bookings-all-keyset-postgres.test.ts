import crypto from "node:crypto";

import type express from "express";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * THE CURSOR WALK ON `GET /api/bookings/my/bookings/all`, AGAINST A REAL
 * DATABASE. cto/AdaptaLabs#66.
 *
 * WHY IT CANNOT LIVE NEXT DOOR. Jest owns `src/**\/__tests__/**\/*.test.ts`
 * with a MOCKED pool (jest.config.js), so bookings.all-is-paged.test.ts can
 * only assert the statement's TEXT and the arithmetic around it. Every property
 * that matters here is evaluated by Postgres and by nothing else:
 *
 *   - whether `(b.created_at, b.id) < ($3, $4)` with `ORDER BY b.created_at
 *     DESC, b.id DESC` actually walks a history without dropping or repeating a
 *     row;
 *   - whether the `b.id` TIEBREAK does anything, which is only observable when
 *     two rows share a `created_at` AND a page boundary falls between them;
 *   - whether the cursor `to_char` emits survives being parsed back by
 *     `$3::timestamptz`, to the microsecond.
 *
 * A mocked pool returns whatever it was told to, so all three would pass
 * against a route that paged by luck.
 *
 * THE SESSION TimeZone IS DELIBERATELY NOT UTC, and that is load-bearing rather
 * than exotic. `to_char` renders a TIMESTAMPTZ in the SESSION's zone, so
 * without the `AT TIME ZONE 'UTC'` in the query the cursor is a wall-clock
 * reading in whatever zone the connection carries, labelled `Z` regardless, and
 * `$3::timestamptz` then reads that `Z` as UTC. Under UTC - which is every
 * container this repository starts, and CI - the round trip closes by
 * coincidence and nothing notices. Under Pacific/Kiritimati (+14) the cursor is
 * fourteen hours ahead of the row it describes and paging repeats the first
 * page for ever, so the walk below is what makes that conversion killable. The
 * zone is set on the DATABASE before the app pool's connections exist, because
 * the route uses the pool singleton and cannot be handed one of its own.
 *
 * RUNS IN CI, in `test-backend-db` (`vitest run postgres`), which supplies a
 * Postgres `services:` container via FIRSTHAND_TEST_DATABASE_URL. The no-DB
 * vitest job sets FIRSTHAND_SKIP_DB_TESTS=1 and this suite skips.
 *
 * EVERY LOOP HERE IS BOUNDED. A page cursor that stops advancing is the natural
 * failure of this feature, and an unbounded `while (has_more)` turns it into a
 * hung runner - a CI timeout with no test name attached, which is the hardest
 * kind of regression to read. The walk stops at `MAX_PAGES` and asserts.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

/** +14, the extreme that turned paging into an infinite repeat on #47's gate. */
const SESSION_TIME_ZONE = "Pacific/Kiritimati";

/**
 * More than one page and not a whole multiple of one, so the walk covers a
 * first page, a MIDDLE page and a short last page. 205 against a page size of
 * 100 gives 100 + 100 + 5.
 */
const SEEDED = 205;

/** The tie is placed exactly on the first page boundary: positions 100 and 101. */
const TIED_POSITION = 100;

/** A stuck cursor fails by name here instead of hanging the runner. */
const MAX_PAGES = 10;

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

interface Page {
  bookings: { id: string; created_at: string }[];
  has_more: boolean;
  next_before: string | null;
}

/** A participant, an opportunity and one session for their bookings to hang off. */
async function seedParticipantWithSession(): Promise<{ participantId: string; sessionId: string }> {
  const ownerId = crypto.randomUUID();
  const participantId = crypto.randomUUID();
  const opportunityId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', $2, 'researcher_admin')`,
    [ownerId, `owner-${ownerId}@example.com`]
  );
  await pool.query(`INSERT INTO users (id, name, email) VALUES ($1, 'Participant', $2)`, [
    participantId,
    `participant-${participantId}@example.com`,
  ]);
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
     VALUES ($1, 'test', 'Keyset paging test opportunity',
             'Proving the booking history pages without dropping a row', $2, 'published')`,
    [opportunityId, ownerId]
  );
  await pool.query(
    `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
     VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 1 hour', 1, 0)`,
    [sessionId, opportunityId]
  );

  return { participantId, sessionId };
}

/**
 * `count` CANCELLED bookings, one second apart, newest first.
 *
 * Cancelled rather than booked because `unique_user_session_booking_active` is
 * a partial unique index on `(user_id, session_id) WHERE status = 'booked'`, so
 * one session can hold any number of cancelled bookings for one user and only
 * one active one. That is not a workaround: cancelled rows are exactly what
 * this route exists to show and exactly what makes its row count grow for ever.
 */
async function seedBookings(participantId: string, sessionId: string, count: number) {
  await pool.query(
    `INSERT INTO bookings (id, user_id, session_id, status, created_at)
     SELECT gen_random_uuid(), $1, $2, 'cancelled',
            TIMESTAMPTZ '2026-01-01 09:00:00.123456+00' - (i || ' seconds')::interval
     FROM generate_series(1, $3::int) AS i`,
    [participantId, sessionId, count]
  );
}

/**
 * Collapses the row at `position + 1` onto the `created_at` of the row at
 * `position`, counting from the newest, and returns the two ids now sharing it.
 *
 * WITHOUT THIS THE `id` TIEBREAK IS DECORATION. Seeded one second apart, every
 * `created_at` is distinct and `(created_at, id) < (...)` behaves identically to
 * `created_at < ...` - so the mutation that drops the tiebreak passes a walk
 * over distinct timestamps. The tie has to land ON a page boundary, which is
 * why the position is a parameter rather than "somewhere in the middle".
 */
async function tieTwoBookingsAcrossPosition(participantId: string, position: number) {
  const keep = `TIMESTAMPTZ '2026-01-01 09:00:00.123456+00' - ($2 || ' seconds')::interval`;
  const collapse = `TIMESTAMPTZ '2026-01-01 09:00:00.123456+00' - ($3 || ' seconds')::interval`;

  const updated = await pool.query(
    `UPDATE bookings SET created_at = ${keep}
     WHERE user_id = $1 AND created_at = ${collapse}
     RETURNING id`,
    [participantId, String(position), String(position + 1)]
  );
  // The fixture's own control: exactly one row moved, so the tie is a tie of
  // two and not of one or three.
  expect(updated.rows).toHaveLength(1);

  const tied = await pool.query(
    `SELECT id FROM bookings WHERE user_id = $1 AND created_at = ${keep} ORDER BY id`,
    [participantId, String(position)]
  );
  expect(tied.rows).toHaveLength(2);

  return tied.rows.map((r: { id: string }) => r.id) as string[];
}

/** Pages through the whole history with the cursor. Bounded; never loops. */
async function walk(participantId: string): Promise<Page[]> {
  const pages: Page[] = [];
  let before: string | null = null;

  while (pages.length < MAX_PAGES) {
    const query = before === null ? "" : `?before=${encodeURIComponent(before)}`;
    const res = await request(listening(app))
      .get(`/api/bookings/my/bookings/all${query}`)
      .set("x-test-user-id", participantId)
      .expect(200);

    pages.push(res.body as Page);
    if (!res.body.has_more) return pages;
    before = res.body.next_before as string;
  }

  return pages;
}

describe.skipIf(skipDbTests)("my/bookings/all keyset paging against real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("bookings-all-keyset");

    // BEFORE THE MIGRATIONS AND BEFORE `../../config`, because the app pool
    // reads DATABASE_URL once at import and `ALTER DATABASE ... SET` only
    // reaches sessions opened afterwards. Set on the database rather than
    // through `options:` on a Pool, since the route uses the pool singleton.
    const database = new URL(postgres.connectionString).pathname.slice(1);
    const admin = new pg.Client({ connectionString: postgres.connectionString });
    await admin.connect();
    try {
      // An identifier, so it cannot be a bound parameter. The name comes from
      // `uniqueDatabaseName`, which strips everything outside [a-z0-9_].
      await admin.query(`ALTER DATABASE "${database}" SET TimeZone TO '${SESSION_TIME_ZONE}'`);
    } finally {
      await admin.end().catch(() => {});
    }

    process.env.DATABASE_URL = postgres.connectionString;
    // shared/config/environment.ts validates a >= 32 char session secret at
    // config import; nothing here signs anything, so a fixed constant.
    process.env.SESSION_SECRET ||=
      "vitest-postgres-bookings-keyset-constant-not-a-real-secret"; // gitleaks:allow
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
    // Stands in for the real session middleware: requireAuth reads
    // req.session.user and nothing else. The header names the acting user.
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id");
      if (userId) {
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id: userId, name: "Test", email: "t@example.com", role: "employee" },
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

  it("runs against a non-UTC session TimeZone, which is what makes the cursor rendering observable", async () => {
    // THE CONTROL ON THE WHOLE FILE. Without it, an `ALTER DATABASE` that
    // silently failed to apply would leave every arm below comparing UTC with
    // UTC and passing for ever, and the `AT TIME ZONE 'UTC'` in the route would
    // be unkillable. Read through the APP POOL, which is the pool the route
    // actually uses - not through a connection opened by this test.
    const shown = await pool.query("SHOW TimeZone");
    expect(shown.rows[0].TimeZone).toBe(SESSION_TIME_ZONE);
  }, 30_000);

  it("reports the end of history with no cursor when everything fits on one page", async () => {
    // THE `has_more === false` ARM against a real database. Without it, a route
    // hardcoding `has_more: true` satisfies every truncation assertion in the
    // walk below, and a `has_more` that is always true is as useless as one
    // that is always absent.
    const { participantId, sessionId } = await seedParticipantWithSession();
    await seedBookings(participantId, sessionId, 3);

    const pages = await walk(participantId);

    expect(pages).toHaveLength(1);
    expect(pages[0].bookings).toHaveLength(3);
    expect(pages[0].has_more).toBe(false);
    expect(pages[0].next_before).toBeNull();
  }, 60_000);

  it("walks the whole booking history with the cursor, with no duplicates and no gaps", async () => {
    const { participantId, sessionId } = await seedParticipantWithSession();
    await seedBookings(participantId, sessionId, SEEDED);

    // THE FIXTURE CONTROL. Every assertion below is over the ids the walk
    // returned, so a seed that inserted nothing would make "the union is
    // complete" true of an empty set.
    const seeded = await pool.query(`SELECT id FROM bookings WHERE user_id = $1`, [participantId]);
    expect(seeded.rows).toHaveLength(SEEDED);

    const pages = await walk(participantId);

    // A CURSOR THAT STOPS ADVANCING lands here rather than hanging the runner.
    expect(pages.length).toBeLessThan(MAX_PAGES);

    // 100 + 100 + 5. Literals, so a page size change shows up as a failure
    // rather than being absorbed by arithmetic over the constant.
    expect(pages.map((page) => page.bookings.length)).toEqual([100, 100, 5]);
    expect(pages.map((page) => page.has_more)).toEqual([true, true, false]);
    expect(pages[0].next_before).not.toBeNull();
    expect(pages[2].next_before).toBeNull();

    const walked = pages.flatMap((page) => page.bookings.map((booking) => booking.id));

    // NO DUPLICATES and NO GAPS, which together are the only assertion that
    // actually distinguishes keyset paging from silent truncation: a repeated
    // row makes the set smaller than the list, a dropped row makes both smaller
    // than the seeded set.
    expect(walked).toHaveLength(SEEDED);
    expect(new Set(walked).size).toBe(SEEDED);
    expect(new Set(walked)).toEqual(new Set(seeded.rows.map((r: { id: string }) => r.id)));

    // And the order is monotonically non-increasing ACROSS page boundaries, not
    // merely within a page. A boundary that jumps backwards is how a caller
    // sees the same row twice on two different pages.
    const times = pages.flatMap((page) => page.bookings.map((b) => Date.parse(b.created_at)));
    expect(times.filter((at, i) => i > 0 && at > times[i - 1])).toEqual([]);
  }, 120_000);

  it("returns both of two bookings that share a created_at exactly once, across a page boundary", async () => {
    const { participantId, sessionId } = await seedParticipantWithSession();
    await seedBookings(participantId, sessionId, SEEDED);
    const tied = await tieTwoBookingsAcrossPosition(participantId, TIED_POSITION);

    const pages = await walk(participantId);
    expect(pages.length).toBeLessThan(MAX_PAGES);

    const walked = pages.flatMap((page) => page.bookings.map((booking) => booking.id));

    // Nothing at all was lost, tie included.
    expect(walked).toHaveLength(SEEDED);
    expect(new Set(walked).size).toBe(SEEDED);

    // NEITHER TIED ROW IS DROPPED AND NEITHER IS REPEATED. Drop the `b.id` from
    // the keyset comparison and the second page asks for `created_at <` the tied
    // timestamp, which excludes BOTH tied rows - so the one on the far side of
    // the boundary is gone for ever and nothing else in the response changes.
    for (const id of tied) {
      expect({ id, occurrences: walked.filter((seen) => seen === id).length }).toEqual({
        id,
        occurrences: 1,
      });
    }

    // AND THE TIE REALLY DOES STRADDLE THE BOUNDARY, which is the control that
    // stops this arm passing vacuously against a fixture where both tied rows
    // sat comfortably inside page one. `TIED_POSITION` is the last row of the
    // first page, so its partner must be the first row of the second.
    const first = pages[0].bookings.map((booking) => booking.id);
    const second = pages[1].bookings.map((booking) => booking.id);
    expect(tied.filter((id) => first.includes(id))).toHaveLength(1);
    expect(tied.filter((id) => second.includes(id))).toHaveLength(1);
    expect(first[first.length - 1]).toBe(second[0] === tied[0] ? tied[1] : tied[0]);
  }, 120_000);
});
