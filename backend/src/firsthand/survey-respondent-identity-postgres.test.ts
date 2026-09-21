import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../__tests__/helpers/postgres-instance";

/**
 * THE RESPONDENT FIX HAS TWO HALVES AND ONLY ONE OF THEM WAS PROTECTED
 * (cto/AdaptaLabs#129, HIGH-1 of the review pass).
 *
 * `respondentKey` counts one respondent per `participant_id` rather than per
 * `session_id`, which is the AGGREGATION half. Every test of it feeds
 * `aggregateSurveyResults` a hand-written fixture array, so every one of them
 * proves the arithmetic and none of them proves the DELIVERY: that the read
 * underneath actually hands the aggregation a `participant_id` to key on.
 *
 * Measured, which is why this file exists. Deleting `s.participant_id,` from
 * BOTH SQL projections in survey-results-repository.ts left the whole backend
 * suite green - 67 files, 942 tests, the 29 real-Postgres specs included - and
 * typecheck passed too. SQL is a string, so nothing compiles it; `pg` rows are
 * `any`, so `ResponseRow.participant_id: string` simply becomes a false
 * statement about the runtime row. At runtime the field is `undefined`,
 * `respondentKey` falls through to its `s:${session_id}` fallback, and the
 * double count this ticket exists to remove is silently back with every test
 * still passing.
 *
 * So both projections are pinned HERE, on the rows a real Postgres returned:
 *
 *   - the aggregate read (`listResponsesForOpportunity` ->
 *     `listResponsesWhere`), pinned through its OUTCOME - one person with two
 *     answer-carrying sessions must be one respondent;
 *   - the CSV batch read (`openSurveyCsvExport` -> `readBatch`), pinned on the
 *     delivered row, because no CSV byte depends on the column. The export
 *     groups by `session_id` on purpose (cto/AdaptaLabs#152), so its outcome
 *     cannot see this and the declared row type is the only thing that can.
 *     A test asserting the type it declares is the honest shape of that pin.
 *
 * WHY REAL POSTGRES: the defect is entirely in the SQL text. A mocked pool
 * hands the repository rows the test wrote itself, so it asserts the fixture,
 * which is precisely the blind spot above.
 *
 * TWO SESSIONS, ONE PERSON, is the fixture the whole file turns on, and it is
 * an ordinary state rather than a contrived one: since an expired session
 * earns a fresh mint instead of a dead link (LOW-8 of this ticket), "answer
 * two questions, come back after the 24-hour token lapses, answer the rest"
 * leaves one participant holding two answer-carrying rows.
 *
 * RUNS IN CI, in `test-backend-db`, which selects by filename with
 * `vitest run postgres` and supplies a Postgres `services:` container through
 * FIRSTHAND_TEST_DATABASE_URL. cto/AdaptaLabs#20.
 */

const execFileAsync = promisify(execFile);
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

const migrateScript = path.resolve(__dirname, "../../scripts/firsthand-migrate.mjs");

const STUDY_ID = "study_respondent_identity";
const OPPORTUNITY_ID = "opp_respondent_identity";
const PARTICIPANT_ID = "user_one_person";
const FIRST_SESSION = "sess_first";
const SECOND_SESSION = "sess_second";
const QUESTION_ID = "study_respondent_identity_q1";

let databaseUrl: string;
let pool: pg.Pool;
let postgres: TestPostgres;

/** The question the fixture's answers are given against. */
const QUESTION_STEP = {
  step_id: QUESTION_ID,
  order: 1,
  type: "single_choice" as const,
  prompt: "Which did you prefer?",
  options: ["Left", "Right"]
};

async function seedStudy(): Promise<void> {
  await pool.query(
    `INSERT INTO firsthand.studies (id, title, intro_text, consent_text, status, kind)
     VALUES ($1, 'Respondent identity', 'Intro', 'Consent', 'launched', 'survey')`,
    [STUDY_ID]
  );
  await pool.query(
    `INSERT INTO firsthand.study_steps (id, study_id, step_order, type, prompt, options)
     VALUES ($1, $2, 1, 'single_choice', $3, $4::jsonb)`,
    [QUESTION_ID, STUDY_ID, QUESTION_STEP.prompt, JSON.stringify(QUESTION_STEP.options)]
  );
}

/** One runtime session for `PARTICIPANT_ID`, carrying one answer. */
async function seedAnsweredSession(sessionId: string, selection: string): Promise<void> {
  await pool.query(
    `INSERT INTO firsthand.runtime_sessions
       (session_id, token, study_id, study_title, participant_id,
        participant_display_name, session_status, transcript_status,
        microphone_permission, screen_permission, recording_status,
        upload_status, created_at, updated_at, opportunity_id, steps,
        logical_session_id, attempt_number)
     VALUES ($1, $2, $3, 'Respondent identity', $4, 'One Person', 'active', 'none',
             'granted', 'granted', 'idle', 'idle', NOW(), NOW(), $5,
             '[]'::jsonb, $1, 1)`,
    [sessionId, `tok_${sessionId}`, STUDY_ID, PARTICIPANT_ID, OPPORTUNITY_ID]
  );
  await pool.query(
    `INSERT INTO firsthand.participant_responses
       (id, session_id, step_id, step_type, response_payload, saved_at,
        study_id, step_prompt)
     VALUES ($1, $2, $3, 'single_choice', $4::jsonb, NOW(), $5, $6)`,
    [
      `resp_${sessionId}`,
      sessionId,
      QUESTION_ID,
      JSON.stringify({ selectedOption: selection }),
      STUDY_ID,
      QUESTION_STEP.prompt
    ]
  );
}

describe.skipIf(skipDbTests)("the respondent identity, delivered by a real read", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("survey-respondent-identity");
    databaseUrl = postgres.connectionString;
    await execFileAsync("node", [migrateScript], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 120_000
    });
    pool = new pg.Pool({ connectionString: databaseUrl });
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await postgres?.stop();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    process.env.DATABASE_URL = databaseUrl;
    delete (globalThis as { __firsthandRuntimePool?: unknown }).__firsthandRuntimePool;
    delete (globalThis as { __firsthandRuntimeVerification?: unknown })
      .__firsthandRuntimeVerification;
    await pool.query("TRUNCATE firsthand.runtime_sessions CASCADE");
    await pool.query("TRUNCATE firsthand.studies CASCADE");
    await seedStudy();
    await seedAnsweredSession(FIRST_SESSION, "Left");
    await seedAnsweredSession(SECOND_SESSION, "Right");
  });

  /**
   * THE AGGREGATE PROJECTION, pinned by outcome.
   *
   * Two sessions, one person, one respondent. The assertion is `1` rather
   * than "fewer than 2" so it states the whole answer: with
   * `s.participant_id` dropped from `listResponsesWhere`'s SELECT, the rows
   * arrive with the field `undefined`, `respondentKey` keys on `session_id`
   * instead, and this reads 2.
   *
   * The per-question `answered` is asserted at 2 IN THE SAME TEST, and not by
   * accident. It is the known, deliberately-unfixed disagreement
   * (cto/AdaptaLabs#152): the headline counts people, the tallies count
   * answer rows. Written down here so the day somebody fixes #152 this test
   * fails and makes them look at it, rather than the two numbers drifting
   * apart unwatched.
   */
  it("counts one participant holding two answered sessions as a single respondent", async () => {
    const { listResponsesForOpportunity } = await import("./survey-results-repository");
    const { aggregateSurveyResults } = await import("./survey-results");

    const responses = await listResponsesForOpportunity({
      opportunityId: OPPORTUNITY_ID,
      studyId: STUDY_ID
    });

    // The fixture's own shape first: two answer rows reached the aggregation,
    // so a `respondents` of 1 below is the KEYING collapsing them and not a
    // read that quietly returned one row.
    expect(responses).toHaveLength(2);

    const results = aggregateSurveyResults([QUESTION_STEP], responses);

    expect(results.respondents).toBe(1);
    expect(results.questions[0]?.answered).toBe(2);
  });

  /**
   * THE AGGREGATE PROJECTION, pinned on the delivered field as well.
   *
   * The test above is the one that matters and it is an outcome test, so it
   * would also red for an unrelated reason - a broken join, a lost row. This
   * one names the actual cause, so a failure pair reads "the column is
   * missing" rather than "something about respondents".
   */
  it("delivers the participant id on every row the aggregate read returns", async () => {
    const { listResponsesForOpportunity } = await import("./survey-results-repository");

    const responses = await listResponsesForOpportunity({
      opportunityId: OPPORTUNITY_ID,
      studyId: STUDY_ID
    });

    expect(responses).toHaveLength(2);
    expect(responses.map((row) => row.participant_id)).toEqual([
      PARTICIPANT_ID,
      PARTICIPANT_ID
    ]);
  });

  /**
   * THE CSV BATCH PROJECTION, which is a SECOND copy of the same SELECT.
   *
   * `readBatch` repeats the projection verbatim, so the column can be lost
   * from one and kept in the other - and losing it here is invisible to every
   * CSV assertion in the repository, because the export groups by
   * `session_id` and emits `session_id` in its first cell. Nothing about the
   * bytes changes.
   *
   * What changes is that `StoredResponse.participant_id`, which this path
   * populates and declares, becomes `undefined`. That is a trap set for the
   * next reader rather than a bug today: the first consumer to group this
   * export by person - #152's likely shape - would find the field missing
   * from one of the two reads that produce it. So the pin is on the declared
   * contract, asserted on rows a real database returned.
   */
  it("delivers the participant id on every row the csv batch read returns", async () => {
    const { openSurveyCsvExport } = await import("./survey-results-repository");

    const csvExport = await openSurveyCsvExport({ kind: "study", studyId: STUDY_ID });
    const controller = new AbortController();

    const delivered: (string | null | undefined)[] = [];
    for await (const participant of csvExport.participants(controller.signal)) {
      for (const answer of participant.answers) {
        delivered.push(answer.participant_id);
      }
    }

    // Two sessions, one answer each, and BOTH carry the person's id. The
    // length assertion is not decoration: an empty `delivered` satisfies any
    // "every row has it" phrasing, which is the shape of absence-assertion
    // that passes when the thing producing the list is broken.
    expect(delivered).toEqual([PARTICIPANT_ID, PARTICIPANT_ID]);
  });
});
