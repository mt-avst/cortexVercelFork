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
});
