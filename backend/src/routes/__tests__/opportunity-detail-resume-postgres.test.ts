import crypto from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * THE PARTICIPANT DETAIL READ SERVES A CLOSED STUDY TO ITS OWN IN-FLIGHT
 * PARTICIPANT (cto/AdaptaLabs#129, HIGH-2's backend half).
 *
 * `GET /:id` answers 410 OPPORTUNITY_CLOSED to a non-admin for any `closed`
 * study - correct for almost everyone, and wrong for the one participant the
 * survey-session mint route's resume gate (mint-refuses-a-closed-study-
 * postgres.test.ts) now lets finish: the hourly sweep can close a study while
 * they are mid-survey, and a detail page that still 410s for them stands
 * between that participant and the Resume button the frontend renders from
 * `completion.inProgress`. This suite is the read half of that fix; the mint
 * suite is the write half. Both read `isInFlightRuntimeSession` through the
 * SAME `findParticipantSessionForOpportunity` row, so they cannot disagree
 * about who counts.
 *
 * WHY REAL POSTGRES: `inProgress` and the 200-vs-410 decision both depend on
 * `session_payload->'session'->>'expires_at'` compared against the database's
 * own `NOW()`, exactly like the mint suite's `has_closed`. A mocked-pool test
 * can only feed the handler a row it wrote itself; it cannot exercise the
 * query that derives the fact.
 */
const execFileAsync = promisify(execFile);
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";
const migrateScript = path.resolve(__dirname, "../../../scripts/firsthand-migrate.mjs");

const CLOSED_CODE = "OPPORTUNITY_CLOSED";
const NOT_OPEN_CODE = "OPPORTUNITY_NOT_OPEN";

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
     VALUES ($1, 'Detail-read fixture', 'Intro', 'Consent', 'launched', 'survey')`,
    [id]
  );
  return id;
}

async function seedOpportunity(opts: {
  ownerId: string;
  status?: string;
  studyId: string;
  endDateOffset?: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities
       (id, type, title, purpose_one_liner, owner_user_id, status, delivery_mode,
        firsthand_study_id, end_date)
     VALUES ($1, 'survey', 'Detail-read opportunity',
             'Proving the detail read exempts an in-flight participant', $2, $3, 'native', $4,
             CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() + $5::interval END)`,
    [id, opts.ownerId, opts.status ?? "published", opts.studyId, opts.endDateOffset ?? null]
  );
  return id;
}

/** A runtime session, keyed the same way the mint suite's fixture is. */
async function seedSurveySession(opts: {
  opportunityId: string;
  participantId: string;
  sessionStatus?: string;
  completedAt?: string | null;
  expiresInHours?: number | null;
}): Promise<void> {
  const expiresInHours = opts.expiresInHours === undefined ? 24 : opts.expiresInHours;
  const sessionPayload =
    expiresInHours === null
      ? null
      : JSON.stringify({
          session: {
            expires_at: new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString(),
          },
        });

  await pool.query(
    `INSERT INTO firsthand.runtime_sessions
       (session_id, token, study_id, study_title, participant_id, participant_display_name,
        session_status, transcript_status, microphone_permission, screen_permission,
        recording_status, upload_status, steps, opportunity_id,
        logical_session_id, attempt_number, created_via, session_payload, completed_at)
     VALUES ($1, $2, 'study', 'Study', $3, 'Participant',
             $4, 'not_requested', 'not_requested', 'not_requested',
             'not_started', 'not_started', '[]'::jsonb, $5,
             $6, 1, 'manual', $7::jsonb, $8)`,
    [
      `session_${crypto.randomUUID()}`,
      `tok_${crypto.randomUUID()}`,
      opts.participantId,
      opts.sessionStatus ?? "link_opened",
      opts.opportunityId,
      crypto.randomUUID(),
      sessionPayload,
      opts.completedAt ?? null,
    ]
  );
}

function getDetail(opportunityId: string, userId?: string, role = "employee") {
  const req = request(listening(app)).get(`/api/opportunities/${opportunityId}`);
  return userId ? req.set("x-test-user-id", userId).set("x-test-user-role", role) : req;
}

describe.skipIf(skipDbTests)("participant detail read exempts an in-flight participant from a closed study", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("opportunity-detail-resume");
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-opportunity-detail-resume-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";
    process.env.FRONTEND_URL = "https://cortex.example.com";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();
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

  it("serves a closed study at 200 with inProgress true for its own in-flight participant", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    const opportunity = await seedOpportunity({ ownerId: owner, studyId: study, status: "closed" });
    await seedSurveySession({ opportunityId: opportunity, participantId: participant });

    const response = await getDetail(opportunity, participant).expect(200);

    expect(response.body.completion).toEqual({
      completed: false,
      completedAt: null,
      inProgress: true,
    });
  });

  it("still answers 410 OPPORTUNITY_CLOSED for a closed study when the participant holds no session", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    const opportunity = await seedOpportunity({ ownerId: owner, studyId: study, status: "closed" });

    const response = await getDetail(opportunity, participant).expect(410);
    expect(response.body.code).toBe(CLOSED_CODE);
  });

  it("marks inProgress true on a still-PUBLISHED survey too, not only a closed one", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    const opportunity = await seedOpportunity({ ownerId: owner, studyId: study, status: "published" });
    await seedSurveySession({ opportunityId: opportunity, participantId: participant });

    const response = await getDetail(opportunity, participant).expect(200);

    expect(response.body.completion).toEqual({
      completed: false,
      completedAt: null,
      inProgress: true,
    });
  });

  it("does not let another participant's in-flight session open a closed study for this viewer", async () => {
    const owner = await seedUser("researcher_admin");
    const started = await seedUser();
    const viewer = await seedUser();
    const study = await seedStudy();
    const opportunity = await seedOpportunity({ ownerId: owner, studyId: study, status: "closed" });
    await seedSurveySession({ opportunityId: opportunity, participantId: started });

    const response = await getDetail(opportunity, viewer).expect(410);
    expect(response.body.code).toBe(CLOSED_CODE);
  });

  it("does not let a dead (abandoned) session open a closed study", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    const opportunity = await seedOpportunity({ ownerId: owner, studyId: study, status: "closed" });
    await seedSurveySession({
      opportunityId: opportunity,
      participantId: participant,
      sessionStatus: "abandoned",
    });

    const response = await getDetail(opportunity, participant).expect(410);
    expect(response.body.code).toBe(CLOSED_CODE);
  });

  it("does not let an expired session open a closed study", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    const opportunity = await seedOpportunity({ ownerId: owner, studyId: study, status: "closed" });
    await seedSurveySession({
      opportunityId: opportunity,
      participantId: participant,
      expiresInHours: -1,
    });

    const response = await getDetail(opportunity, participant).expect(410);
    expect(response.body.code).toBe(CLOSED_CODE);
  });

  it("still answers 410 for a closed study when the held session is answered, not in flight (unaffected by this fix)", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    const opportunity = await seedOpportunity({ ownerId: owner, studyId: study, status: "closed" });
    await seedSurveySession({
      opportunityId: opportunity,
      participantId: participant,
      sessionStatus: "completed",
      completedAt: "2026-08-01T00:00:00.000Z",
    });

    // Answered is not in-flight: `completed` and `inProgress` are mutually
    // exclusive in participantSessionSummaryForOpportunity, so an answered
    // session on a closed study gets exactly the 410 it got before this
    // ticket - a pre-existing, unchanged behaviour this pins as a control.
    const response = await getDetail(opportunity, participant).expect(410);
    expect(response.body.code).toBe(CLOSED_CODE);
  });

  /**
   * THE EXEMPTION IS FOR `closed` AND NOTHING ELSE (cto/AdaptaLabs#129,
   * MEDIUM-3).
   *
   * Widening it to any non-published status - which reads as a tidier
   * spelling of the `!== 'published'` test one line above it - serves an
   * in-flight participant the DRAFT's full participant payload instead of the
   * 404 that says the study is not open yet. A study can go published ->
   * draft by PATCH while somebody holds a live session on it, so that is not
   * a hypothetical row: unfinished question wording and unannounced dates
   * reach a participant who never saw them published.
   *
   * Without this test the widening survived the whole suite - every other
   * case here seeds `closed` or `published`, so nothing exercised a third
   * status with a live session behind it.
   */
  it("answers 404 for a draft study even when the participant holds an in-flight session", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    const opportunity = await seedOpportunity({ ownerId: owner, studyId: study, status: "draft" });
    await seedSurveySession({ opportunityId: opportunity, participantId: participant });

    const response = await getDetail(opportunity, participant).expect(404);
    expect(response.body.code).toBe(NOT_OPEN_CODE);
  });

  // The control for the test above: the same seeded session DOES open a
  // `closed` study, so the 404 is the status being refused rather than the
  // fixture failing to produce an in-flight session at all.
  it("opens the same in-flight session when the study is closed rather than draft", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    const opportunity = await seedOpportunity({ ownerId: owner, studyId: study, status: "closed" });
    await seedSurveySession({ opportunityId: opportunity, participantId: participant });

    const response = await getDetail(opportunity, participant).expect(200);
    expect(response.body.completion.inProgress).toBe(true);
  });

  /**
   * `completed` AND `inProgress` ARE MUTUALLY EXCLUSIVE, pinned here because
   * the frontend now relies on it (cto/AdaptaLabs#129, LOW-8).
   *
   * `participantSessionSummaryForOpportunity` builds the pair as
   * `inProgress: !completed && isInFlightRuntimeSession(...)`. OpportunityDetail
   * used to re-test `!completion.completed` beside `completion.inProgress`
   * when deciding whether to offer Resume; that term was inert and has been
   * removed, so the page now trusts this invariant outright.
   *
   * TWO SERVER-SIDE GUARDS PRODUCE IT, and this asserts the OUTCOME rather
   * than either of them, which is what the frontend actually depends on.
   * All three arms measured, so nobody reads a single surviving mutant as
   * this test being weak:
   *   - drop `!completed &&` in the summary alone: PASSES, because
   *     `isInFlightRuntimeSession` already returns false for an answered
   *     status;
   *   - drop the `isAnsweredRuntimeStatus` early return inside
   *     `isInFlightRuntimeSession` alone: PASSES, because `!completed &&`
   *     still holds it;
   *   - drop BOTH: this test REDS by name.
   * The redundancy is deliberate defence in depth over a correctness-critical
   * flag. What this pins is that removing all of it cannot go unseen.
   *
   * Asserted on a PUBLISHED study, because a closed one is refused before the
   * trace is visible at all.
   */
  it("never reports a completed session as in progress", async () => {
    const owner = await seedUser("researcher_admin");
    const participant = await seedUser();
    const study = await seedStudy();
    const opportunity = await seedOpportunity({ ownerId: owner, studyId: study, status: "published" });
    await seedSurveySession({
      opportunityId: opportunity,
      participantId: participant,
      sessionStatus: "completed",
      completedAt: "2026-08-01T00:00:00.000Z",
    });

    const response = await getDetail(opportunity, participant).expect(200);

    expect(response.body.completion.completed).toBe(true);
    expect(response.body.completion.inProgress).toBe(false);
  });

  it("attaches no completion trace at all to an anonymous request", async () => {
    const owner = await seedUser("researcher_admin");
    const study = await seedStudy();
    const opportunity = await seedOpportunity({ ownerId: owner, studyId: study, status: "published" });

    const response = await getDetail(opportunity).expect(200);
    expect(response.body.completion).toBeUndefined();
  });
});
