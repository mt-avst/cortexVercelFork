import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * ROLES/SKILLS WANTED, AGAINST A REAL DATABASE.
 *
 * target_roles is a structured, DISPLAY-ONLY JSONB array on the opportunity: the
 * audience a study advertises so the right people self-select. It describes; the
 * screener gates. The properties that need a real column rather than the mocked
 * pool: it survives the migration as JSONB and reads back as a JS array, the
 * create and PATCH write paths serialise it correctly, the validator's caps and
 * dedupe reach storage, and - because it is PUBLIC - it passes through the
 * participant serialiser untouched (unlike the screener, which is redacted).
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

vi.mock("../../services/email", () => ({
  __esModule: true,
  default: { sendEmail: vi.fn(async () => ({ success: true, messageId: "test" })) },
  EmailService: {
    getBookingConfirmationTemplate: vi.fn(() => ({})),
    getAdminNotificationTemplate: vi.fn(() => ({})),
  },
}));

vi.mock("../../services/calendar", () => ({
  __esModule: true,
  default: {
    createEvent: vi.fn(async () => ({ success: true, eventId: "evt" })),
    updateEvent: vi.fn(async () => ({ success: true })),
    deleteEvent: vi.fn(async () => ({ success: true })),
  },
}));

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

async function seedUser(role = "researcher_admin"): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, 'User', $2, $3)`,
    [id, `user-${id}@example.com`, role]
  );
  return id;
}

/** A published opportunity written directly, to test the read/serialiser paths. */
async function seedPublishedOpportunity(opts: {
  ownerId: string;
  targetRoles?: string[] | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status, delivery_mode, target_roles)
     VALUES ($1, 'test', 'Roles opportunity', 'Advertising an audience', $2, 'published', 'external', $3::jsonb)`,
    [id, opts.ownerId, opts.targetRoles ? JSON.stringify(opts.targetRoles) : null]
  );
  return id;
}

const CREATE_BODY = {
  type: "test",
  title: "A study that advertises its audience",
  purpose_one_liner: "So the right people self-select before booking",
  delivery_mode: "external" as const,
};

const create = (userId: string, body: Record<string, unknown>) =>
  request(listening(app))
    .post("/api/opportunities")
    .set("x-test-user-id", userId)
    .set("x-test-user-role", "researcher_admin")
    .send(body);

const patch = (opportunityId: string, userId: string, body: Record<string, unknown>) =>
  request(listening(app))
    .patch(`/api/opportunities/${opportunityId}`)
    .set("x-test-user-id", userId)
    .set("x-test-user-role", "researcher_admin")
    .send(body);

const getAsAdmin = (opportunityId: string, userId: string) =>
  request(listening(app))
    .get(`/api/opportunities/${opportunityId}`)
    .set("x-test-user-id", userId)
    .set("x-test-user-role", "researcher_admin");

const getAsParticipant = (opportunityId: string, userId: string) =>
  request(listening(app))
    .get(`/api/opportunities/${opportunityId}`)
    .set("x-test-user-id", userId);

describe.skipIf(skipDbTests)("roles/skills wanted against real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("target-roles");
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-target-roles-constant-not-a-real-secret"; // gitleaks:allow
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
      const role = req.header("x-test-user-role") ?? "employee";
      if (userId) {
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id: userId, name: "Test", email: "t@example.com", role },
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
    await pool.query("TRUNCATE opportunities, users CASCADE");
  });

  describe("the create write path", () => {
    it("stores the roles and reads them back as a JS array on the admin payload", async () => {
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        target_roles: ["Product Manager", "ScriptRunner admin"],
      }).expect(201);

      expect(created.body.target_roles).toEqual(["Product Manager", "ScriptRunner admin"]);

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.target_roles).toEqual(["Product Manager", "ScriptRunner admin"]);
    });

    it("trims and dedupes through the route before storing", async () => {
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        target_roles: ["  Jira admin  ", "jira admin", "Designer"],
      }).expect(201);

      expect(created.body.target_roles).toEqual(["Jira admin", "Designer"]);
    });

    it("stores null when no roles are supplied", async () => {
      const admin = await seedUser();
      const created = await create(admin, CREATE_BODY).expect(201);
      expect(created.body.target_roles ?? null).toBeNull();
    });

    it("stores null for an empty list", async () => {
      const admin = await seedUser();
      const created = await create(admin, { ...CREATE_BODY, target_roles: [] }).expect(201);
      expect(created.body.target_roles ?? null).toBeNull();
    });

    it("refuses more than 10 roles", async () => {
      const admin = await seedUser();
      const eleven = Array.from({ length: 11 }, (_, i) => `Role ${i}`);
      await create(admin, { ...CREATE_BODY, target_roles: eleven }).expect(400);
    });

    it("refuses a role longer than 60 characters", async () => {
      const admin = await seedUser();
      await create(admin, { ...CREATE_BODY, target_roles: ["a".repeat(61)] }).expect(400);
    });
  });

  describe("the update write path", () => {
    it("replaces the roles wholesale", async () => {
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        target_roles: ["Product Manager"],
      }).expect(201);

      await patch(created.body.id, admin, { target_roles: ["Designer", "QA Engineer"] }).expect(200);

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.target_roles).toEqual(["Designer", "QA Engineer"]);
    });

    it("clears the roles when set to null", async () => {
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        target_roles: ["Product Manager"],
      }).expect(201);

      await patch(created.body.id, admin, { target_roles: null }).expect(200);

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.target_roles ?? null).toBeNull();
    });

    it("clears the roles when set to an empty list", async () => {
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        target_roles: ["Product Manager"],
      }).expect(201);

      await patch(created.body.id, admin, { target_roles: [] }).expect(200);

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.target_roles ?? null).toBeNull();
    });

    it("refuses an over-long role on update", async () => {
      const admin = await seedUser();
      const created = await create(admin, CREATE_BODY).expect(201);
      await patch(created.body.id, admin, { target_roles: ["a".repeat(61)] }).expect(400);
    });
  });

  describe("the participant payload", () => {
    it("carries the roles unredacted to a participant (it is public, unlike the screener)", async () => {
      const owner = await seedUser();
      const participant = await seedUser("employee");
      const opportunity = await seedPublishedOpportunity({
        ownerId: owner,
        targetRoles: ["Product Manager", "ScriptRunner admin"],
      });

      const read = await getAsParticipant(opportunity, participant).expect(200);
      expect(read.body.target_roles).toEqual(["Product Manager", "ScriptRunner admin"]);
    });
  });
});
