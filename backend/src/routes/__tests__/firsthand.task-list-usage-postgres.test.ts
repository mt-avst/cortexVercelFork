import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * `GET /api/firsthand/studies/:studyId/usage` AGAINST A REAL DATABASE. D4,
 * row 12 of the study-setup register ("used by N studies").
 *
 * WHY IT CANNOT LIVE NEXT DOOR. `firsthand.test.ts` mocks both
 * `../../firsthand/studies-repository` and `../../config`'s `pool`, so it can
 * only prove the ROUTE maps `listStudyUsage`'s return value onto
 * `{ count, studies }` - which it does (see that file). What it cannot prove
 * is the QUERY: that `firsthand_study_id` actually links an opportunity back
 * to a task list, across the real `opportunities` table, with a real
 * parameter binding. `opportunities.firsthand_study_id` has no foreign key
 * (migration 0007), so nothing but a real query can show two opportunities
 * sharing one id are both found, and that a third opportunity's own id is not
 * mistaken for a shared one.
 *
 * requireAdmin is REAL here (not the session-trusting double
 * `firsthand.test.ts` opts into), because whether a non-admin is refused is
 * itself part of what this route promises - it re-reads the live role from
 * `users`, so the seeded row is what actually decides the gate; the header
 * only names who is acting.
 *
 * RUNS IN CI, in `test-backend-db` (`npx vitest run postgres`), which supplies
 * a Postgres `services:` container via FIRSTHAND_TEST_DATABASE_URL. The no-DB
 * vitest job sets FIRSTHAND_SKIP_DB_TESTS=1 and this suite skips.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

describe.skipIf(skipDbTests)("task list usage, against a real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("task-list-usage");

    // BEFORE importing ../../config: the pool reads DATABASE_URL once, at
    // import, and getBackendConfig() throws at that same import unless
    // SESSION_SECRET is already set.
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-task-list-usage-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();

    const { pool: appPool } = await import("../../config");
    pool = appPool;

    const firsthandRouter = (await import("../firsthand")).default;
    const { errorHandler } = await import("../../utils/errorHandler");
    const expressModule = (await import("express")).default;

    app = expressModule();
    app.use(expressModule.json());
    // Stand in for session/auth: requireAdmin re-reads the DB role for this
    // id, so the seeded row's role is what actually passes or fails the gate;
    // the header only names who is acting.
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id");
      if (userId) {
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id: userId, name: "Test user", email: "test-user@example.com" },
        };
      }
      next();
    });
    app.use("/api/firsthand", firsthandRouter);
    app.use(errorHandler);
  }, 180_000);

  afterAll(async () => {
    await closeListeningServers();
    await pool?.end().catch(() => {});
    await postgres?.stop();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE opportunities, users CASCADE");
  });

  async function seedUser(role: "researcher_admin" | "employee"): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      "INSERT INTO users (id, name, email, role) VALUES ($1, $2, $3, $4)",
      [id, "Seeded user", `${id}@example.com`, role]
    );
    return id;
  }

  async function seedOpportunity(
    ownerId: string,
    title: string,
    status: "draft" | "published" | "closed",
    firsthandStudyId: string | null
  ): Promise<string> {
    const result = await pool.query(
      `INSERT INTO opportunities (type, title, purpose_one_liner, status, owner_user_id, firsthand_study_id)
       VALUES ('unmoderated', $1, 'A task list usage fixture, long enough to pass validation', $2, $3, $4)
       RETURNING id`,
      [title, status, ownerId, firsthandStudyId]
    );
    return result.rows[0].id as string;
  }

  it("reports every opportunity that shares this task list, and only those", async () => {
    const adminId = await seedUser("researcher_admin");
    const oppOneId = await seedOpportunity(adminId, "Onboarding survey", "published", "study_shared");
    const oppTwoId = await seedOpportunity(adminId, "Retention pulse", "draft", "study_shared");
    // A third opportunity with its OWN, unshared task list - proves the query
    // filters rather than returning every opportunity in the table.
    await seedOpportunity(adminId, "Unrelated study", "published", "study_unshared");

    const { body } = await request(listening(app))
      .get("/api/firsthand/studies/study_shared/usage")
      .set("x-test-user-id", adminId)
      .expect(200);

    expect(body.count).toBe(2);
    expect(body.studies).toEqual(
      expect.arrayContaining([
        { id: oppOneId, title: "Onboarding survey", status: "published" },
        { id: oppTwoId, title: "Retention pulse", status: "draft" },
      ])
    );
    expect(body.studies).toHaveLength(2);
  });

  it("answers count 0 for a task list nothing references, not an error", async () => {
    const adminId = await seedUser("researcher_admin");
    // A study id nobody has ever linked, plus an unrelated real opportunity in
    // the table so an unscoped query would visibly fail this.
    await seedOpportunity(adminId, "Unrelated study", "published", "study_other");

    const { body } = await request(listening(app))
      .get("/api/firsthand/studies/study_nobody_uses/usage")
      .set("x-test-user-id", adminId)
      .expect(200);

    expect(body).toEqual({ count: 0, studies: [] });
  });

  it("refuses a non-admin with the standard 403, and reveals nothing", async () => {
    const employeeId = await seedUser("employee");
    const adminId = await seedUser("researcher_admin");
    await seedOpportunity(adminId, "Onboarding survey", "published", "study_shared");

    const { body } = await request(listening(app))
      .get("/api/firsthand/studies/study_shared/usage")
      .set("x-test-user-id", employeeId)
      .expect(403);

    expect(body).toMatchObject({ error: "Admin access required" });
  });

  it("refuses an unauthenticated caller with 401", async () => {
    const { body } = await request(listening(app))
      .get("/api/firsthand/studies/study_shared/usage")
      .expect(401);

    expect(body).toMatchObject({ error: "Authentication required" });
  });
});
