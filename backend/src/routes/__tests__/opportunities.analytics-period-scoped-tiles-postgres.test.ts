import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * THE SNAPSHOT TILES FOLLOW THE PERIOD SELECTOR, AGAINST A REAL DATABASE.
 * DA-19, cto/AdaptaLabs.
 *
 * WHY IT CANNOT LIVE NEXT DOOR. Jest owns `src/**\/__tests__/**\/*.test.ts` with
 * a MOCKED pool, so opportunities.test.ts can only assert that the endpoint maps
 * a column onto the response - it returns whatever the mock was told to. The
 * property that matters is evaluated by Postgres alone: that the tile totals
 * (clicks_total / views_total / actions_total / the unique-* counts) count only
 * clicks inside the selected period's calendar days, not for all time.
 *
 * THE FIXTURE MAKES ALL-TIME AND PERIOD-SCOPED DISAGREE. Clicks are spread
 * across now, 3 days ago, 20 days ago and 100 days ago, so a 7-day request and a
 * 30-day request must return DIFFERENT tile totals. A revert to the old
 * unscoped `COUNT(*)` would return the same all-time number for both periods,
 * turning every asserted pair below into the wrong one - it fails by name.
 *
 * IT ALSO PINS WHAT MUST STAY ALL-TIME: first_click is "tracking since", so it
 * is the 100-day-old click regardless of the period. Scoping it by mistake
 * would move it, and this asserts it does not.
 *
 * NO LOOP HERE CAN HANG: it makes requests and asserts numbers, so a regression
 * is a wrong count, never a CI job timeout with no named failure.
 *
 * RUNS IN CI, in `test-backend-db` (`npx vitest run postgres`). The no-DB vitest
 * job sets FIRSTHAND_SKIP_DB_TESTS=1 and this suite skips.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

/** A distinct ip_hash. The value is opaque; only distinctness matters. */
const hash = (label: string) => crypto.createHash("sha256").update(label).digest("hex").slice(0, 32);

describe.skipIf(skipDbTests)("study-analytics snapshot tiles are scoped to the selected period", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("analytics-period-scoped-tiles");

    // BEFORE importing ../../config: the pool reads DATABASE_URL once, at import.
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-period-scoped-tiles-not-a-real-secret"; // gitleaks:allow
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
   * One published survey with anonymous clicks spread over time. Ages are picked
   * to sit clear of any calendar-day boundary so the split is not clock-flaky:
   *
   *   now      : views  ip a, a, b            in 7d and 30d
   *   3 days   : actions ip c, d              in 7d and 30d
   *   20 days  : views  ip e, e, f, g         in 30d only
   *   100 days : action ip h                  outside both (all-time only)
   *
   *   metric          period=7       period=30
   *   views_total     3              7
   *   actions_total   2              2
   *   clicks_total    5              9
   *   unique_viewers  {a,b}=2        {a,b,e,f,g}=5
   *   unique_actors   {c,d}=2        {c,d}=2
   *   unique_users    {a,b,c,d}=4    {a,b,c,d,e,f,g}=7
   */
  async function seed(): Promise<{ opportunityId: string; adminId: string }> {
    const adminId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, name, email, role)
       VALUES ($1, 'Owner Admin', 'owner-admin@example.com', 'superadmin')`,
      [adminId]
    );

    const oppResult = await pool.query(
      `INSERT INTO opportunities (type, title, purpose_one_liner, status, owner_user_id)
       VALUES ('survey', 'A survey with clicks spread over time',
               'Measuring period-scoped tiles on the analytics page', 'published', $1)
       RETURNING id`,
      [adminId]
    );
    const opportunityId = oppResult.rows[0].id as string;

    // [click_type, ip_hash, age in days]
    const clicks: Array<["view" | "action", string, number]> = [
      ["view", hash("a"), 0],
      ["view", hash("a"), 0],
      ["view", hash("b"), 0],
      ["action", hash("c"), 3],
      ["action", hash("d"), 3],
      ["view", hash("e"), 20],
      ["view", hash("e"), 20],
      ["view", hash("f"), 20],
      ["view", hash("g"), 20],
      ["action", hash("h"), 100],
    ];
    for (const [clickType, ipHash, ageDays] of clicks) {
      await pool.query(
        `INSERT INTO opportunity_clicks (opportunity_id, user_id, click_type, ip_hash, clicked_at)
         VALUES ($1, NULL, $2, $3, NOW() - ($4 * INTERVAL '1 day'))`,
        [opportunityId, clickType, ipHash, ageDays]
      );
    }

    return { opportunityId, adminId };
  }

  const analytics = async (opportunityId: string, adminId: string, period: number) =>
    request(listening(app))
      .get(`/api/opportunities/${opportunityId}/analytics`)
      .query({ period })
      .set("x-test-user-id", adminId)
      .set("x-test-user-role", "superadmin")
      .expect(200);

  it("counts only clicks inside the 7-day window when 7 days is selected", async () => {
    const { opportunityId, adminId } = await seed();
    const { body } = await analytics(opportunityId, adminId, 7);

    expect(body.period).toBe(7);
    expect(body.views_total).toBe(3);
    expect(body.actions_total).toBe(2);
    expect(body.clicks_total).toBe(5);
    expect(body.unique_viewers).toBe(2);
    expect(body.unique_actors).toBe(2);
    expect(body.unique_users).toBe(4);
    // Averaged over the selected period, from the same total.
    expect(body.avg_clicks_per_day).toBe(Math.round((5 / 7) * 10) / 10);
  });

  it("widens the same tiles when 30 days is selected", async () => {
    const { opportunityId, adminId } = await seed();
    const { body } = await analytics(opportunityId, adminId, 30);

    expect(body.period).toBe(30);
    expect(body.views_total).toBe(7);
    expect(body.actions_total).toBe(2);
    expect(body.clicks_total).toBe(9);
    expect(body.unique_viewers).toBe(5);
    expect(body.unique_actors).toBe(2);
    expect(body.unique_users).toBe(7);
    expect(body.avg_clicks_per_day).toBe(Math.round((9 / 30) * 10) / 10);
  });

  it("selecting a wider period returns strictly larger totals (the tiles move with the selector)", async () => {
    const { opportunityId, adminId } = await seed();
    const week = (await analytics(opportunityId, adminId, 7)).body;
    const month = (await analytics(opportunityId, adminId, 30)).body;

    // A revert to all-time would make these equal; the whole point is they differ.
    expect(month.clicks_total).toBeGreaterThan(week.clicks_total);
    expect(month.views_total).toBeGreaterThan(week.views_total);
    expect(month.unique_users).toBeGreaterThan(week.unique_users);
  });

  it("keeps first_click all-time (tracking-since), unmoved by the period", async () => {
    const { opportunityId, adminId } = await seed();
    const week = (await analytics(opportunityId, adminId, 7)).body;
    const month = (await analytics(opportunityId, adminId, 30)).body;

    // The oldest click is 100 days old and sits outside both windows, yet it is
    // when tracking began - so it is first_click for both periods.
    expect(week.first_click).toBe(month.first_click);
    const ageDays = (Date.now() - new Date(week.first_click).getTime()) / (24 * 60 * 60 * 1000);
    expect(ageDays).toBeGreaterThan(90);
  });
});
