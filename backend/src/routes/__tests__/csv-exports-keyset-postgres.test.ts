import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * THE BATCHED WALK ON THE TWO ADMIN CSV EXPORTS, AGAINST A REAL DATABASE.
 * cto/AdaptaLabs#65.
 *
 * WHY IT CANNOT LIVE NEXT DOOR. Jest owns `src/**\/__tests__/**\/*.test.ts` with
 * a MOCKED pool (jest.config.js), so csv-exports-are-streamed.test.ts can only
 * assert how many statements were sent, what was bound to them, and what
 * reached the socket. The property that actually matters is evaluated by
 * Postgres and by nothing else:
 *
 *   - whether `(created_at, id) < ($1, $2)` with `ORDER BY created_at DESC,
 *     id DESC` walks a table across BATCH BOUNDARIES without dropping or
 *     repeating a row;
 *   - whether the `id` TIEBREAK does anything, which is observable only when
 *     rows share a `created_at` AND a batch boundary falls between two of them.
 *
 * A mocked pool returns whatever it was told to, so both would pass against a
 * walk that pages by luck.
 *
 * THE TIMESTAMPS ARE DELIBERATELY NOT DISTINCT, and that is the whole design.
 * Every seeded row here shares one of three `created_at` values, so with 1,200
 * rows and a 500-row batch EVERY boundary lands inside a group of equal
 * timestamps. Under `created_at` alone the second batch's predicate
 * `created_at < <that same value>` matches nothing, the walk stops early, and
 * the export silently contains 500 rows instead of 1,200 - which is exactly
 * the "silently truncated" outcome #65 says a bare LIMIT would have produced.
 * With the uuid in the key it addresses one position and the walk completes.
 *
 * NO LOOP HERE CAN HANG. The failure this file is built to catch is a walk
 * that stops early, which ends the request rather than stalling it, and the
 * handler's own termination condition is a short batch. There is no
 * `while (has_more)` in the test at all - it makes ONE request and counts what
 * came back - so a broken cursor is a wrong number, never a CI job timeout
 * with no named failing test.
 *
 * RUNS IN CI, in `test-backend-db` (`npx vitest run postgres`), which supplies
 * a Postgres `services:` container via FIRSTHAND_TEST_DATABASE_URL. The no-DB
 * vitest job sets FIRSTHAND_SKIP_DB_TESTS=1 and this suite skips.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

/**
 * More than two batches and not a whole multiple of one, so the walk covers a
 * first batch, a middle batch and a short last one. 1,200 against a batch size
 * of 500 gives 500 + 500 + 200.
 *
 * The batch size is written here as its own literal rather than imported. If
 * the two ever disagree this file still passes or fails on the property -
 * every row exactly once - rather than on arithmetic derived from the constant
 * it is supposed to be testing around.
 */
const SEEDED_ROWS = 1_200;

/**
 * Three groups of 400, so every 500-row boundary falls inside a group.
 *
 * EVERY SEEDED TIMESTAMP CARRIES MICROSECONDS (`.123456`), deliberately. The
 * first CI run of this file caught the bookings walk truncating at one batch
 * because the cursor round-tripped through a node-pg JS Date, which holds
 * MILLISECONDS - so a µs-bearing `start_time` compared strictly greater than
 * its own truncated cursor and batch 2 matched nothing. The feedback fixture's
 * whole-second timestamps could never have seen that. Production timestamps
 * come from NOW() and always carry µs, so a fixture without them tests a
 * database that does not exist. Same trap as [[cortex-f1-optimistic-concurrency]].
 */
const DISTINCT_TIMESTAMPS = 3;

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

describe.skipIf(skipDbTests)("admin CSV exports walk their keyset against real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("csv-exports-keyset");

    // BEFORE importing ../../config: the pool reads DATABASE_URL once, at
    // import time.
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-csv-export-constant-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();

    const { pool: appPool } = await import("../../config");
    pool = appPool;

    const feedbackRouter = (await import("../feedback")).default;
    const adminRouter = (await import("../admin")).default;
    const { errorHandler } = await import("../../utils/errorHandler");
    const expressModule = (await import("express")).default;

    app = expressModule();
    app.use(expressModule.json());
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
    app.use("/api/feedback", feedbackRouter);
    app.use("/api/admin", adminRouter);
    app.use(errorHandler);
  }, 180_000);

  afterAll(async () => {
    await closeListeningServers();
    await pool?.end().catch(() => {});
    await postgres?.stop();
  });

  /** The caller every HTTP arm acts as. MUST exist in the users table. */
  const SUPERADMIN_ID = "00000000-0000-0000-0000-000000000001";

  beforeEach(async () => {
    // BOTH trees, and in `beforeEach` rather than at the end of the arm that
    // seeds them. A cleanup that runs only on the success path leaves the next
    // arm reading another arm's fixture the first time one fails, which turns
    // one red test into two and hides which was the real one.
    await pool.query("TRUNCATE feedback CASCADE");
    await pool.query("TRUNCATE users CASCADE");
    // SEEDED, NOT JUST CLAIMED IN A HEADER. This file uses the REAL
    // `requireAdmin`, which re-reads `SELECT role FROM users WHERE id = $1`
    // (#38's live-role work) and answers 401 when no row exists - the header
    // only populates the session stub. The first CI run of this file failed
    // three arms with 401 for exactly this omission; the concurrency-postgres
    // suite next door seeds its users and this file had copied everything
    // about its setup except that.
    await pool.query(
      `INSERT INTO users (id, name, email, role) VALUES ($1, 'Super', 'super-csv@example.com', 'superadmin')`,
      [SUPERADMIN_ID]
    );
  });

  /**
   * The data rows of a CSV, header dropped and the trailing separator ignored.
   *
   * Split on CRLF because that is what `CSV_ROW_SEPARATOR` emits. No cell
   * seeded by this file contains a newline, so a naive split is exact here -
   * stated rather than assumed, because it would not be for arbitrary content.
   */
  const dataRows = (csv: string): string[] =>
    csv.split("\r\n").slice(1).filter((line) => line.length > 0);

  it("exports every feedback row exactly once across batch boundaries", async () => {
    // One statement, so the seed cannot itself be slow enough to matter.
    await pool.query(
      `INSERT INTO feedback (category, feedback, created_at)
       SELECT 'bug',
              'row ' || g,
              TIMESTAMPTZ '2026-01-01T00:00:00.123456Z' + ((g % $2) * INTERVAL '1 hour')
       FROM generate_series(1, $1) AS g`,
      [SEEDED_ROWS, DISTINCT_TIMESTAMPS]
    );

    const res = await request(listening(app))
      .get("/api/feedback/export")
      .set("x-test-user-id", SUPERADMIN_ID)
      .set("x-test-user-role", "superadmin")
      .expect(200);

    const rows = dataRows(res.text);

    // THE PROPERTY, in the form that fails loudest. Under `created_at` alone
    // this is 500.
    expect(rows).toHaveLength(SEEDED_ROWS);

    // AND EACH ROW EXACTLY ONCE. A count alone passes against a walk that
    // repeated one batch and dropped another - the failure mode a keyset gets
    // wrong when the ORDER BY and the predicate disagree.
    const ids = rows.map((line) => line.split(",")[0]);
    expect(new Set(ids).size).toBe(SEEDED_ROWS);
  });

  // THE CONTROL. The arm above passes just as well against a handler that
  // ignores the cursor entirely and returns everything in one unbounded read -
  // which is the defect #65 exists to remove. So prove the seeded data really
  // does span more than one batch, by checking the ordering the walk depends
  // on holds ACROSS the boundary: row 500 and row 501 must be in order, and
  // they come from different batches.
  it("keeps a single descending order across the batch boundary", async () => {
    await pool.query(
      `INSERT INTO feedback (category, feedback, created_at)
       SELECT 'bug',
              'row ' || g,
              TIMESTAMPTZ '2026-01-01T00:00:00.123456Z' + ((g % $2) * INTERVAL '1 hour')
       FROM generate_series(1, $1) AS g`,
      [SEEDED_ROWS, DISTINCT_TIMESTAMPS]
    );

    const res = await request(listening(app))
      .get("/api/feedback/export")
      .set("x-test-user-id", SUPERADMIN_ID)
      .set("x-test-user-role", "superadmin")
      .expect(200);

    const rows = dataRows(res.text);
    expect(rows).toHaveLength(SEEDED_ROWS);

    // Read back what the database says the order should be, rather than
    // restating the ORDER BY here - a test that repeats the statement it is
    // checking cannot detect drift from it.
    const expected = await pool.query(
      `SELECT id::text FROM feedback ORDER BY created_at DESC, id DESC`
    );
    expect(rows.map((line) => line.split(",")[0])).toEqual(
      expected.rows.map((r: { id: string }) => r.id)
    );
  });

  /**
   * THE OTHER HALF OF THE CONTROL, and the reason the fixture is built the way
   * it is: prove the tiebreak is doing work rather than being decoration.
   *
   * Counted rather than asserted by eye - if the seed ever produced 1,200
   * distinct timestamps, both arms above would pass with no tiebreak at all
   * and this file would be testing nothing.
   */
  it("seeds rows that genuinely share timestamps, so the id tiebreak is load-bearing", async () => {
    await pool.query(
      `INSERT INTO feedback (category, feedback, created_at)
       SELECT 'bug',
              'row ' || g,
              TIMESTAMPTZ '2026-01-01T00:00:00.123456Z' + ((g % $2) * INTERVAL '1 hour')
       FROM generate_series(1, $1) AS g`,
      [SEEDED_ROWS, DISTINCT_TIMESTAMPS]
    );

    const distinct = await pool.query(
      `SELECT COUNT(DISTINCT created_at)::int AS n FROM feedback`
    );
    expect(distinct.rows[0].n).toBe(DISTINCT_TIMESTAMPS);
  });

  /**
   * THE BOOKINGS EXPORT, whose key is the harder of the two: three parts, and
   * across a four-table join.
   *
   * All 600 bookings hang off ONE session and share a `created_at`, so both
   * timestamp components of `(s.start_time, b.created_at, b.id)` are constant
   * and the ordering rests ENTIRELY on the uuid. Drop `b.id` from the
   * comparison and the second batch matches nothing, so the export is 500 rows
   * rather than 600 - the silent truncation, again, and by name.
   */
  it("exports every booking exactly once when the whole key but the uuid is constant", async () => {
    const owner = "00000000-0000-0000-0000-0000000000aa";
    const opportunity = "00000000-0000-0000-0000-0000000000bb";
    const session = "00000000-0000-0000-0000-0000000000cc";

    await pool.query(
      `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', 'owner-csv@example.com', 'researcher_admin')`,
      [owner]
    );
    await pool.query(
      `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
       VALUES ($1, 'test', 'CSV export keyset', 'Proving the batched walk', $2, 'published')`,
      [opportunity, owner]
    );
    // capacity 600 and booked_count 600, so the CHECK (booked_count <=
    // capacity) is satisfied and the fixture is internally honest.
    await pool.query(
      `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
       VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 1 hour', 600, 600)`,
      [session, opportunity]
    );
    await pool.query(
      `INSERT INTO users (id, name, email)
       SELECT gen_random_uuid(), 'P' || g, 'p' || g || '-csv@example.com'
       FROM generate_series(1, 600) AS g`
    );
    // One `created_at` for every booking - the partial unique index is on
    // (user_id, session_id) for active bookings, and each user books once.
    await pool.query(
      `INSERT INTO bookings (user_id, session_id, status, created_at)
       SELECT u.id, $1, 'booked', TIMESTAMPTZ '2026-02-02T00:00:00Z'
       FROM users u WHERE u.email LIKE 'p%-csv@example.com'`,
      [session]
    );

    const res = await request(listening(app))
      .get("/api/admin/export/bookings")
      .set("x-test-user-id", owner)
      .set("x-test-user-role", "superadmin")
      .expect(200);

    const rows = dataRows(res.text);
    expect(rows).toHaveLength(600);
    // Each participant email appears exactly once, which a count alone would
    // not show if a batch repeated.
    const emails = rows.map((line) => line.split(",")[5]);
    expect(new Set(emails).size).toBe(600);

  });

  it("neutralises a spreadsheet formula that really went through the database", async () => {
    // The jest suite proves this against a mocked row. Here the string makes a
    // full round trip through Postgres, so an encoding or escaping step
    // between the two cannot hide it.
    await pool.query(
      `INSERT INTO feedback (category, feedback) VALUES ('bug', $1)`,
      ['=HYPERLINK("http://evil.test","click")']
    );

    const res = await request(listening(app))
      .get("/api/feedback/export")
      .set("x-test-user-id", SUPERADMIN_ID)
      .set("x-test-user-role", "superadmin")
      .expect(200);

    expect(res.text).toContain('"\t=HYPERLINK(""http://evil.test"",""click"")"');
  });
});
