import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * THE PARTICIPANT'S OWN ROLES/SKILLS PROFILE, AGAINST A REAL DATABASE.
 *
 * profile_roles is a structured JSONB array on the user row, using the SAME
 * vocabulary as an opportunity's target_roles, so browse can match a study to a
 * viewer by intersection. The properties that need a real column rather than a
 * mocked pool: it survives the migration as JSONB and reads back as a JS array;
 * the PATCH write path serialises/clears correctly; the validator's caps and
 * dedupe reach storage; and - the security seam - it is SELF-ONLY, appearing on
 * the caller's own /api/me and nowhere else.
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

async function seedUser(role = "employee"): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, 'User', $2, $3)`,
    [id, `user-${id}@example.com`, role]
  );
  return id;
}

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

const getMe = (userId: string, role = "employee") =>
  request(listening(app))
    .get("/api/me")
    .set("x-test-user-id", userId)
    .set("x-test-user-role", role);

const patchProfile = (userId: string, body: Record<string, unknown>, role = "employee") =>
  request(listening(app))
    .patch("/api/me/profile")
    .set("x-test-user-id", userId)
    .set("x-test-user-role", role)
    .send(body);

const getOpportunityAsParticipant = (opportunityId: string, userId: string) =>
  request(listening(app))
    .get(`/api/opportunities/${opportunityId}`)
    .set("x-test-user-id", userId);

describe.skipIf(skipDbTests)("participant profile_roles against real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("profile-roles");
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-profile-roles-constant-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();

    const { pool: appPool } = await import("../../config");
    pool = appPool;

    const apiRouter = (await import("../api")).default;
    const { errorHandler } = await import("../../utils/errorHandler");
    const expressModule = (await import("express")).default;

    app = expressModule();
    app.use(expressModule.json());
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id");
      const role = req.header("x-test-user-role") ?? "employee";
      if (userId) {
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id: userId, name: "Test", email: `${userId}@example.com`, role },
        };
      }
      next();
    });
    app.use("/api", apiRouter);
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

  describe("the /api/me read", () => {
    it("returns an empty array when no profile is set", async () => {
      const user = await seedUser();
      const me = await getMe(user).expect(200);
      expect(me.body.profile_roles).toEqual([]);
    });

    it("returns the stored roles as a JS array", async () => {
      const user = await seedUser();
      await patchProfile(user, { profile_roles: ["Product Manager", "Jira admin"] }).expect(200);

      const me = await getMe(user).expect(200);
      expect(me.body.profile_roles).toEqual(["Product Manager", "Jira admin"]);
    });

    it("reflects an edit made in the same session immediately (fresh read, not a stale snapshot)", async () => {
      const user = await seedUser();
      await patchProfile(user, { profile_roles: ["Designer"] }).expect(200);
      expect((await getMe(user).expect(200)).body.profile_roles).toEqual(["Designer"]);

      await patchProfile(user, { profile_roles: ["QA Engineer"] }).expect(200);
      expect((await getMe(user).expect(200)).body.profile_roles).toEqual(["QA Engineer"]);
    });
  });

  describe("the PATCH write path", () => {
    it("stores the roles and reads them back", async () => {
      const user = await seedUser();
      const res = await patchProfile(user, {
        profile_roles: ["Product Manager", "ScriptRunner admin"],
      }).expect(200);
      expect(res.body.profile_roles).toEqual(["Product Manager", "ScriptRunner admin"]);
    });

    it("trims and dedupes before storing", async () => {
      const user = await seedUser();
      const res = await patchProfile(user, {
        profile_roles: ["  Jira admin  ", "jira admin", "Designer"],
      }).expect(200);
      expect(res.body.profile_roles).toEqual(["Jira admin", "Designer"]);
    });

    it("clears the profile when set to null", async () => {
      const user = await seedUser();
      await patchProfile(user, { profile_roles: ["Product Manager"] }).expect(200);
      const res = await patchProfile(user, { profile_roles: null }).expect(200);
      expect(res.body.profile_roles).toEqual([]);
      expect((await getMe(user).expect(200)).body.profile_roles).toEqual([]);
    });

    it("clears the profile when set to an empty list", async () => {
      const user = await seedUser();
      await patchProfile(user, { profile_roles: ["Product Manager"] }).expect(200);
      const res = await patchProfile(user, { profile_roles: [] }).expect(200);
      expect(res.body.profile_roles).toEqual([]);
    });

    it("refuses more than 10 roles", async () => {
      const user = await seedUser();
      const eleven = Array.from({ length: 11 }, (_, i) => `Role ${i}`);
      await patchProfile(user, { profile_roles: eleven }).expect(400);
    });

    it("refuses a role longer than 60 characters", async () => {
      const user = await seedUser();
      await patchProfile(user, { profile_roles: ["a".repeat(61)] }).expect(400);
    });

    it("refuses an unexpected field (strict body)", async () => {
      const user = await seedUser();
      await patchProfile(user, {
        profile_roles: ["Designer"],
        other_user_id: crypto.randomUUID(),
      }).expect(400);
    });

    it("requires authentication", async () => {
      await request(listening(app))
        .patch("/api/me/profile")
        .send({ profile_roles: ["Designer"] })
        .expect(401);
    });
  });

  describe("the self-only security seam", () => {
    // Positive control: the read CAN see the field when it is the caller's own.
    // Without this, the absence assertions below could pass simply because the
    // read is broken and never returns profile_roles for anyone.
    it("POSITIVE CONTROL: a user can read their OWN profile_roles", async () => {
      const user = await seedUser();
      await patchProfile(user, { profile_roles: ["Product Manager"] }).expect(200);
      const me = await getMe(user).expect(200);
      expect(me.body.profile_roles).toEqual(["Product Manager"]);
    });

    it("never exposes user A's profile on user B's /api/me", async () => {
      const userA = await seedUser();
      const userB = await seedUser();
      await patchProfile(userA, { profile_roles: ["Product Manager", "Jira admin"] }).expect(200);

      const meB = await getMe(userB).expect(200);
      expect(meB.body.profile_roles).toEqual([]);
      expect(meB.body.id).toBe(userB);
    });

    it("user B's PATCH writes only user B's row, never user A's", async () => {
      const userA = await seedUser();
      const userB = await seedUser();
      await patchProfile(userA, { profile_roles: ["Product Manager"] }).expect(200);

      await patchProfile(userB, { profile_roles: ["Designer"] }).expect(200);

      // A untouched by B's write, B holds its own.
      expect((await getMe(userA).expect(200)).body.profile_roles).toEqual(["Product Manager"]);
      expect((await getMe(userB).expect(200)).body.profile_roles).toEqual(["Designer"]);
    });

    it("never appears on an opportunity payload the profile-owner published", async () => {
      const owner = await seedUser("researcher_admin");
      await patchProfile(owner, { profile_roles: ["Product Manager"] }, "researcher_admin").expect(200);
      const opportunity = await seedPublishedOpportunity({
        ownerId: owner,
        targetRoles: ["Designer"],
      });

      const viewer = await seedUser();
      const read = await getOpportunityAsParticipant(opportunity, viewer).expect(200);
      // The study's advertised audience is public; the owner's PRIVATE profile is not.
      expect(read.body.target_roles).toEqual(["Designer"]);
      expect(read.body.profile_roles).toBeUndefined();
      expect(JSON.stringify(read.body)).not.toContain("profile_roles");
    });
  });
});
