import crypto from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";

/**
 * THE GAMIFICATION READS, AGAINST A REAL DATABASE, because both properties
 * under test live in SQL and neither is observable through a mock.
 *
 * cto/AdaptaLabs#17 - the leaderboards must not publish `user_id`. The route
 * hands `result.rows` from `pg` straight to `res.json`, so the SELECT LIST IS
 * THE PAYLOAD: dropping the field from `LeaderboardEntry` and leaving
 * `up.user_id` in the query serialises it onto the wire with `tsc` clean and
 * every route test green. Only a real query can see which columns come back.
 *
 * cto/AdaptaLabs#23 - `getPointsHistory` must report `has_more`. The
 * arithmetic is `LIMIT $2` bound to `limit + 1` and a slice, so a mocked
 * service returns whatever the mock was told to and proves nothing.
 *
 * RUNS IN CI, in `test-backend-db` (`npx vitest run postgres`), which supplies a
 * Postgres `services:` container via FIRSTHAND_TEST_DATABASE_URL. The no-DB
 * vitest job sets FIRSTHAND_SKIP_DB_TESTS=1 and this suite skips. Locally it
 * starts its own container, or uses FIRSTHAND_TEST_DATABASE_URL.
 *
 * DATABASE_URL is set before `../../config` is imported, because the app pool
 * reads it once at import. Every DB-facing import is dynamic and inside
 * `beforeAll`, so a skipped run touches neither a database nor the environment.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let gamification: typeof import("../../../../shared/services/gamification");

/** A participant with a profile on the board. */
async function seedParticipant(name: string, totalPoints: number, monthlyPoints: number) {
  const userId = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
    userId,
    name,
    `${userId}@example.com`,
  ]);
  await pool.query(
    `INSERT INTO user_profiles (user_id, total_points, monthly_points, level)
     VALUES ($1, $2, $3, 1)`,
    [userId, totalPoints, monthlyPoints]
  );
  return userId;
}

async function seedTransactions(userId: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    await pool.query(
      `INSERT INTO points_transactions (user_id, points, reason, created_at)
       VALUES ($1, 10, $2, NOW() - ($3 || ' minutes')::interval)`,
      [userId, `txn-${i}`, String(i)]
    );
  }
}

describe.skipIf(skipDbTests)("gamification reads against real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("gamification-reads");

    process.env.DATABASE_URL = postgres.connectionString;
    // shared/config/environment.ts validates a >= 32 char session secret at
    // config import; nothing here signs anything, so a fixed constant.
    process.env.SESSION_SECRET ||=
      "vitest-postgres-gamification-constant-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();

    const { pool: appPool } = await import("../../config");
    pool = appPool;

    gamification = await import("../../../../shared/services/gamification");
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await postgres?.stop();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE points_transactions, user_profiles, users CASCADE");
  });

  /**
   * cto/AdaptaLabs#17. Both boards, from one table, because the two queries are
   * near-identical and twenty-six lines apart - the shape where a change applied
   * to one reads as a change applied to both. #17's own cap reached one and not
   * the other for exactly that reason.
   */
  const BOARDS = [
    { board: "all-time", read: () => gamification.getLeaderboard(pool, 10) },
    { board: "monthly", read: () => gamification.getMonthlyLeaderboard(pool, 10) },
  ] as const;

  /**
   * THE BOARD IS IN EACH TEST'S OWN TITLE, not only in the describe title. The
   * mutation canary selects a test by name and refuses to grade an ambiguous
   * match, and `describe.each` with a shared `it` title puts every row in
   * exactly that position - two tests ending in the same name, so a kill cannot
   * be attributed to either.
   */
  describe.each(BOARDS)("the $board leaderboard payload", ({ board, read }) => {
    it(`publishes no user_id on the ${board} board`, async () => {
      await seedParticipant("Jane Participant", 120, 40);

      const rows = await read();

      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0])).not.toContain("user_id");
    });

    // THE CONTROL. `not.toContain('user_id')` passes just as well against an
    // empty board, a query that returned nothing, or a key scan that reads the
    // wrong object - so the same row must be shown to carry the fields that ARE
    // published. A leaderboard with no name is not a leaderboard.
    it(`still publishes the name, points and rank the ${board} board is for`, async () => {
      await seedParticipant("Jane Participant", 120, 40);

      const rows = await read();

      expect(rows[0].name).toBe("Jane Participant");
      expect(Number(rows[0].total_points)).toBe(120);
      expect(Number(rows[0].monthly_points)).toBe(40);
      expect(Number(rows[0].rank)).toBe(1);
    });
  });

  // THE SECOND CONTROL, and the one that proves the key scan above can actually
  // SEE a user_id when a query selects one. Without it, a scan reading the wrong
  // property, or `Object.keys` over a driver row shape that never carries plain
  // columns, would report the field absent forever - and an absence assertion
  // that cannot detect a presence is not an assertion.
  it("finds user_id when a query does select it", async () => {
    await seedParticipant("Jane Participant", 120, 40);

    const selected = await pool.query(
      `SELECT up.user_id, u.name FROM user_profiles up JOIN users u ON up.user_id = u.id`
    );

    expect(Object.keys(selected.rows[0])).toContain("user_id");
  });

  it("covers both leaderboards and not just one of them", () => {
    expect(BOARDS.map((b) => b.board).sort()).toEqual(["all-time", "monthly"]);
  });

  /**
   * cto/AdaptaLabs#23. BOTH ARMS, because either alone is half a test: a
   * `has_more` hardcoded true and one hardcoded false each satisfy one of them.
   */
  describe("getPointsHistory reports whether history continues", () => {
    it("reports has_more when older rows exist beyond the page", async () => {
      const userId = await seedParticipant("Paged Participant", 30, 30);
      await seedTransactions(userId, 3);

      const page = await gamification.getPointsHistory(pool, userId, 2);

      expect(page.has_more).toBe(true);
      // The probe row is NOT handed to the caller. A slice that forgot to trim
      // would answer three rows to a request for two, which is the same class of
      // lie in the other direction.
      expect(page.transactions).toHaveLength(2);
    });

    it("reports no more when the page is the end of history", async () => {
      const userId = await seedParticipant("Short Participant", 20, 20);
      await seedTransactions(userId, 2);

      const page = await gamification.getPointsHistory(pool, userId, 5);

      expect(page.has_more).toBe(false);
      expect(page.transactions).toHaveLength(2);
    });

    // THE BOUNDARY, and the reason the query asks for `limit + 1` rather than
    // comparing `rows.length` to `limit`. A history exactly as long as the page
    // is the one case where a length comparison invents rows that do not exist.
    it("reports no more when history is exactly the length of the page", async () => {
      const userId = await seedParticipant("Exact Participant", 20, 20);
      await seedTransactions(userId, 2);

      const page = await gamification.getPointsHistory(pool, userId, 2);

      expect(page.has_more).toBe(false);
      expect(page.transactions).toHaveLength(2);
    });

    it("reports no more for a caller with no history at all", async () => {
      const userId = await seedParticipant("New Participant", 0, 0);

      const page = await gamification.getPointsHistory(pool, userId, 20);

      expect(page.has_more).toBe(false);
      expect(page.transactions).toEqual([]);
    });

    // Another caller's rows must not count towards this caller's `has_more`,
    // or a busy deployment reports every user's history as continuing.
    it("counts only the caller's own rows towards has_more", async () => {
      const mine = await seedParticipant("Mine", 10, 10);
      const theirs = await seedParticipant("Theirs", 10, 10);
      await seedTransactions(mine, 1);
      await seedTransactions(theirs, 50);

      const page = await gamification.getPointsHistory(pool, mine, 1);

      expect(page.has_more).toBe(false);
      expect(page.transactions).toHaveLength(1);
    });
  });

  /**
   * cto/AdaptaLabs#47 - THE OLDER ROWS ARE NOW REACHABLE, and the two properties
   * that make keyset the right choice are only observable against a real
   * database. A mocked service returns what the mock was told to; row
   * comparison, microsecond timestamps and uuid ordering are all Postgres.
   *
   * WHY NOT `OFFSET`. Two reasons, and the second one is a correctness bug
   * rather than a performance one:
   *
   *   it re-scans everything it skips, so deep pages get linearly slower, and
   *   it SKIPS OR REPEATS rows when a transaction lands between two requests -
   *   which on this table it will, because points are awarded WHILE a user is
   *   reading their own history.
   *
   * `does not skip a row when a transaction lands between two page requests` is
   * the arm that would go red on an OFFSET implementation, so it is the one that
   * proves the choice was honoured rather than merely described.
   *
   * `separates two transactions that share a created_at` is the other: the `id`
   * tiebreak is not a formality. Two transactions awarded by the same statement
   * share a timestamp to the microsecond, and a page boundary landing between
   * them drops one for ever without it - silently, which is the worst kind.
   *
   * EVERY ARM COLLECTS THE ROWS IT SAW. An assertion that nothing was skipped
   * passes perfectly against a pager that returned nothing at all, so the ids
   * are compared as a SET as well as counted, and the unpaged read of the same
   * data is the control that says what the set should be.
   */
  describe("getPointsHistory pages backwards with a keyset cursor", () => {
    /** A transaction at an exact instant, so equal timestamps can be forced. */
    async function seedAt(userId: string, reason: string, createdAt: string) {
      const inserted = await pool.query(
        `INSERT INTO points_transactions (user_id, points, reason, created_at)
         VALUES ($1, 10, $2, $3::timestamptz) RETURNING id`,
        [userId, reason, createdAt]
      );
      return inserted.rows[0].id as string;
    }

    /**
     * Follows `next_before` to the end and returns every id it saw, in order.
     *
     * `between` runs after the FIRST page, which is the whole point of the
     * interleaving arm: it is the write that OFFSET cannot survive.
     *
     * The page counter is BOUNDED. A cursor that failed to advance would loop
     * for ever here, and a suite that hangs is a job timeout with no named
     * failing test - the hardest kind of regression to read. 50 pages is far
     * more than any arm below needs, so reaching it IS the failure.
     */
    async function pageThrough(
      userId: string,
      limit: number,
      between?: () => Promise<void>,
      readPool: pg.Pool = pool
    ): Promise<string[]> {
      const seen: string[] = [];
      let before: ReturnType<typeof gamification.parsePointsHistoryCursor> = null;

      for (let pages = 0; pages < 50; pages += 1) {
        const page = await gamification.getPointsHistory(readPool, userId, limit, before);
        seen.push(...page.transactions.map((transaction) => transaction.id));

        if (!page.has_more) return seen;

        expect(page.next_before).not.toBeNull();
        before = gamification.parsePointsHistoryCursor(page.next_before!);
        // The route would answer 400 on a null here; in-process it would mean
        // the producer emitted a format its own parser rejects.
        expect(before).not.toBeNull();

        if (pages === 0 && between) await between();
      }

      throw new Error("the cursor never reached the end of history in 50 pages");
    }

    it("reaches every row exactly once by following next_before", async () => {
      const userId = await seedParticipant("Paging Participant", 70, 70);
      await seedTransactions(userId, 7);

      const paged = await pageThrough(userId, 2);

      // THE CONTROL: the same rows read in one page. Without it, "no duplicates
      // and nothing skipped" is satisfied by a pager that returned nothing.
      const whole = await gamification.getPointsHistory(pool, userId, 100);
      const expected = whole.transactions.map((transaction) => transaction.id);

      expect(expected).toHaveLength(7);
      expect(paged).toEqual(expected);
      expect(new Set(paged).size).toBe(7);
    });

    it("hands back no cursor at the end of history", async () => {
      const userId = await seedParticipant("Ending Participant", 20, 20);
      await seedTransactions(userId, 2);

      const page = await gamification.getPointsHistory(pool, userId, 5);

      expect(page.has_more).toBe(false);
      expect(page.next_before).toBeNull();
    });

    // The control for the arm above: a cursor IS handed out while there is more,
    // so `toBeNull()` there is evidence about the end of history rather than
    // about `next_before` never being populated at all.
    it("hands back a cursor while history continues", async () => {
      const userId = await seedParticipant("Continuing Participant", 30, 30);
      await seedTransactions(userId, 3);

      const page = await gamification.getPointsHistory(pool, userId, 2);

      expect(page.has_more).toBe(true);
      expect(page.next_before).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z,[0-9a-f-]{36}$/);
    });

    /**
     * THE ARM THAT PICKS KEYSET OVER OFFSET, and it is written so it can only
     * pass one way.
     *
     * Ten transactions, oldest first, then a NEWER one inserted after page one
     * has been read. With `OFFSET 2` the new row shifts everything down by one
     * and page two REPEATS the last row of page one. With a keyset cursor the
     * second page continues from a fixed position and the new row - which is
     * newer than the cursor - is simply not in it.
     */
    it("does not skip or repeat a row when a transaction lands between two page requests", async () => {
      const userId = await seedParticipant("Racing Participant", 100, 100);
      await seedTransactions(userId, 10);

      const paged = await pageThrough(userId, 3, async () => {
        await seedAt(userId, "landed-mid-page", "2030-01-01T00:00:00Z");
      });

      // No id twice. On an OFFSET pager this is the assertion that goes red.
      expect(new Set(paged).size).toBe(paged.length);

      // And none of the ten original rows went missing behind the newcomer.
      const whole = await gamification.getPointsHistory(pool, userId, 100);
      const original = whole.transactions
        .filter((transaction) => transaction.reason !== "landed-mid-page")
        .map((transaction) => transaction.id);

      expect(original).toHaveLength(10);
      expect(paged.filter((id) => original.includes(id)).sort()).toEqual([...original].sort());
    });

    /**
     * THE `id` TIEBREAK, forced rather than hoped for.
     *
     * Four transactions on TWO distinct instants, two rows each, read a page at
     * a time with `limit = 1` so a boundary falls between every adjacent pair -
     * including the two that share a timestamp. `ORDER BY created_at DESC` alone
     * gives Postgres a free choice at that boundary, and `(created_at) < $3`
     * without the tiebreak excludes the twin as well as the row just read.
     */
    it("returns both of two transactions that share a created_at exactly once", async () => {
      const userId = await seedParticipant("Twin Participant", 40, 40);
      const first = await seedAt(userId, "twin-a", "2026-05-01T12:00:00.123456Z");
      const second = await seedAt(userId, "twin-b", "2026-05-01T12:00:00.123456Z");
      await seedAt(userId, "older", "2026-04-01T12:00:00Z");
      await seedAt(userId, "newer", "2026-06-01T12:00:00Z");

      const paged = await pageThrough(userId, 1);

      expect(paged).toHaveLength(4);
      expect(new Set(paged).size).toBe(4);
      expect(paged).toContain(first);
      expect(paged).toContain(second);
    });

    // THE CONTROL for the arm above, and it is the one that proves the fixture
    // actually built what it claims: two rows really do share a created_at to
    // the microsecond in the database, so the tiebreak is being exercised rather
    // than the timestamps quietly differing.
    it("really does store two transactions at the same microsecond", async () => {
      const userId = await seedParticipant("Twin Fixture", 20, 20);
      await seedAt(userId, "twin-a", "2026-05-01T12:00:00.123456Z");
      await seedAt(userId, "twin-b", "2026-05-01T12:00:00.123456Z");

      const distinct = await pool.query(
        `SELECT COUNT(DISTINCT created_at)::int AS instants, COUNT(*)::int AS rows
         FROM points_transactions WHERE user_id = $1`,
        [userId]
      );

      expect(distinct.rows[0].rows).toBe(2);
      expect(distinct.rows[0].instants).toBe(1);
    });

    /**
     * THE PRECISION THE CURSOR HAS TO CARRY, measured rather than assumed.
     *
     * `created_at` is TIMESTAMPTZ and Postgres keeps microseconds; `pg` parses it
     * into a JavaScript `Date`, which keeps milliseconds. So a caller rebuilding
     * a cursor from a transaction's own `created_at` would round .123456 down to
     * .123000 and skip everything in between. `next_before` is rendered with
     * `to_char` for exactly this reason, and this arm is what would notice if it
     * stopped being.
     */
    it("carries microseconds in next_before that the transaction's own created_at has lost", async () => {
      const userId = await seedParticipant("Precise Participant", 20, 20);
      await seedAt(userId, "precise-older", "2026-05-01T12:00:00.123456Z");
      await seedAt(userId, "precise-newer", "2026-05-01T12:00:01.654321Z");

      const page = await gamification.getPointsHistory(pool, userId, 1);

      expect(page.has_more).toBe(true);
      expect(page.next_before).toContain(".654321Z");
      // The rounded form is what a client would have built for itself, and it is
      // NOT what the server handed out.
      expect(page.next_before).not.toContain(".654Z");
    });

    /**
     * `AT TIME ZONE 'UTC'` IS THE MOST LOAD-BEARING TOKEN IN THE QUERY, and
     * removing it passed every arm above. Raised by the refute gate on !267.
     *
     * `to_char` renders a TIMESTAMPTZ in the SESSION's `TimeZone`. Without the
     * conversion, `next_before` is a WALL-CLOCK reading in whatever timezone the
     * connection happens to carry, while the `$3::timestamptz` it is fed back
     * into parses a value with NO offset as being in that same session timezone -
     * so the round trip only closes by coincidence when the session is UTC. It
     * is, in CI and in every container this repository starts, which is exactly
     * why nothing could see it.
     *
     * The gate measured what removal costs: `Pacific/Kiritimati` (+14) paged 50
     * pages and saw ONE unique row - an infinite repeat of page one, which is the
     * bounded-loop throw above firing rather than a hang - and
     * `America/New_York` silently LOST 5 of 8 rows. Not an error either time.
     *
     * `AT TIME ZONE 'UTC'` converts to a plain `timestamp` first, so `to_char`
     * has no zone left to consult and the output is identical everywhere. This
     * arm reads through a pool whose session is pinned to +14, and the assertion
     * that matters is that the cursor is BYTE-IDENTICAL to the UTC one - the same
     * ids in the same order would also pass on a single page.
     *
     * Nothing in the tree sets a Postgres `TimeZone` today, so this is latent
     * rather than live. It is the thing most likely to break silently later, and
     * a property with no test is a property that holds until someone changes a
     * connection string.
     */
    it("renders the same cursor under a non-UTC session TimeZone", async () => {
      const userId = await seedParticipant("Timezone Participant", 80, 80);
      await seedTransactions(userId, 8);

      const utcPaged = await pageThrough(userId, 1);
      const utcCursor = (await gamification.getPointsHistory(pool, userId, 1)).next_before;

      const { Pool } = await import("pg");
      const tzPool = new Pool({
        connectionString: postgres.connectionString,
        // +14, the extreme the gate found turned paging into an infinite repeat.
        options: "-c TimeZone=Pacific/Kiritimati",
      });

      try {
        // THE CONTROL ON THE FIXTURE. Without it, a `options` string the driver
        // silently ignored would leave this arm comparing UTC with UTC and
        // passing for ever - an absence assertion that cannot detect a presence.
        const shown = await tzPool.query("SHOW TimeZone");
        expect(shown.rows[0].TimeZone).toBe("Pacific/Kiritimati");

        const tzPaged = await pageThrough(userId, 1, undefined, tzPool);
        const tzCursor = (await gamification.getPointsHistory(tzPool, userId, 1)).next_before;

        expect(tzCursor).toBe(utcCursor);
        expect(tzPaged).toEqual(utcPaged);
        expect(new Set(tzPaged).size).toBe(8);
      } finally {
        await tzPool.end();
      }
    });
  });
});
