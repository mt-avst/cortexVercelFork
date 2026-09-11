import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * DISTINCT VISITORS ON THE STUDY-ANALYTICS ENDPOINT, AGAINST A REAL DATABASE.
 * DA-20 (second half), cto/AdaptaLabs.
 *
 * WHY IT CANNOT LIVE NEXT DOOR. Jest owns `src/**\/__tests__/**\/*.test.ts` with
 * a MOCKED pool, so opportunities.test.ts can only assert that the endpoint maps
 * a `unique_users`/`unique_count` column onto the response - it returns whatever
 * the mock was told to. The property that actually matters is evaluated by
 * Postgres and nothing else: that `COUNT(DISTINCT COALESCE(user_id::text,
 * ip_hash))` counts a signed-OUT visitor once by their ip_hash rather than
 * dropping them the way `COUNT(DISTINCT user_id)` did.
 *
 * THE FIXTURE IS BUILT SO THE OLD SQL AND THE NEW SQL DISAGREE. Click tracking
 * on a published survey records anonymous clicks with user_id NULL (see the
 * INSERT in opportunities.ts). Here EVERY action is anonymous, so the old
 * `COUNT(DISTINCT user_id)` returns 0 beside 8 actions - the exact "Unique: 0"
 * the review flagged. The new expression counts the five distinct ip_hashes.
 * A revert to the old SQL turns every asserted number below into the wrong one,
 * so the test fails by name rather than passing on a coincidence.
 *
 * NO LOOP HERE CAN HANG: it makes ONE request and asserts the numbers, so a
 * regression is a wrong count, never a CI job timeout with no named failure.
 *
 * RUNS IN CI, in `test-backend-db` (`npx vitest run postgres`), which supplies a
 * Postgres `services:` container via FIRSTHAND_TEST_DATABASE_URL. The no-DB
 * vitest job sets FIRSTHAND_SKIP_DB_TESTS=1 and this suite skips.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

/** A distinct ip_hash. The value is opaque; only distinctness matters here. */
const hash = (label: string) => crypto.createHash("sha256").update(label).digest("hex").slice(0, 32);

describe.skipIf(skipDbTests)("study analytics counts distinct visitors, not just signed-in users", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("analytics-distinct-visitors");

    // BEFORE importing ../../config: the pool reads DATABASE_URL once, at import.
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-distinct-visitors-not-a-real-secret"; // gitleaks:allow
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
    // Stand in for session/auth: requireAdmin re-reads the DB role for this id,
    // so the seeded superadmin row is what actually passes the gate; the header
    // only names who is acting.
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id");
      const role = req.header("x-test-user-role") ?? "superadmin";
      if (userId) {
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id: userId, name: "Admin", email: "admin@example.com", role },
        };
      }
      next();
    });
    app.use("/api/opportunities", opportunitiesRouter);
    app.use(errorHandler);
  }, 180_000);

  afterAll(async () => {
    await closeListeningServers();
    await pool?.end().catch(() => {});
    await postgres?.stop();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE opportunity_clicks, opportunities, users CASCADE");
  });

  /**
   * One published survey owned by a superadmin, plus a second (signed-in)
   * visitor, and clicks whose identities are:
   *
   *   actions (8, ALL anonymous): ip_hash a,a,b,b,c,c,d,e -> 5 distinct
   *   views   (5): anon a,a,b,x  +  signed-in user U (ip y) -> {a,b,x,U} = 4
   *
   * so across everything the distinct identities are {a,b,c,d,e,x,U} = 7.
   *
   *   metric          new SQL (COALESCE)   old SQL (user_id only)
   *   unique_actors    5                    0
   *   unique_viewers   4                    1
   *   unique_users     7                    1
   */
  async function seed(): Promise<string> {
    const adminId = crypto.randomUUID();
    const visitorId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, name, email, role) VALUES
         ($1, 'Owner Admin', 'owner-admin@example.com', 'superadmin'),
         ($2, 'Signed-in Visitor', 'visitor@example.com', 'employee')`,
      [adminId, visitorId]
    );

    const oppResult = await pool.query(
      `INSERT INTO opportunities (type, title, purpose_one_liner, status, owner_user_id)
       VALUES ('survey', 'A public survey with anonymous traffic',
               'Measuring distinct-visitor counting on the analytics page', 'published', $1)
       RETURNING id`,
      [adminId]
    );
    const opportunityId = oppResult.rows[0].id as string;

    const clicks: Array<[string | null, "view" | "action", string]> = [
      // 8 anonymous actions across 5 distinct ip_hashes
      [null, "action", hash("a")],
      [null, "action", hash("a")],
      [null, "action", hash("b")],
      [null, "action", hash("b")],
      [null, "action", hash("c")],
      [null, "action", hash("c")],
      [null, "action", hash("d")],
      [null, "action", hash("e")],
      // 4 anonymous views across 3 distinct ip_hashes
      [null, "view", hash("a")],
      [null, "view", hash("a")],
      [null, "view", hash("b")],
      [null, "view", hash("x")],
      // 1 signed-in view - counted by user_id, not ip_hash
      [visitorId, "view", hash("y")],
    ];
    for (const [userId, clickType, ipHash] of clicks) {
      await pool.query(
        `INSERT INTO opportunity_clicks (opportunity_id, user_id, click_type, ip_hash)
         VALUES ($1, $2, $3, $4)`,
        [opportunityId, userId, clickType, ipHash]
      );
    }

    return opportunityId;
  }

  it("counts each anonymous visitor once by ip_hash instead of dropping them", async () => {
    const opportunityId = await seed();

    // Act as the seeded superadmin: requireAdmin re-reads the role from the DB
    // for this id, so a real superadmin row is what passes the gate.
    const adminRow = await pool.query("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1");
    const adminId = adminRow.rows[0].id as string;

    const { body } = await request(listening(app))
      .get(`/api/opportunities/${opportunityId}/analytics`)
      .set("x-test-user-id", adminId)
      .set("x-test-user-role", "superadmin")
      .expect(200);

    // The totals are unchanged by this fix - they are COUNT(*).
    expect(body.actions_total).toBe(8);
    expect(body.views_total).toBe(5);
    expect(body.clicks_total).toBe(13);

    // The distinct-visitor counts are the fix. Each fails by name if the SQL
    // reverts to COUNT(DISTINCT user_id) (which would give 0 / 1 / 1).
    expect(body.unique_actors).toBe(5);
    expect(body.unique_viewers).toBe(4);
    expect(body.unique_users).toBe(7);

    // The whole point of DA-20's second half: not 0 beside 8 actions, and a
    // genuine dedup (fewer than the raw total) rather than a COUNT(*) echo.
    expect(body.unique_actors).toBeGreaterThan(0);
    expect(body.unique_actors).toBeLessThan(body.actions_total);
  });
});
