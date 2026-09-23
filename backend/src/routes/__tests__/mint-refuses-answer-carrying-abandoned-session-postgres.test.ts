import { execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * ONE ACCOUNT CANNOT PILE UP ANSWER-CARRYING ABANDONED SESSIONS
 * (cto/AdaptaLabs#155, part 2).
 *
 * Steps: mint a survey session, answer at least one question, end the session
 * without completing it, then mint again. Before #155's fix, a terminal,
 * unanswered status (`abandoned`/`failed`) was UNCONDITIONALLY treated as DEAD
 * - a fresh mint is normally exactly right for one - so the second mint saw no
 * in-flight session and started a fresh one, the same outcome as a participant
 * who had never begun. Nothing bounded the repeat except the rate limiters (20
 * mints/min, 120 runtime writes/min), which slow it, not stop it.
 *
 * REAL END-TO-END, NOT SEEDED ROWS, for the tests that exercise the refusal
 * itself: both routers (`/api/opportunities` and `/api/firsthand/session`) are
 * mounted together and `createSession` is NOT stubbed, so a "mint" really
 * mints, an "answer" really writes a `participant_responses` row through the
 * same validity checks a real participant's browser would hit, and an "end
 * event" really drives `applyRuntimeMutation` against the real row. This is
 * deliberate: review pass 1 on the first version of this fix found two gaps
 * (HIGH-1: only `session_abandoned` was checked, not the `session_failed` /
 * `upload_failed` events the SAME runtime route accepts just as readily;
 * HIGH-2: only the participant's MOST RECENT session was checked, so a second,
 * answer-free abandonment on top of a first, answer-carrying one slipped a
 * third mint through) that a seeded-row test had no way to catch, because
 * seeding a row by hand encodes an assumption about which fields matter
 * instead of proving it by driving the actual event that sets them.
 */
const execFileAsync = promisify(execFile);
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";
const migrateScript = path.resolve(__dirname, "../../../scripts/firsthand-migrate.mjs");

/** The refusal under test, spelled as a literal so a reworded route fails here by name. */
const UNFINISHED_SESSION_REFUSAL = "You already started this and it cannot be restarted from here.";
const UNFINISHED_SESSION_REFUSAL_CODE = "UNFINISHED_SESSION_HAS_RESPONSES";

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;
let resetParticipantRouteLimits: (userId: string) => void;
let resetRuntimeRouteLimits: (userId: string) => void;

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

/** A single open-text question, so a minted session has something to answer for real. */
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
             'Proving the mint route refuses an answer-carrying finished session', $2,
             'published', 'native', $3)`,
    [id, ownerId, studyId]
  );
  return id;
}

/**
 * A runtime session row written directly, bypassing the mint route - used for
 * exactly ONE test below (the "checks every row, not just the latest" case),
 * and deliberately not for anything else in this file.
 *
 * That test needs an OLDER, answer-carrying, terminal-unanswered session to
 * coexist with a NEWER, answer-free one for the same participant and
 * opportunity - and there is no way to reach that ordering through a live
 * sequential mint loop once this fix is in place: the moment the older
 * session is answered and abandoned, the very next real mint attempt is
 * refused, so a second, answer-free session can never be minted afterwards to
 * become the newer row. (That refusal is itself proof the fix works for the
 * single-threaded case - see the two real end-to-end tests above.) The only
 * way this row shape arises for real is the CONCURRENT race the ponytail
 * comment at the check site documents - two mints started before either
 * one's answer-then-abandon sequence commits - which is exactly what was
 * proven separately against a live burst of parallel mints. Seeding the rows
 * directly reproduces that end state deterministically, without depending on
 * timing, so this test can pin it as a real regression test rather than a
 * flaky race.
 */
async function seedTerminalSession(opts: {
  opportunityId: string;
  participantId: string;
  token: string;
  sessionStatus: string;
  createdAtOffset: string;
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
        logical_session_id, attempt_number, created_via, session_payload, created_at)
     VALUES ($1, $2, 'study', 'Study', $3, 'Participant',
             $4, 'not_requested', 'not_requested', 'not_requested',
             'not_started', 'not_started', '[]'::jsonb, $5,
             $6, 1, 'manual', $7::jsonb, NOW() + $8::interval)`,
    [
      sessionId,
      opts.token,
      opts.participantId,
      opts.sessionStatus,
      opts.opportunityId,
      crypto.randomUUID(),
      sessionPayload,
      opts.createdAtOffset,
    ]
  );

  return sessionId;
}

async function seedResponseRow(sessionId: string, studyId: string, stepId = "q1"): Promise<void> {
  await pool.query(
    `INSERT INTO firsthand.participant_responses
       (id, session_id, study_id, step_id, step_type, response_payload, saved_at)
     VALUES ($1, $2, $3, $4, 'open_text', $5::jsonb, NOW())`,
    [crypto.randomUUID(), sessionId, studyId, stepId, JSON.stringify({ text: "An answer" })]
  );
}

function mintSurvey(opportunityId: string, userId: string) {
  return request(listening(app))
    .post(`/api/opportunities/${opportunityId}/survey-session`)
    .set("x-test-user-id", userId)
    .set("x-test-user-role", "employee")
    .send({});
}

function tokenFromSessionUrl(sessionUrl: string): string {
  const token = sessionUrl.split("/").pop();
  if (!token) throw new Error(`Could not parse a token from session_url: ${sessionUrl}`);
  return token;
}

/** Mints a real session and returns its token, asserting the mint itself succeeded. */
async function mintAndGetToken(opportunityId: string, userId: string): Promise<string> {
  const response = await mintSurvey(opportunityId, userId).expect(200);
  return tokenFromSessionUrl(response.body.session_url);
}

/** Answers the seeded open_text step for real, through the runtime route's own validity checks. */
async function answerStep(token: string, userId: string, stepId = "q1", text = "An answer"): Promise<void> {
  await request(listening(app))
    .post(`/api/firsthand/session/${token}/runtime`)
    .set("x-test-user-id", userId)
    .set("x-test-user-role", "employee")
    .send({ type: "response", stepId, stepType: "open_text", responsePayload: { text } })
    .expect(200);
}

/** Posts a lifecycle-ending event for real, through the same route a participant's client hits. */
async function endSession(token: string, userId: string, eventType: string): Promise<void> {
  await request(listening(app))
    .post(`/api/firsthand/session/${token}/runtime`)
    .set("x-test-user-id", userId)
    .set("x-test-user-role", "employee")
    .send({ type: "event", eventType })
    .expect(200);
}

describe.skipIf(skipDbTests)("mint refuses an answer-carrying finished session", () => {
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

    const opportunitiesModule = await import("../opportunities");
    const opportunitiesRouter = opportunitiesModule.default;
    resetParticipantRouteLimits = opportunitiesModule.resetParticipantRouteLimits;
    const firsthandSessionModule = await import("../firsthand-session");
    const firsthandSessionRouter = firsthandSessionModule.default;
    resetRuntimeRouteLimits = firsthandSessionModule.resetRuntimeRouteLimits;
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
    app.use("/api/firsthand/session", firsthandSessionRouter);
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

  /*
   * HIGH-1 (review pass 1): every event the runtime route treats as
   * write-terminal, not just `session_abandoned`. `POST
   * /api/firsthand/session/:token/runtime` accepts `session_failed` and
   * `upload_failed` on a survey session exactly as it accepts
   * `session_abandoned` - all three land the session on a status
   * `FINISHED_SESSION_STATES` treats identically (write-immutable), and the
   * first version of this check only looked for the literal string
   * `'abandoned'`. Driven end to end so the actual event handler decides the
   * resulting status, not an assumption encoded into a seeded row.
   */
  it.each(["session_abandoned", "session_failed", "upload_failed"])(
    "refuses a fresh mint after answering and then posting %s",
    async (endEventType) => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const study = await seedStudy();
      await seedStep(study);
      const opportunity = await seedOpportunity(owner, study);
      resetParticipantRouteLimits(participant);
      resetRuntimeRouteLimits(participant);

      const firstToken = await mintAndGetToken(opportunity, participant);
      await answerStep(firstToken, participant);
      await endSession(firstToken, participant, endEventType);

      const secondMint = await mintSurvey(opportunity, participant).expect(409);
      expect(secondMint.body.error).toBe(UNFINISHED_SESSION_REFUSAL);
      expect(secondMint.body.code).toBe(UNFINISHED_SESSION_REFUSAL_CODE);
    }
  );

  /*
   * HIGH-2 (review pass 1): every session the participant holds for this
   * opportunity, not just the most recent one.
   *
   * Session A (older): terminal, answer-carrying. Session B (newer, and so
   * the LATEST row): terminal, answer-free. A check that reads only the
   * latest row sees B - clean - and lets a fresh mint through, exactly what
   * the unwidened version of this check did (proven separately under
   * concurrency: three rounds of three parallel mints produced six
   * answer-carrying abandoned sessions). The widened check scans every row
   * for the pair, sees A too, and refuses.
   *
   * Seeded directly rather than minted live - see `seedTerminalSession`'s own
   * docblock for why this exact ordering cannot be reached through a live
   * sequential mint loop once the fix is in place (the two E2E tests above
   * already prove that): this is the concurrent race's END STATE, reproduced
   * deterministically instead of depending on winning a race.
   */
  it("refuses a mint when an OLDER session carries an answer, even though the LATEST one does not", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    await seedStep(study);
    const opportunity = await seedOpportunity(owner, study);

    const sessionA = await seedTerminalSession({
      opportunityId: opportunity,
      participantId: participant,
      token: "tok_older_answered",
      sessionStatus: "abandoned",
      createdAtOffset: "-2 minutes",
    });
    await seedResponseRow(sessionA, study);
    await seedTerminalSession({
      opportunityId: opportunity,
      participantId: participant,
      token: "tok_newer_unanswered",
      sessionStatus: "abandoned",
      createdAtOffset: "-1 minute",
    });

    const mintAttempt = await mintSurvey(opportunity, participant).expect(409);
    expect(mintAttempt.body.error).toBe(UNFINISHED_SESSION_REFUSAL);
    expect(mintAttempt.body.code).toBe(UNFINISHED_SESSION_REFUSAL_CODE);
  });

  /*
   * THE CONTROL (review pass 1 M2): an abandoned session that never received
   * an answer still mints fresh - the narrowness this whole fix depends on.
   *
   * An unrelated study/session/answer is seeded FIRST and left alone, so
   * `firsthand.participant_responses` is non-empty for the whole test. A
   * mutation that collapsed the per-session `EXISTS` into "does this table
   * hold any row at all" would read that unrelated row and wrongly refuse
   * this mint - which an empty-table control cannot catch, because both the
   * correct query and that mutation answer "false" against an empty table for
   * the same wrong reason. This is the control review pass 1 proved could be
   * satisfied vacuously; the unrelated row is what makes it a real one.
   */
  it("still mints a fresh session when the abandoned session never received an answer, even with unrelated answers elsewhere in the table", async () => {
    const unrelatedOwner = await seedUser("researcher_admin");
    const unrelatedParticipant = await seedUser();
    const unrelatedStudy = await seedStudy();
    await seedStep(unrelatedStudy);
    const unrelatedOpportunity = await seedOpportunity(unrelatedOwner, unrelatedStudy);
    resetParticipantRouteLimits(unrelatedParticipant);
    resetRuntimeRouteLimits(unrelatedParticipant);
    const unrelatedToken = await mintAndGetToken(unrelatedOpportunity, unrelatedParticipant);
    await answerStep(unrelatedToken, unrelatedParticipant);
    await endSession(unrelatedToken, unrelatedParticipant, "session_abandoned");

    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    await seedStep(study);
    const opportunity = await seedOpportunity(owner, study);
    resetParticipantRouteLimits(participant);
    resetRuntimeRouteLimits(participant);

    const token = await mintAndGetToken(opportunity, participant);
    await endSession(token, participant, "session_abandoned");

    const secondMint = await mintSurvey(opportunity, participant).expect(200);
    expect(secondMint.body.session_url).not.toBe(`https://cortex.example.com/survey/${token}`);
  });

  /*
   * SCOPED TO THIS PARTICIPANT (review pass 1 M2): another participant's
   * answer-carrying abandoned session on the SAME opportunity buys this
   * participant nothing.
   *
   * `freshParticipant` holds their OWN answer-free abandoned session first,
   * so the check's query actually RUNS for them (a participant with zero
   * sessions short-circuits before the query, which is why the first version
   * of this test - giving the fresh participant no session at all - could not
   * have caught a broken participant_id filter). With their own row in place,
   * a query that dropped or widened the participant scope would pick up
   * `abandoner`'s answer-carrying session and wrongly refuse this mint.
   */
  it("does not refuse a participant's fresh mint over a DIFFERENT participant's answer-carrying abandoned session", async () => {
    const owner = await seedUser("researcher_admin");
    const abandoner = await seedUser();
    const freshParticipant = await seedUser();
    const study = await seedStudy();
    await seedStep(study);
    const opportunity = await seedOpportunity(owner, study);
    resetParticipantRouteLimits(abandoner);
    resetRuntimeRouteLimits(abandoner);
    resetParticipantRouteLimits(freshParticipant);
    resetRuntimeRouteLimits(freshParticipant);

    const abandonerToken = await mintAndGetToken(opportunity, abandoner);
    await answerStep(abandonerToken, abandoner);
    await endSession(abandonerToken, abandoner, "session_abandoned");

    const freshParticipantFirstToken = await mintAndGetToken(opportunity, freshParticipant);
    await endSession(freshParticipantFirstToken, freshParticipant, "session_abandoned");

    const freshParticipantSecondMint = await mintSurvey(opportunity, freshParticipant).expect(200);
    expect(freshParticipantSecondMint.body.session_url).not.toBe(
      `https://cortex.example.com/survey/${freshParticipantFirstToken}`
    );
  });

  it("still refuses an already-completed session with the pre-existing 409, unchanged", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    await seedStep(study);
    const opportunity = await seedOpportunity(owner, study);
    resetParticipantRouteLimits(participant);
    resetRuntimeRouteLimits(participant);

    const token = await mintAndGetToken(opportunity, participant);
    await answerStep(token, participant);
    await endSession(token, participant, "session_completed");

    const secondMint = await mintSurvey(opportunity, participant).expect(409);
    expect(secondMint.body.error).toBe("You have already answered this");
  });
});
