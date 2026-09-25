import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../__tests__/helpers/postgres-instance";

/**
 * `loadOpportunityResponseTotals` (cto/AdaptaLabs#162), against a real
 * Postgres: the count that becomes the admin studies list's "N responses"
 * Progress cell for a native poll, survey or question row.
 *
 * The whole point of this function is WHICH SESSIONS COUNT, and every one of
 * those rules is a join or a `DISTINCT` a mocked pool cannot fail to get
 * right, because a mocked pool only ever returns the rows a test wrote:
 *
 *   - one answer counts a participant, two answers from the same participant
 *     do not count them twice;
 *   - an in-progress or abandoned session with a stored answer still counts -
 *     the count is about having answered SOMETHING, not about finishing;
 *   - a session with no stored answer does not count at all;
 *   - a DETACHED answer (its question was later removed, `step_id` /
 *     `study_id` nulled by `ON DELETE SET NULL`) still counts - the person
 *     answered, whether or not the question survived;
 *   - a session against a DIFFERENT opportunity, or against the SAME
 *     opportunity id under a study the caller did not ask about (the
 *     `firsthand_study_id` relink case: `runtime_sessions.study_id` is
 *     compared against the CALLER-SUPPLIED study id for that pair, not any
 *     study id at all), is excluded;
 *   - two opportunities that share one study id are counted SEPARATELY, each
 *     against its own sessions;
 *   - a session with a NULL `opportunity_id` (pre-7.37.0) matches no pair and
 *     is excluded;
 *   - an empty-string `participant_id` falls back to the session id, per
 *     `respondentKey` in survey-results.ts - and the key this function builds
 *     is asserted to count the same way `listResponsesForOpportunity` does on
 *     the identical rows, not merely to produce SOME number;
 *   - an opportunity with a linked study and zero answered sessions is ABSENT
 *     from the returned map, never present as 0 - the caller decides what "no
 *     answer yet" means for an applicable row.
 *
 * Every figure below is a LITERAL, never computed from the fixture.
 *
 * Runs in CI's `test-backend-db` (`npx vitest run postgres`); the no-DB
 * vitest job skips it via FIRSTHAND_SKIP_DB_TESTS.
 */
const execFileAsync = promisify(execFile);
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

const migrateScript = path.resolve(__dirname, "../../scripts/firsthand-migrate.mjs");

let databaseUrl: string;
let pool: pg.Pool;
let postgres: TestPostgres;

const importResponseTotals = async () => await import("./opportunity-response-totals");
const importResultsRepository = async () => await import("./survey-results-repository");
const importResults = async () => await import("./survey-results");

async function seedStudy(studyId: string): Promise<void> {
  await pool.query(
    `INSERT INTO firsthand.studies (id, title, intro_text, consent_text, status, kind)
     VALUES ($1, 'Response totals fixture', 'Intro', 'Consent', 'launched', 'survey')`,
    [studyId]
  );
}

async function seedQuestion(studyId: string, stepId: string, order: number): Promise<void> {
  await pool.query(
    `INSERT INTO firsthand.study_steps (id, study_id, step_order, type, prompt)
     VALUES ($1, $2, $3, 'single_choice', 'A question')`,
    [stepId, studyId, order]
  );
}

/** One `runtime_sessions` row. Every column the table requires NOT NULL is filled. */
async function seedSession(input: {
  sessionId: string;
  studyId: string;
  opportunityId: string | null;
  participantId: string;
  sessionStatus: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO firsthand.runtime_sessions
       (session_id, token, study_id, study_title, participant_id,
        participant_display_name, session_status, transcript_status,
        microphone_permission, screen_permission, recording_status,
        upload_status, created_at, updated_at, opportunity_id, steps,
        logical_session_id, attempt_number)
     VALUES ($1, $2, $3, 'Response totals fixture', $4, 'P', $5, 'none',
             'granted', 'granted', 'idle', 'idle', NOW(), NOW(), $6,
             '[]'::jsonb, $1, 1)`,
    [
      input.sessionId,
      `tok_${input.sessionId}`,
      input.studyId,
      input.participantId,
      input.sessionStatus,
      input.opportunityId
    ]
  );
}

/**
 * One stored answer. `stepId: null` models a DETACHED answer (its question
 * was later removed) - the CHECK constraint requires `study_id` to be NULL
 * exactly when `step_id` is, matching what `ON DELETE SET NULL` produces.
 */
async function seedResponse(input: {
  id: string;
  sessionId: string;
  stepId: string | null;
  studyId: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO firsthand.participant_responses
       (id, session_id, step_id, step_type, response_payload, saved_at, study_id)
     VALUES ($1, $2, $3, 'single_choice', $4::jsonb, NOW(), $5)`,
    [input.id, input.sessionId, input.stepId, JSON.stringify({ selectedOption: "A" }), input.studyId]
  );
}

describe.skipIf(skipDbTests)(
  "loadOpportunityResponseTotals, against a real Postgres",
  () => {
    beforeAll(async () => {
      postgres = await startTestPostgres("opportunity-response-totals");
      databaseUrl = postgres.connectionString;

      await execFileAsync("node", [migrateScript], {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        timeout: 120_000
      });

      pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    }, 180_000);

    afterAll(async () => {
      await pool?.end().catch(() => {});
      await postgres?.stop();
    });

    beforeEach(async () => {
      process.env.DATABASE_URL = databaseUrl;
      await pool.query("TRUNCATE firsthand.runtime_sessions CASCADE");
      await pool.query("TRUNCATE firsthand.studies CASCADE");
    });

    afterEach(async () => {
      delete process.env.DATABASE_URL;
      const globals = globalThis as typeof globalThis & {
        __firsthandRuntimePool?: { end?: () => Promise<void> };
        __firsthandRuntimeVerification?: unknown;
      };
      await globals.__firsthandRuntimePool?.end?.().catch(() => {});
      delete globals.__firsthandRuntimePool;
      delete globals.__firsthandRuntimeVerification;
    });

    it("counts one respondent per distinct participant, not per answer", async () => {
      await seedStudy("study_multi");
      await seedQuestion("study_multi", "study_multi_q1", 1);
      await seedSession({
        sessionId: "sess_alice",
        studyId: "study_multi",
        opportunityId: "opp_multi",
        participantId: "alice",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_alice", sessionId: "sess_alice", stepId: "study_multi_q1", studyId: "study_multi" });

      await seedSession({
        sessionId: "sess_bob",
        studyId: "study_multi",
        opportunityId: "opp_multi",
        participantId: "bob",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_bob", sessionId: "sess_bob", stepId: "study_multi_q1", studyId: "study_multi" });

      const { loadOpportunityResponseTotals } = await importResponseTotals();
      const totals = await loadOpportunityResponseTotals([
        { opportunityId: "opp_multi", studyId: "study_multi" }
      ]);

      expect(totals.get("opp_multi")).toBe(2);
    });

    it("counts the same person once across two sessions, resumed or repeated", async () => {
      await seedStudy("study_same_person");
      await seedQuestion("study_same_person", "study_same_person_q1", 1);
      await seedSession({
        sessionId: "sess_first_attempt",
        studyId: "study_same_person",
        opportunityId: "opp_same_person",
        participantId: "carol",
        sessionStatus: "abandoned"
      });
      await seedResponse({
        id: "resp_first_attempt",
        sessionId: "sess_first_attempt",
        stepId: "study_same_person_q1",
        studyId: "study_same_person"
      });
      await seedSession({
        sessionId: "sess_second_attempt",
        studyId: "study_same_person",
        opportunityId: "opp_same_person",
        participantId: "carol",
        sessionStatus: "completed"
      });
      await seedResponse({
        id: "resp_second_attempt",
        sessionId: "sess_second_attempt",
        stepId: "study_same_person_q1",
        studyId: "study_same_person"
      });

      const { loadOpportunityResponseTotals } = await importResponseTotals();
      const totals = await loadOpportunityResponseTotals([
        { opportunityId: "opp_same_person", studyId: "study_same_person" }
      ]);

      // ONE respondent, not two: two sessions, one person.
      expect(totals.get("opp_same_person")).toBe(1);
    });

    it("counts an in-progress and an abandoned session that each hold an answer", async () => {
      await seedStudy("study_status");
      await seedQuestion("study_status", "study_status_q1", 1);
      await seedSession({
        sessionId: "sess_in_progress",
        studyId: "study_status",
        opportunityId: "opp_status",
        participantId: "dana",
        sessionStatus: "active"
      });
      await seedResponse({ id: "resp_in_progress", sessionId: "sess_in_progress", stepId: "study_status_q1", studyId: "study_status" });

      await seedSession({
        sessionId: "sess_abandoned",
        studyId: "study_status",
        opportunityId: "opp_status",
        participantId: "erin",
        sessionStatus: "abandoned"
      });
      await seedResponse({ id: "resp_abandoned", sessionId: "sess_abandoned", stepId: "study_status_q1", studyId: "study_status" });

      const { loadOpportunityResponseTotals } = await importResponseTotals();
      const totals = await loadOpportunityResponseTotals([
        { opportunityId: "opp_status", studyId: "study_status" }
      ]);

      // Finishing is not the bar - having answered something is.
      expect(totals.get("opp_status")).toBe(2);
    });

    it("does not count a session that never stored an answer", async () => {
      await seedStudy("study_zero_answer");
      await seedSession({
        sessionId: "sess_zero_answer",
        studyId: "study_zero_answer",
        opportunityId: "opp_zero_answer",
        participantId: "frank",
        sessionStatus: "abandoned"
      });
      // A participant with a completed answer too, so the arm has something
      // real to be diluted by if the EXISTS filter is dropped.
      await seedQuestion("study_zero_answer", "study_zero_answer_q1", 1);
      await seedSession({
        sessionId: "sess_with_answer",
        studyId: "study_zero_answer",
        opportunityId: "opp_zero_answer",
        participantId: "grace",
        sessionStatus: "completed"
      });
      await seedResponse({
        id: "resp_with_answer",
        sessionId: "sess_with_answer",
        stepId: "study_zero_answer_q1",
        studyId: "study_zero_answer"
      });

      const { loadOpportunityResponseTotals } = await importResponseTotals();
      const totals = await loadOpportunityResponseTotals([
        { opportunityId: "opp_zero_answer", studyId: "study_zero_answer" }
      ]);

      // Frank's answer-free session is not counted; Grace's is - 1, not 2.
      expect(totals.get("opp_zero_answer")).toBe(1);
    });

    it("counts a DETACHED answer whose question was removed", async () => {
      await seedStudy("study_removed_question");
      await seedSession({
        sessionId: "sess_removed_question",
        studyId: "study_removed_question",
        opportunityId: "opp_removed_question",
        participantId: "henry",
        sessionStatus: "completed"
      });
      // step_id/study_id NULL: what ON DELETE SET NULL leaves behind once the
      // question is gone from study_steps.
      await seedResponse({
        id: "resp_removed_question",
        sessionId: "sess_removed_question",
        stepId: null,
        studyId: null
      });

      const { loadOpportunityResponseTotals } = await importResponseTotals();
      const totals = await loadOpportunityResponseTotals([
        { opportunityId: "opp_removed_question", studyId: "study_removed_question" }
      ]);

      expect(totals.get("opp_removed_question")).toBe(1);
    });

    it("excludes another opportunity's sessions entirely", async () => {
      await seedStudy("study_other_opp");
      await seedQuestion("study_other_opp", "study_other_opp_q1", 1);
      await seedSession({
        sessionId: "sess_this_opp",
        studyId: "study_other_opp",
        opportunityId: "opp_this",
        participantId: "iris",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_this_opp", sessionId: "sess_this_opp", stepId: "study_other_opp_q1", studyId: "study_other_opp" });

      // Same study, a DIFFERENT opportunity, with its own distinctive answer
      // count (3) so a leak is recognisable rather than merely "wrong by one".
      await seedSession({
        sessionId: "sess_other_opp_1",
        studyId: "study_other_opp",
        opportunityId: "opp_other",
        participantId: "jack",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_other_opp_1", sessionId: "sess_other_opp_1", stepId: "study_other_opp_q1", studyId: "study_other_opp" });
      await seedSession({
        sessionId: "sess_other_opp_2",
        studyId: "study_other_opp",
        opportunityId: "opp_other",
        participantId: "kate",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_other_opp_2", sessionId: "sess_other_opp_2", stepId: "study_other_opp_q1", studyId: "study_other_opp" });
      await seedSession({
        sessionId: "sess_other_opp_3",
        studyId: "study_other_opp",
        opportunityId: "opp_other",
        participantId: "leo",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_other_opp_3", sessionId: "sess_other_opp_3", stepId: "study_other_opp_q1", studyId: "study_other_opp" });

      const { loadOpportunityResponseTotals } = await importResponseTotals();
      const totals = await loadOpportunityResponseTotals([
        { opportunityId: "opp_this", studyId: "study_other_opp" }
      ]);

      expect(totals.get("opp_this")).toBe(1);
      // THE CONTROL: opp_other's three answers really exist and are counted
      // when asked for directly, so their absence above is the opportunity
      // filter's doing, not an empty table.
      const otherTotals = await loadOpportunityResponseTotals([
        { opportunityId: "opp_other", studyId: "study_other_opp" }
      ]);
      expect(otherTotals.get("opp_other")).toBe(3);
    });

    it("excludes a session minted under the study this opportunity used to link before a relink", async () => {
      await seedStudy("study_relink_old");
      await seedStudy("study_relink_new");
      await seedQuestion("study_relink_old", "study_relink_old_q1", 1);

      // A session minted while opp_relink pointed at the OLD study, carrying
      // a real answer.
      await seedSession({
        sessionId: "sess_relink_old",
        studyId: "study_relink_old",
        opportunityId: "opp_relink",
        participantId: "mia",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_relink_old", sessionId: "sess_relink_old", stepId: "study_relink_old_q1", studyId: "study_relink_old" });

      const { loadOpportunityResponseTotals } = await importResponseTotals();

      // The caller now supplies the NEW study id for opp_relink - the pair the
      // route builds from the opportunity's CURRENT firsthand_study_id after
      // the relink.
      const totals = await loadOpportunityResponseTotals([
        { opportunityId: "opp_relink", studyId: "study_relink_new" }
      ]);

      // Absent, not 0: opp_relink is a real applicable row (a linked study
      // exists), it simply has no session under the study id being asked
      // about. The caller reads this as 0 (0 is a real value for a native
      // study with no answers under its current link) - this function only
      // guarantees the row is not silently populated with the OLD study's
      // count.
      expect(totals.has("opp_relink")).toBe(false);

      // THE CONTROL: asking under the OLD study id (what a dropped study_id
      // filter would effectively do) finds the same session and answer.
      const oldTotals = await loadOpportunityResponseTotals([
        { opportunityId: "opp_relink", studyId: "study_relink_old" }
      ]);
      expect(oldTotals.get("opp_relink")).toBe(1);
    });

    it("counts two opportunities that share one study id separately", async () => {
      await seedStudy("study_shared");
      await seedQuestion("study_shared", "study_shared_q1", 1);

      await seedSession({
        sessionId: "sess_shared_a1",
        studyId: "study_shared",
        opportunityId: "opp_shared_a",
        participantId: "nina",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_shared_a1", sessionId: "sess_shared_a1", stepId: "study_shared_q1", studyId: "study_shared" });

      // opp_shared_b gets a distinctive TWO answers, so a merge with a's ONE
      // shows up as three, not one-off-by-a-little.
      await seedSession({
        sessionId: "sess_shared_b1",
        studyId: "study_shared",
        opportunityId: "opp_shared_b",
        participantId: "omar",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_shared_b1", sessionId: "sess_shared_b1", stepId: "study_shared_q1", studyId: "study_shared" });
      await seedSession({
        sessionId: "sess_shared_b2",
        studyId: "study_shared",
        opportunityId: "opp_shared_b",
        participantId: "priya",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_shared_b2", sessionId: "sess_shared_b2", stepId: "study_shared_q1", studyId: "study_shared" });

      const { loadOpportunityResponseTotals } = await importResponseTotals();
      const totals = await loadOpportunityResponseTotals([
        { opportunityId: "opp_shared_a", studyId: "study_shared" },
        { opportunityId: "opp_shared_b", studyId: "study_shared" }
      ]);

      expect(totals.get("opp_shared_a")).toBe(1);
      expect(totals.get("opp_shared_b")).toBe(2);
    });

    it("excludes a session with no opportunity_id (pre-7.37.0)", async () => {
      await seedStudy("study_null_opp");
      await seedQuestion("study_null_opp", "study_null_opp_q1", 1);
      await seedSession({
        sessionId: "sess_null_opp",
        studyId: "study_null_opp",
        opportunityId: null,
        participantId: "quinn",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_null_opp", sessionId: "sess_null_opp", stepId: "study_null_opp_q1", studyId: "study_null_opp" });

      const { loadOpportunityResponseTotals } = await importResponseTotals();
      const totals = await loadOpportunityResponseTotals([
        { opportunityId: "opp_null_opp", studyId: "study_null_opp" }
      ]);

      expect(totals.has("opp_null_opp")).toBe(false);
    });

    it("counts a session with an empty-string participant_id by its session id, per respondentKey's own fallback", async () => {
      await seedStudy("study_empty_pid");
      await seedQuestion("study_empty_pid", "study_empty_pid_q1", 1);
      await seedSession({
        sessionId: "sess_empty_pid",
        studyId: "study_empty_pid",
        opportunityId: "opp_empty_pid",
        participantId: "",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_empty_pid", sessionId: "sess_empty_pid", stepId: "study_empty_pid_q1", studyId: "study_empty_pid" });
      await seedSession({
        sessionId: "sess_empty_pid_2",
        studyId: "study_empty_pid",
        opportunityId: "opp_empty_pid",
        participantId: "",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_empty_pid_2", sessionId: "sess_empty_pid_2", stepId: "study_empty_pid_q1", studyId: "study_empty_pid" });

      const { loadOpportunityResponseTotals } = await importResponseTotals();
      const totals = await loadOpportunityResponseTotals([
        { opportunityId: "opp_empty_pid", studyId: "study_empty_pid" }
      ]);

      // Two sessions with an empty participant_id are two respondents - an
      // empty id must not become a shared "nobody" key that merges them.
      expect(totals.get("opp_empty_pid")).toBe(2);
    });

    it("leaves an applicable opportunity with a linked study and no answers absent from the map, not 0", async () => {
      await seedStudy("study_no_answers");
      await seedSession({
        sessionId: "sess_no_answers",
        studyId: "study_no_answers",
        opportunityId: "opp_no_answers",
        participantId: "ray",
        sessionStatus: "abandoned"
      });
      // No participant_responses row for this session at all.

      const { loadOpportunityResponseTotals } = await importResponseTotals();
      const totals = await loadOpportunityResponseTotals([
        { opportunityId: "opp_no_answers", studyId: "study_no_answers" }
      ]);

      expect(totals.has("opp_no_answers")).toBe(false);
    });

    it("agrees with aggregateSurveyResults(listResponsesForOpportunity(...)).respondents on the same rows", async () => {
      await seedStudy("study_parity");
      await seedQuestion("study_parity", "study_parity_q1", 1);

      // Three participants; one of them (sam) answers via two sessions, which
      // is exactly the shape that would double-count under a session-keyed
      // definition instead of a participant-keyed one.
      await seedSession({
        sessionId: "sess_parity_sam_1",
        studyId: "study_parity",
        opportunityId: "opp_parity",
        participantId: "sam",
        sessionStatus: "abandoned"
      });
      await seedResponse({ id: "resp_parity_sam_1", sessionId: "sess_parity_sam_1", stepId: "study_parity_q1", studyId: "study_parity" });
      await seedSession({
        sessionId: "sess_parity_sam_2",
        studyId: "study_parity",
        opportunityId: "opp_parity",
        participantId: "sam",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_parity_sam_2", sessionId: "sess_parity_sam_2", stepId: "study_parity_q1", studyId: "study_parity" });

      await seedSession({
        sessionId: "sess_parity_tia",
        studyId: "study_parity",
        opportunityId: "opp_parity",
        participantId: "tia",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_parity_tia", sessionId: "sess_parity_tia", stepId: "study_parity_q1", studyId: "study_parity" });

      // A detached answer too, so parity holds across the same "removed
      // question" shape the totals query counts above.
      await seedSession({
        sessionId: "sess_parity_uma",
        studyId: "study_parity",
        opportunityId: "opp_parity",
        participantId: "uma",
        sessionStatus: "completed"
      });
      await seedResponse({ id: "resp_parity_uma", sessionId: "sess_parity_uma", stepId: null, studyId: null });

      const { loadOpportunityResponseTotals } = await importResponseTotals();
      const { listResponsesForOpportunity } = await importResultsRepository();
      const { aggregateSurveyResults } = await importResults();

      const totals = await loadOpportunityResponseTotals([
        { opportunityId: "opp_parity", studyId: "study_parity" }
      ]);
      const responses = await listResponsesForOpportunity({
        opportunityId: "opp_parity",
        studyId: "study_parity"
      });
      const { respondents } = aggregateSurveyResults([], responses);

      // THE PARITY ASSERTION, on the same rows a real read produced: the
      // Progress cell and the Results tab headline must agree, per
      // cto/AdaptaLabs#162's decision.
      expect(totals.get("opp_parity")).toBe(respondents);
      // And it is stated as a literal too, so a mutation that broke BOTH
      // sides identically (the actual risk with two readers sharing one
      // definition) cannot hide behind an equality that is vacuously true at
      // any wrong number.
      expect(totals.get("opp_parity")).toBe(3);
    });
  }
);
