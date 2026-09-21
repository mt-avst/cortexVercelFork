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
 *     delivered row, and - since cto/AdaptaLabs#152 made the export group by
 *     person and flag superseded sessions - through its OUTCOME as well.
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

/**
 * One runtime session for `PARTICIPANT_ID`, carrying one answer.
 *
 * `savedAt` is explicit because which answer WINS is decided on it
 * (cto/AdaptaLabs#152). `NOW()` in two statements is two different instants
 * in practice, and nothing guarantees their order is the one the test names.
 */
async function seedAnsweredSession(
  sessionId: string,
  selection: string,
  savedAt: string,
  opportunityId: string = OPPORTUNITY_ID
): Promise<void> {
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
    [sessionId, `tok_${sessionId}`, STUDY_ID, PARTICIPANT_ID, opportunityId]
  );
  await pool.query(
    `INSERT INTO firsthand.participant_responses
       (id, session_id, step_id, step_type, response_payload, saved_at,
        study_id, step_prompt)
     VALUES ($1, $2, $3, 'single_choice', $4::jsonb, $5, $6, $7)`,
    [
      `resp_${sessionId}`,
      sessionId,
      QUESTION_ID,
      JSON.stringify({ selectedOption: selection }),
      savedAt,
      STUDY_ID,
      QUESTION_STEP.prompt
    ]
  );
}

/** The whole export as lines, from the real streamed path. */
async function streamedCsv(
  scope:
    | { kind: "study"; studyId: string }
    | { kind: "opportunity"; studyId: string; opportunityId: string }
): Promise<string[]> {
  const { openSurveyCsvExport } = await import("./survey-results-repository");
  const { toCsvHeaderRow, toCsvSessionRow } = await import("./survey-csv");

  const csvExport = await openSurveyCsvExport(scope);
  const lines = [toCsvHeaderRow([QUESTION_STEP], csvExport.removedQuestions)];
  for await (const row of csvExport.participants(new AbortController().signal)) {
    lines.push(toCsvSessionRow([QUESTION_STEP], csvExport.removedQuestions, row));
  }
  return lines;
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
    await seedAnsweredSession(FIRST_SESSION, "Left", "2026-09-20T09:00:00.000Z");
    await seedAnsweredSession(SECOND_SESSION, "Right", "2026-09-21T09:00:00.000Z");
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
   * The per-question tally is asserted IN THE SAME TEST, and it is the
   * acceptance test for cto/AdaptaLabs#152: the headline counts people, so
   * the chart under it must count one answer per person per question - the
   * LATEST. Before #152 this read `answered: 2` beneath `respondents: 1`.
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
    expect(results.questions[0]?.answered).toBe(1);
    // WHICH answer, not only how many: the later Right, not the earlier Left.
    expect(results.questions[0]?.options).toEqual([
      { option: "Left", count: 0, percent: 0 },
      { option: "Right", count: 1, percent: 100 }
    ]);
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
   * from one and kept in the other - and no CSV byte shows it, because the
   * export takes each session's person from its preflight list and its
   * superseded flag from SQL (cto/AdaptaLabs#152). What breaks is the
   * declared contract: `StoredResponse.participant_id` becomes undefined on
   * rows this path returns. So the pin is on the delivered field.
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

  /**
   * THE CSV KEEPS BOTH ANSWERS AND FLAGS THE ONE THAT LOST
   * (cto/AdaptaLabs#152), through the real streamed path on rows a real
   * Postgres returned.
   */
  it("exports both sessions under one person, with the earlier one flagged superseded", async () => {
    const lines = await streamedCsv({ kind: "study", studyId: STUDY_ID });

    expect(lines).toEqual([
      "Session,Participant,Superseded,Which did you prefer?",
      `${FIRST_SESSION},${PARTICIPANT_ID},true,Left`,
      `${SECOND_SESSION},${PARTICIPANT_ID},false,Right`
    ]);
  });

  /**
   * THE SUPERSEDED PREFLIGHT'S SCOPE FILTER IS LOAD-BEARING, where without a
   * cross-opportunity fixture nothing could test it.
   *
   * The batch read binds session ids, primary keys the scoped preflight already
   * chose, so its own `${filter}` is defence-in-depth and untestable (see the
   * comment at that site). What this test pins is a DIFFERENT scope: the
   * superseded-sessions preflight (`readSupersededSessions`). One person can
   * hold sessions in two opportunities of the same study, so without `${filter}`
   * on that preflight, their later answer under ANOTHER researcher's
   * recruitment would flag a session in this researcher's export - an answer
   * outside the reader's scope leaking through as a superseded flag, with no
   * row of data to make it visible. `csv-superseded-sql-keeps-to-the-export-scope`
   * mutates that filter to `(${filter} OR TRUE)` and this test is what reds.
   */
  it("keeps a per-opportunity export to that opportunity when one person answered in two", async () => {
    await pool.query("TRUNCATE firsthand.runtime_sessions CASCADE");
    await seedAnsweredSession(FIRST_SESSION, "Left", "2026-09-20T09:00:00.000Z");
    await seedAnsweredSession(
      "sess_elsewhere",
      "Right",
      "2026-09-21T09:00:00.000Z",
      "opp_someone_elses"
    );

    const lines = await streamedCsv({
      kind: "opportunity",
      studyId: STUDY_ID,
      opportunityId: OPPORTUNITY_ID
    });

    // One session, and NOT flagged: the later answer lives in an export this
    // reader is not entitled to, so it cannot supersede anything here.
    expect(lines).toEqual([
      "Session,Participant,Superseded,Which did you prefer?",
      `${FIRST_SESSION},${PARTICIPANT_ID},false,Left`
    ]);

    // CONTROL: the other session is really there, and the study-wide export
    // does see it - so the line above is the scope working, not a fixture
    // that failed to seed.
    const everything = await streamedCsv({ kind: "study", studyId: STUDY_ID });
    expect(everything).toHaveLength(3);
  });
});
