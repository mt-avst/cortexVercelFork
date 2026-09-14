import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * THE "SHOW ALL RESEARCHERS" TOGGLE ON THE STUDIES TABLE (Decision 2), AGAINST A
 * REAL DATABASE.
 *
 * `GET /api/opportunities` shows an admin every researcher's studies today. The
 * toggle scopes the table to the caller's own studies when it is OFF
 * (`?scope=mine`) and widens to every researcher when it is ON (`?scope=all`);
 * absent scope keeps the current all-researchers behaviour so no other caller
 * changes. A real Postgres because the whole point is WHICH rows the
 * `owner_user_id = $n` predicate keeps - a mock returns whatever it is queued,
 * and cannot tell a scoped list from an unscoped one.
 *
 * Runs in CI's `test-backend-db` (`npx vitest run postgres`); the no-DB vitest
 * job skips it via FIRSTHAND_SKIP_DB_TESTS.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

const ALICE = crypto.randomUUID();
const BOB = crypto.randomUUID();
const ROOT = crypto.randomUUID();

async function seedUser(id: string, role: "researcher_admin" | "superadmin"): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, $2, $3, $4)`,
    [id, `User ${id.slice(0, 6)}`, `${id}@example.com`, role]
  );
}

async function seedStudy(ownerId: string, title: string): Promise<void> {
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
     VALUES ($1, 'poll', $2,
             'Proving the owner-scope toggle against a real database', $3, 'published')`,
    [crypto.randomUUID(), title, ownerId]
  );
}

const listAs = (
  callerId: string,
  role: "researcher_admin" | "superadmin",
  scope?: string
) => {
  const query = scope ? `?scope=${scope}` : "";
  return request(listening(app))
    .get(`/api/opportunities${query}`)
    .set("x-test-user-id", callerId)
    .set("x-test-user-role", role);
};

const titles = (body: unknown): string[] =>
  (body as Array<{ title: string }>).map((row) => row.title).sort();

describe.skipIf(skipDbTests)(
  "the studies table owner-scope toggle, against a real Postgres",
  () => {
    beforeAll(async () => {
      postgres = await startTestPostgres("opportunities-list-owner-scope");

      process.env.DATABASE_URL = postgres.connectionString;
      process.env.SESSION_SECRET ||=
        "vitest-postgres-owner-scope-constant-not-a-real-secret"; // gitleaks:allow
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
      // Stands in for the session middleware: optionalAuth reads req.session.user
      // and withLiveRoleIfPresent re-reads the role LIVE from the users table, so
      // each caller is seeded with the role it claims here.
      app.use((req, _res, next) => {
        const userId = req.header("x-test-user-id");
        const role = req.header("x-test-user-role");
        if (userId) {
          (req as unknown as { session: { user: unknown } }).session = {
            user: { id: userId, name: "T", email: `${userId}@example.com`, role }
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
      await seedUser(ALICE, "researcher_admin");
      await seedUser(BOB, "researcher_admin");
      await seedUser(ROOT, "superadmin");
      await seedStudy(ALICE, "Alice study");
      await seedStudy(BOB, "Bob study");
      await seedStudy(ROOT, "Root study");
    });

    it("scopes the table to the caller's own studies at scope=mine", async () => {
      const res = await listAs(ALICE, "researcher_admin", "mine").expect(200);
      expect(titles(res.body)).toEqual(["Alice study"]);
    });

    it("shows every researcher's studies at scope=all", async () => {
      const res = await listAs(ALICE, "researcher_admin", "all").expect(200);
      expect(titles(res.body)).toEqual(["Alice study", "Bob study", "Root study"]);
    });

    it("shows every researcher's studies when no scope is named, as it does today", async () => {
      const res = await listAs(ALICE, "researcher_admin").expect(200);
      expect(titles(res.body)).toEqual(["Alice study", "Bob study", "Root study"]);
    });

    it("narrows even a superadmin to their own studies at scope=mine", async () => {
      const res = await listAs(ROOT, "superadmin", "mine").expect(200);
      expect(titles(res.body)).toEqual(["Root study"]);
    });

    it("refuses a repeated scope parameter rather than guessing", async () => {
      await request(listening(app))
        .get("/api/opportunities?scope=mine&scope=all")
        .set("x-test-user-id", ALICE)
        .set("x-test-user-role", "researcher_admin")
        .expect(400);
    });
  }
);
