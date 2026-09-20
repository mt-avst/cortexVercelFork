import { execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * THE MINT ROUTES REFUSE A STUDY THAT HAS CLOSED, AGAINST A REAL DATABASE
 * (cto/AdaptaLabs#129).
 *
 * The participant surfaces refused a closed study CLIENT-SIDE only: the Start
 * button and the browse row both read `getClosingTime` and go quiet once it is
 * past, while `POST /:id/recorded-study-session` and `POST /:id/survey-session`
 * asked only whether the opportunity was `published`. A stale tab, a replayed
 * request or a script therefore still minted a session for a study the UI
 * called closed - measured before the fix as a 200 carrying a real
 * `session_url` for an opportunity whose `end_date` was a day in the past.
 *
 * WHY REAL POSTGRES (mandatory): the closing time is computed in the SELECT,
 * against the database clock, and its fallback arm is a MAX over `sessions`.
 * The jest suite next door mocks the pool, so it can only feed the handler a
 * row it wrote itself - it cannot see the query that derives the fact, which is
 * the whole of the fix.
 *
 * `createSession` is the one thing stubbed. Everything the refusal depends on -
 * the row, the sessions, `NOW()` - is real; the stub only means a mint that is
 * NOT refused ends in a session URL rather than in a live runtime session, so
 * each test states plainly whether the study was startable.
 */
const execFileAsync = promisify(execFile);
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";
const migrateScript = path.resolve(__dirname, "../../../scripts/firsthand-migrate.mjs");

/** The refusal under test, spelled as a literal so a reworded route fails here by name. */
const CLOSED_REFUSAL = "Study has closed";
/** Its neighbour, the pre-existing refusal this one is modelled on. */
const NOT_PUBLISHED_REFUSAL = "Study is not published";

vi.mock("../../firsthand/session-create", () => ({
  createSession: vi.fn(async () => ({
    ok: true,
    session: {
      session_id: "session_minted",
      session_token: "tok_minted",
      expires_at: "2026-12-31T00:00:00.000Z",
    },
  })),
}));

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

async function seedUser(role = "employee"): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, name, email, role) VALUES ($1, 'User', $2, $3)`, [
    id,
    `user-${id}@example.com`,
    role,
  ]);
  return id;
}

/** A launched study of the given kind, so the linked-study re-check passes. */
async function seedStudy(kind: "recorded" | "survey"): Promise<string> {
  const id = `study_${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO firsthand.studies (id, title, intro_text, consent_text, status, kind)
     VALUES ($1, 'Closed-study mint fixture', 'Intro', 'Consent', 'launched', $2)`,
    [id, kind]
  );
  return id;
}

async function seedOpportunity(opts: {
  ownerId: string;
  type: string;
  deliveryMode?: string;
  status?: string;
  studyId?: string | null;
  /** SQL interval added to NOW(), or null for no end date at all. */
  endDateOffset?: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities
       (id, type, title, purpose_one_liner, owner_user_id, status, delivery_mode,
        firsthand_study_id, end_date)
     VALUES ($1, $2, 'Closed-study mint opportunity',
             'Proving the mint routes refuse a study that has closed', $3, $4, $5, $6,
             CASE WHEN $7::text IS NULL THEN NULL ELSE NOW() + $7::interval END)`,
    [
      id,
      opts.type,
      opts.ownerId,
      opts.status ?? "published",
      opts.deliveryMode ?? "external",
      opts.studyId ?? null,
      opts.endDateOffset ?? null,
    ]
  );
  return id;
}

/** One slot, placed relative to NOW() by the given SQL interval. */
async function seedSession(opportunityId: string, startOffset: string, endOffset: string): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
     VALUES ($1, $2, NOW() + $3::interval, NOW() + $4::interval, 1, 0)`,
    [crypto.randomUUID(), opportunityId, startOffset, endOffset]
  );
}

function mintRecorded(opportunityId: string, userId: string, role = "employee") {
  return request(listening(app))
    .post(`/api/opportunities/${opportunityId}/recorded-study-session`)
    .set("x-test-user-id", userId)
    .set("x-test-user-role", role)
    .send({});
}

function mintSurvey(opportunityId: string, userId: string, role = "employee") {
  return request(listening(app))
    .post(`/api/opportunities/${opportunityId}/survey-session`)
    .set("x-test-user-id", userId)
    .set("x-test-user-role", role)
    .send({});
}

describe.skipIf(skipDbTests)("mint routes refuse a study that has closed", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("closed-study-mint");
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-closed-study-mint-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";
    process.env.FRONTEND_URL = "https://cortex.example.com";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();
    // The firsthand runtime schema is migrated separately from the main schema.
    await execFileAsync("node", [migrateScript], {
      env: { ...process.env, DATABASE_URL: postgres.connectionString },
      timeout: 60_000,
    });

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
    await pool.query("TRUNCATE firsthand.runtime_sessions, firsthand.studies CASCADE");
    await pool.query("TRUNCATE sessions, opportunities, users CASCADE");
  });

  describe("recorded study mint", () => {
    it("refuses a published study whose end date has passed", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const study = await seedStudy("recorded");
      const opportunity = await seedOpportunity({
        ownerId: owner,
        type: "unmoderated",
        studyId: study,
        endDateOffset: "-1 day",
      });

      const response = await mintRecorded(opportunity, participant).expect(403);
      expect(response.body.error).toBe(CLOSED_REFUSAL);
    });

    it("still mints a published study whose end date is ahead", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const study = await seedStudy("recorded");
      const opportunity = await seedOpportunity({
        ownerId: owner,
        type: "unmoderated",
        studyId: study,
        endDateOffset: "1 day",
      });

      const response = await mintRecorded(opportunity, participant).expect(200);
      expect(response.body.session_url).toBe("https://cortex.example.com/session/tok_minted");
    });

    it("still mints a published study that carries no end date and no slots", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const study = await seedStudy("recorded");
      const opportunity = await seedOpportunity({
        ownerId: owner,
        type: "unmoderated",
        studyId: study,
        endDateOffset: null,
      });

      const response = await mintRecorded(opportunity, participant).expect(200);
      expect(response.body.session_url).toBe("https://cortex.example.com/session/tok_minted");
    });

    it("refuses an undated study once its last slot has finished", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const study = await seedStudy("recorded");
      const opportunity = await seedOpportunity({
        ownerId: owner,
        type: "unmoderated",
        studyId: study,
        endDateOffset: null,
      });
      await seedSession(opportunity, "-2 days", "-2 days 23 hours");
      await seedSession(opportunity, "-1 day", "-23 hours");

      const response = await mintRecorded(opportunity, participant).expect(403);
      expect(response.body.error).toBe(CLOSED_REFUSAL);
    });

    it("still mints an undated study while one slot is ahead", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const study = await seedStudy("recorded");
      const opportunity = await seedOpportunity({
        ownerId: owner,
        type: "unmoderated",
        studyId: study,
        endDateOffset: null,
      });
      await seedSession(opportunity, "-1 day", "-23 hours");
      await seedSession(opportunity, "1 day", "1 day 1 hour");

      const response = await mintRecorded(opportunity, participant).expect(200);
      expect(response.body.session_url).toBe("https://cortex.example.com/session/tok_minted");
    });

    it("lets the end date win over a slot that is still ahead", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const study = await seedStudy("recorded");
      const opportunity = await seedOpportunity({
        ownerId: owner,
        type: "unmoderated",
        studyId: study,
        endDateOffset: "-1 hour",
      });
      await seedSession(opportunity, "1 day", "1 day 1 hour");

      const response = await mintRecorded(opportunity, participant).expect(403);
      expect(response.body.error).toBe(CLOSED_REFUSAL);
    });

    it("refuses an admin too, exactly as the published check already does", async () => {
      const admin = await seedUser("researcher_admin");
      const study = await seedStudy("recorded");
      const closed = await seedOpportunity({
        ownerId: admin,
        type: "unmoderated",
        studyId: study,
        endDateOffset: "-1 day",
      });
      const draft = await seedOpportunity({
        ownerId: admin,
        type: "unmoderated",
        status: "draft",
        studyId: study,
        endDateOffset: "1 day",
      });

      // The neighbouring status check has never exempted an admin on this
      // route; the deadline check is deliberately no different, so the pair
      // reads the same way for the same caller.
      const draftResponse = await mintRecorded(draft, admin, "researcher_admin").expect(403);
      expect(draftResponse.body.error).toBe(NOT_PUBLISHED_REFUSAL);

      const closedResponse = await mintRecorded(closed, admin, "researcher_admin").expect(403);
      expect(closedResponse.body.error).toBe(CLOSED_REFUSAL);
    });
  });

  describe("native survey mint", () => {
    it("refuses a published survey whose end date has passed", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const study = await seedStudy("survey");
      const opportunity = await seedOpportunity({
        ownerId: owner,
        type: "survey",
        deliveryMode: "native",
        studyId: study,
        endDateOffset: "-1 day",
      });

      const response = await mintSurvey(opportunity, participant).expect(403);
      expect(response.body.error).toBe(CLOSED_REFUSAL);
    });

    it("still mints a published survey whose end date is ahead", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const study = await seedStudy("survey");
      const opportunity = await seedOpportunity({
        ownerId: owner,
        type: "survey",
        deliveryMode: "native",
        studyId: study,
        endDateOffset: "1 day",
      });

      const response = await mintSurvey(opportunity, participant).expect(200);
      expect(response.body.session_url).toBe("https://cortex.example.com/survey/tok_minted");
    });

    it("refuses an undated poll once its last slot has finished", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const study = await seedStudy("survey");
      const opportunity = await seedOpportunity({
        ownerId: owner,
        type: "poll",
        deliveryMode: "native",
        studyId: study,
        endDateOffset: null,
      });
      await seedSession(opportunity, "-1 day", "-23 hours");

      const response = await mintSurvey(opportunity, participant).expect(403);
      expect(response.body.error).toBe(CLOSED_REFUSAL);
    });
  });
});
