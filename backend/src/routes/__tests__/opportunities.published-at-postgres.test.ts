import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * `opportunities.published_at` STAMPING, AND WHO GETS TO SEE IT, AGAINST A
 * REAL DATABASE (cto/AdaptaLabs#168): the column drives the "New since your
 * last visit" badge, so a wrong stamp or a leak to a non-admin caller is
 * either a badge nobody earns or one that never goes away.
 *
 * The jest suite mocks the pool, so it can prove the handler SENDS a
 * `published_at` parameter but not what value a real `NOW()` binds it to, nor
 * that the create INSERT's `published_at` and `created_at` genuinely come
 * from the same statement's clock rather than two `new Date()` calls that
 * can drift apart under load. This file proves both with a real database.
 *
 * The route-level half (participant/anonymous responses never carry
 * `published_at`, admin responses do) lives here too, alongside the stamping
 * it protects: `utils/__tests__/publicOpportunity.test.ts`
 * pins the serialiser in isolation, but only a real GET through the mounted
 * route proves the admin branch's `res.json(isAdmin ? opportunity : ...)`
 * still sends the raw, unstripped row.
 *
 * `type: 'question'` throughout: it is the cheapest type that can be created
 * directly as `published` in one call (a bookable `test`/`interview` publish
 * is refused with zero sessions by #118's own gate; `unmoderated` and native
 * `question`/`survey`/`poll` need a linked or inline study), needing only a
 * publishable `external_link_optional`.
 *
 * Runs in CI's `test-backend-db` (`npx vitest run postgres`); the no-DB vitest
 * job skips it via FIRSTHAND_SKIP_DB_TESTS.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

async function seedUser(role: "researcher_admin" | "employee" = "researcher_admin"): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, name, email, role) VALUES ($1, 'U', $2, $3)`, [
    id,
    `user-${id}@example.com`,
    role,
  ]);
  return id;
}

const adminGet = (adminId: string, path: string) =>
  request(listening(app))
    .get(path)
    .set("x-test-user-id", adminId)
    .set("x-test-user-role", "researcher_admin");

const adminPost = (adminId: string, path: string) =>
  request(listening(app))
    .post(path)
    .set("x-test-user-id", adminId)
    .set("x-test-user-role", "researcher_admin");

const create = (adminId: string, body: Record<string, unknown>) =>
  adminPost(adminId, "/api/opportunities").send(body);

const patch = (adminId: string, id: string, body: Record<string, unknown>) =>
  request(listening(app))
    .patch(`/api/opportunities/${id}`)
    .set("x-test-user-id", adminId)
    .set("x-test-user-role", "researcher_admin")
    .send(body);

const CREATE_BASE = {
  type: "question",
  title: "Published-at stamping fixture",
  purpose_one_liner: "Proving published_at is stamped from the database clock",
  external_link_optional: "https://example.com/survey",
};

describe.skipIf(skipDbTests)(
  "opportunities.published_at: stamped from the database clock, and stripped from non-admin responses",
  () => {
    beforeAll(async () => {
      postgres = await startTestPostgres("opportunities-published-at");
      process.env.DATABASE_URL = postgres.connectionString;
      process.env.SESSION_SECRET ||=
        "vitest-postgres-published-at-not-a-real-secret"; // gitleaks:allow
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
        const role = req.header("x-test-user-role");
        if (userId) {
          (req as unknown as { session: { user: unknown } }).session = {
            user: { id: userId, name: "U", email: `${userId}@example.com`, role: role ?? "researcher_admin" },
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
      await pool.query("TRUNCATE bookings, sessions, opportunities, users CASCADE");
    });

    it("stamps published_at from the DATABASE clock on a direct create-as-published, equal to created_at", async () => {
      const admin = await seedUser();

      const res = await create(admin, { ...CREATE_BASE, status: "published" }).expect(201);

      expect(res.body.published_at).not.toBeNull();
      // Same statement, same NOW() - one clock for every timestamp this
      // feature compares, not the app's `new Date()` for one column and the
      // database's `NOW()` for the other, which could drift apart under load.
      expect(res.body.published_at).toBe(res.body.created_at);
    });

    it("leaves published_at null on a create as draft", async () => {
      const admin = await seedUser();

      const res = await create(admin, { ...CREATE_BASE, status: "draft" }).expect(201);

      expect(res.body.published_at).toBeNull();
    });

    it("stamps published_at on a genuine draft->published PATCH", async () => {
      const admin = await seedUser();
      const created = await create(admin, { ...CREATE_BASE, status: "draft" }).expect(201);
      expect(created.body.published_at).toBeNull();

      const res = await patch(admin, created.body.id, { status: "published" }).expect(200);

      expect(res.body.published_at).not.toBeNull();
    });

    it("does NOT stamp published_at on a FIRST publish reached via draft->closed->published (the accepted rare cost)", async () => {
      const admin = await seedUser();
      const created = await create(admin, { ...CREATE_BASE, status: "draft" }).expect(201);
      expect(created.body.published_at).toBeNull();

      // Closed before ever having been published - by the time this PATCH
      // runs the existing row's status is 'closed', not 'draft', so the
      // from-draft-only stamp condition does not fire here. Accepted
      // (cto/AdaptaLabs#168): a pre-column closed row and a study genuinely
      // closed before its first publish share the same shape (`closed` with
      // a null `published_at`) and cannot be told apart from this PATCH, so
      // stamping this transition would resurface an old, already-seen study
      // as newly published. Reopening one must stay quiet, and this is the
      // rare case that costs.
      const closed = await patch(admin, created.body.id, { status: "closed" }).expect(200);
      expect(closed.body.published_at).toBeNull();

      const firstPublish = await patch(admin, created.body.id, { status: "published" }).expect(200);

      expect(firstPublish.body.published_at).toBeNull();
    });

    it("a resave of a published row whose published_at is NULL does not stamp", async () => {
      const admin = await seedUser();
      const created = await create(admin, { ...CREATE_BASE, status: "published" }).expect(201);
      expect(created.body.published_at).not.toBeNull();

      // Simulates a study published before this column existed: published_at
      // wiped back to null directly in the database, bypassing the route.
      await pool.query(`UPDATE opportunities SET published_at = NULL WHERE id = $1`, [created.body.id]);

      const resaved = await patch(admin, created.body.id, {
        status: "published",
        title: "A resaved title",
      }).expect(200);

      // The existing row's status is already 'published', not 'draft', so the
      // from-draft-only stamp condition never fires on a resave - the column
      // is left exactly where it was, null included, whatever the request
      // sends for `status`.
      expect(resaved.body.published_at).toBeNull();
    });

    it("Close-with-Undo (closed->published) of a pre-column row does not stamp", async () => {
      const admin = await seedUser();
      const created = await create(admin, { ...CREATE_BASE, status: "published" }).expect(201);
      await patch(admin, created.body.id, { status: "closed" }).expect(200);

      // Simulates the same pre-column shape as above, now on a closed row: a
      // study closed with no published_at ever recorded for it.
      await pool.query(`UPDATE opportunities SET published_at = NULL WHERE id = $1`, [created.body.id]);

      const reopened = await patch(admin, created.body.id, { status: "published" }).expect(200);

      // Close-with-Undo reopens it; the existing row's status is 'closed',
      // not 'draft', so this stays quiet too - the same rule, not a special
      // case carved out for this shape.
      expect(reopened.body.published_at).toBeNull();
    });

    it("does NOT re-stamp published_at on a reopen (closed->published)", async () => {
      const admin = await seedUser();
      const created = await create(admin, { ...CREATE_BASE, status: "published" }).expect(201);
      const originalPublishedAt = created.body.published_at;
      expect(originalPublishedAt).not.toBeNull();

      await patch(admin, created.body.id, { status: "closed" }).expect(200);
      const reopened = await patch(admin, created.body.id, { status: "published" }).expect(200);

      // Not merely "still non-null" - the EXACT original timestamp, proving
      // the reopen took the branch that leaves the column alone rather than
      // one that re-stamps it to a new, later NOW().
      expect(reopened.body.published_at).toBe(originalPublishedAt);
    });

    it("a duplicate never inherits the source study's published_at", async () => {
      const admin = await seedUser();
      const created = await create(admin, { ...CREATE_BASE, status: "published" }).expect(201);
      expect(created.body.published_at).not.toBeNull();

      const duplicated = await adminPost(admin, `/api/opportunities/${created.body.id}/duplicate`)
        .send()
        .expect(201);

      expect(duplicated.body.status).toBe("draft");
      expect(duplicated.body.published_at).toBeNull();
    });

    describe("who can see published_at on the route response", () => {
      it("anonymous GET (list and detail) never carries published_at", async () => {
        const admin = await seedUser();
        const created = await create(admin, { ...CREATE_BASE, status: "published" }).expect(201);

        const list = await request(listening(app)).get("/api/opportunities").expect(200);
        const found = (list.body as Array<Record<string, unknown>>).find((o) => o.id === created.body.id);
        expect(found).toBeDefined();
        expect(found).not.toHaveProperty("published_at");

        const detail = await request(listening(app))
          .get(`/api/opportunities/${created.body.id}`)
          .expect(200);
        expect(detail.body).not.toHaveProperty("published_at");
      });

      it("a signed-in participant's GET (list and detail) never carries published_at", async () => {
        const admin = await seedUser();
        const participant = await seedUser("employee");
        const created = await create(admin, { ...CREATE_BASE, status: "published" }).expect(201);

        const list = await request(listening(app))
          .get("/api/opportunities")
          .set("x-test-user-id", participant)
          .set("x-test-user-role", "employee")
          .expect(200);
        const found = (list.body as Array<Record<string, unknown>>).find((o) => o.id === created.body.id);
        expect(found).toBeDefined();
        expect(found).not.toHaveProperty("published_at");

        const detail = await request(listening(app))
          .get(`/api/opportunities/${created.body.id}`)
          .set("x-test-user-id", participant)
          .set("x-test-user-role", "employee")
          .expect(200);
        expect(detail.body).not.toHaveProperty("published_at");
      });

      it("an admin's GET (list and detail) still carries published_at", async () => {
        const admin = await seedUser();
        const created = await create(admin, { ...CREATE_BASE, status: "published" }).expect(201);

        const list = await adminGet(admin, "/api/opportunities").expect(200);
        const found = (list.body as Array<Record<string, unknown>>).find((o) => o.id === created.body.id);
        expect(found).toBeDefined();
        expect(found?.published_at).toBe(created.body.published_at);

        const detail = await adminGet(admin, `/api/opportunities/${created.body.id}`).expect(200);
        expect(detail.body.published_at).toBe(created.body.published_at);
      });
    });
  }
);
