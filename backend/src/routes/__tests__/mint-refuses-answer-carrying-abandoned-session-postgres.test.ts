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
 * ONE ACCOUNT CANNOT PILE UP ANSWER-CARRYING ABANDONED SESSIONS
 * (cto/AdaptaLabs#155, part 2).
 *
 * Steps: mint a survey session, answer at least one question, post
 * `session_abandoned`, then mint again. Before this fix, `abandoned` was
 * unconditionally DEAD (`terminalUnansweredRuntimeStates` in state-model.ts),
 * so the second mint saw no in-flight session and started a fresh one - the
 * same outcome as a participant who had never begun. Nothing bounded the
 * repeat except the rate limiters (20 mints/min, 120 runtime writes/min),
 * which slow it, not stop it. That is the root cause behind the answer-length
 * heap risk `.max()` bounds fix elsewhere (cto/AdaptaLabs#152, shipped !510),
 * and it separately lets one participant push a study's session count toward
 * the 200,000-row CSV export ceiling (`MAX_CSV_PARTICIPANTS`).
 *
 * `createSession` is stubbed, exactly as the neighbouring
 * mint-refuses-a-closed-study suite stubs it: the refusal under test happens
 * entirely inside the resume lookup, before `createSession` would ever run,
 * so each test states plainly whether a fresh mint was reached.
 */
const execFileAsync = promisify(execFile);
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";
const migrateScript = path.resolve(__dirname, "../../../scripts/firsthand-migrate.mjs");

/** The refusal under test, spelled as a literal so a reworded route fails here by name. */
const ABANDONED_WITH_ANSWERS_REFUSAL =
  "You started this and abandoned it before finishing, so it cannot be restarted.";

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

async function seedStudy(): Promise<string> {
  const id = `study_${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO firsthand.studies (id, title, intro_text, consent_text, status, kind)
     VALUES ($1, 'Abandoned-session mint fixture', 'Intro', 'Consent', 'launched', 'survey')`,
    [id]
  );
  return id;
}

/**
 * A single question on the study, so `seedResponse` below has a real
 * `(study_id, step_id)` pair to reference - `participant_responses_step_fkey`
 * (migration 0015) requires one whenever `study_id` is set, and
 * `participant_responses_detached_together` requires `study_id` whenever
 * `step_id` is set.
 */
async function seedStep(studyId: string, stepId = "q1"): Promise<void> {
  await pool.query(
    `INSERT INTO firsthand.study_steps (id, study_id, step_order, type, prompt, is_required)
     VALUES ($1, $2, 1, 'open_text', 'How is it going?', false)`,
    [stepId, studyId]
  );
}

async function seedOpportunity(ownerId: string, studyId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities
       (id, type, title, purpose_one_liner, owner_user_id, status, delivery_mode, firsthand_study_id)
     VALUES ($1, 'survey', 'Abandoned-session mint opportunity',
             'Proving the mint route refuses an answer-carrying abandoned session', $2,
             'published', 'native', $3)`,
    [id, ownerId, studyId]
  );
  return id;
}

/**
 * A runtime session this participant already holds, in the given status, with
 * a live (not-yet-expired) token - matching `seedInFlightSurveySession` in
 * the neighbouring closed-study suite, minus the fields this suite does not
 * exercise (deadline/expiry), which stay at production-shaped defaults.
 */
async function seedSession(opts: {
  opportunityId: string;
  participantId: string;
  token: string;
  sessionStatus: string;
}): Promise<string> {
  const sessionId = `session_${crypto.randomUUID()}`;
  const sessionPayload = JSON.stringify({
    session: { expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
  });

  await pool.query(
    `INSERT INTO firsthand.runtime_sessions
       (session_id, token, study_id, study_title, participant_id, participant_display_name,
        session_status, transcript_status, microphone_permission, screen_permission,
        recording_status, upload_status, steps, opportunity_id,
        logical_session_id, attempt_number, created_via, session_payload)
     VALUES ($1, $2, 'study', 'Study', $3, 'Participant',
             $4, 'not_requested', 'not_requested', 'not_requested',
             'not_started', 'not_started', '[]'::jsonb, $5,
             $6, 1, 'manual', $7::jsonb)`,
    [
      sessionId,
      opts.token,
      opts.participantId,
      opts.sessionStatus,
      opts.opportunityId,
      crypto.randomUUID(),
      sessionPayload,
    ]
  );

  return sessionId;
}

/** A single answered question against the given session, referencing the study's own step. */
async function seedResponse(sessionId: string, studyId: string, stepId = "q1"): Promise<void> {
  await pool.query(
    `INSERT INTO firsthand.participant_responses
       (id, session_id, study_id, step_id, step_type, response_payload, saved_at)
     VALUES ($1, $2, $3, $4, 'open_text', $5::jsonb, NOW())`,
    [crypto.randomUUID(), sessionId, studyId, stepId, JSON.stringify({ text: "Going well" })]
  );
}

function mintSurvey(opportunityId: string, userId: string, role = "employee") {
  return request(listening(app))
    .post(`/api/opportunities/${opportunityId}/survey-session`)
    .set("x-test-user-id", userId)
    .set("x-test-user-role", role)
    .send({});
}

describe.skipIf(skipDbTests)("mint refuses an answer-carrying abandoned session", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("abandoned-session-mint");
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-abandoned-session-mint-not-a-real-secret"; // gitleaks:allow
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
    await pool.query(
      "TRUNCATE firsthand.participant_responses, firsthand.runtime_sessions, firsthand.studies CASCADE"
    );
    await pool.query("TRUNCATE sessions, opportunities, users CASCADE");
  });

  it("refuses a fresh mint when the participant's most recent session is abandoned and holds an answer", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    await seedStep(study);
    const opportunity = await seedOpportunity(owner, study);
    const sessionId = await seedSession({
      opportunityId: opportunity,
      participantId: participant,
      token: "tok_abandoned_answered",
      sessionStatus: "abandoned",
    });
    await seedResponse(sessionId, study);

    const response = await mintSurvey(opportunity, participant).expect(409);
    expect(response.body.error).toBe(ABANDONED_WITH_ANSWERS_REFUSAL);
  });

  /*
   * THE CONTROL: an abandoned session that never received an answer still
   * mints fresh, exactly as it did before this fix - the same DEAD case
   * `mint-refuses-a-closed-study-postgres.test.ts` already pins
   * (`it.each(["abandoned", "failed"])`). Without this arm, a check that
   * always refused an abandoned session regardless of `hasResponses` would
   * pass the test above for the wrong reason.
   */
  it("still mints a fresh session when the abandoned session never received an answer", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    const opportunity = await seedOpportunity(owner, study);
    await seedSession({
      opportunityId: opportunity,
      participantId: participant,
      token: "tok_abandoned_unanswered",
      sessionStatus: "abandoned",
    });

    const response = await mintSurvey(opportunity, participant).expect(200);
    expect(response.body.session_url).toBe("https://cortex.example.com/survey/tok_minted");
  });

  it("does not refuse a different participant's fresh mint on the same study", async () => {
    const owner = await seedUser("researcher_admin");
    const abandoner = await seedUser();
    const freshParticipant = await seedUser();
    const study = await seedStudy();
    await seedStep(study);
    const opportunity = await seedOpportunity(owner, study);
    const sessionId = await seedSession({
      opportunityId: opportunity,
      participantId: abandoner,
      token: "tok_other_participant_abandoned",
      sessionStatus: "abandoned",
    });
    await seedResponse(sessionId, study);

    const response = await mintSurvey(opportunity, freshParticipant).expect(200);
    expect(response.body.session_url).toBe("https://cortex.example.com/survey/tok_minted");
  });

  it("still refuses an answered (not abandoned) session with the pre-existing 409, unchanged", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    await seedStep(study);
    const opportunity = await seedOpportunity(owner, study);
    const sessionId = await seedSession({
      opportunityId: opportunity,
      participantId: participant,
      token: "tok_completed",
      sessionStatus: "completed",
    });
    await seedResponse(sessionId, study);

    const response = await mintSurvey(opportunity, participant).expect(409);
    expect(response.body.error).toBe("You have already answered this");
  });
});
