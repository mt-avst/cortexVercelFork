import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../__tests__/helpers/postgres-instance";

/**
 * The same attachment rules as `runtime-response-attachment.test.ts`, but
 * against a real Postgres with 0015 actually applied.
 *
 * That file is explicit about its own limit: it drives a mocked pg and asserts
 * the statement and its parameters, so it pins what is SENT and not what the
 * database does with it. Every constraint 0015 adds - the composite foreign
 * key, ON DELETE SET NULL, and the `(study_id IS NULL) = (step_id IS NULL)`
 * CHECK - is invisible to it, because no constraint is ever evaluated.
 *
 * That gap was not theoretical. The shipped statement bound study_id to the
 * session's own id unconditionally while letting step_id fall out of a
 * subquery that resolves to NULL once the question is gone. The composite
 * foreign key permits that pair (MATCH SIMPLE stops checking the moment any
 * referencing column is NULL) so only the CHECK rejects it - and it did,
 * aborting the whole session write and losing the participant's progress, for
 * exactly the case the subquery was added to survive. Every string assertion
 * in the mocked file passed throughout.
 *
 * So these tests assert on rows that Postgres accepted or refused, never on
 * SQL text. A test that restates the statement cannot detect drift from it.
 */
const execFileAsync = promisify(execFile);
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

const migrateScript = path.resolve(__dirname, "../../scripts/firsthand-migrate.mjs");

const STUDY_ID = "study_survey";
const LIVE_STEP_ID = "study_survey_alpha";
const DOOMED_STEP_ID = "study_survey_beta";

// The wording the PARTICIPANT was shown. `session.steps` is a snapshot taken
// when the session was seeded, so it is the only record of what they were
// actually asked once the question itself is gone.
const DOOMED_PROMPT_AS_SHOWN = "How easy was that, as this participant was asked it?";

let databaseUrl: string;
let pool: pg.Pool;
let postgres: TestPostgres;


const payload = () => ({
  contract_version: "1.0" as const,
  study: {
    id: STUDY_ID,
    title: "Pulse",
    intro_text: "Intro",
    consent_text: "Consent",
    kind: "survey" as const
  },
  participant: { participant_id: "user-42", display_name: "User 42" },
  session: {
    session_id: "session_1",
    session_token: "fh_token",
    study_id: STUDY_ID,
    participant_id: "user-42"
  },
  // The session's own step list, which keeps both questions for the life of
  // the session even after one is removed from the study. This is what the
  // participant's client is still showing them.
  steps: [
    {
      step_id: LIVE_STEP_ID,
      order: 1,
      type: "rating" as const,
      prompt: "How easy was that?",
      config: { scale_max: 5 }
    },
    {
      step_id: DOOMED_STEP_ID,
      order: 2,
      type: "rating" as const,
      prompt: DOOMED_PROMPT_AS_SHOWN,
      config: { scale_max: 5 }
    }
  ]
});

const answerTo = (stepId: string, rating: number) => ({
  type: "response" as const,
  stepId,
  stepType: "rating" as const,
  responsePayload: { rating }
});

const importRepository = async () => await import("./runtime-repository-postgres");

const storedResponses = async () => {
  const { rows } = await pool.query(
    `SELECT step_id, study_id, step_prompt, response_payload
       FROM firsthand.participant_responses
      ORDER BY step_prompt`
  );
  return rows;
};

describe.skipIf(skipDbTests)("attaching an answer, against a real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("attachment");
    databaseUrl = postgres.connectionString;

    await execFileAsync("node", [migrateScript], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 60_000
    });

    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await postgres?.stop();
  });

  beforeEach(async () => {
    process.env.DATABASE_URL = databaseUrl;

    await pool.query("TRUNCATE firsthand.studies CASCADE");
    await pool.query("TRUNCATE firsthand.runtime_sessions CASCADE");
    await pool.query(
      `INSERT INTO firsthand.studies (id, title, intro_text, consent_text, kind)
       VALUES ($1, 'Pulse', 'Intro', 'Consent', 'survey')`,
      [STUDY_ID]
    );
    await pool.query(
      `INSERT INTO firsthand.study_steps (study_id, id, step_order, type, prompt)
       VALUES ($1, $2, 1, 'rating', 'How easy was that?'),
              ($1, $3, 2, 'rating', $4)`,
      [STUDY_ID, LIVE_STEP_ID, DOOMED_STEP_ID, DOOMED_PROMPT_AS_SHOWN]
    );
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

  const removeDoomedStep = async () => {
    await pool.query(
      "DELETE FROM firsthand.study_steps WHERE study_id = $1 AND id = $2",
      [STUDY_ID, DOOMED_STEP_ID]
    );
  };

  it("stores an answer attached to the question that is still there", async () => {
    const repository = await importRepository();

    await repository.applyRuntimeMutationPostgres(payload(), answerTo(LIVE_STEP_ID, 5));

    expect(await storedResponses()).toEqual([
      expect.objectContaining({
        study_id: STUDY_ID,
        step_id: LIVE_STEP_ID,
        step_prompt: "How easy was that?"
      })
    ]);
  });

  it("keeps a participant's save working when they answer a question the researcher has just removed", async () => {
    // The failure this exists for. The participant's client is still showing
    // question 2 from the session's own snapshot, so they can answer it after
    // it has left the study - no concurrency required, just an ordinary edit
    // during an ordinary session.
    //
    // Binding study_id to the session's own id while letting step_id resolve
    // to NULL produces a half-detached row, which 0015's CHECK refuses. The
    // refusal aborts the transaction around the WHOLE session write, so the
    // participant loses every answer they have given, not just this one.
    const repository = await importRepository();
    await repository.applyRuntimeMutationPostgres(payload(), answerTo(LIVE_STEP_ID, 5));

    await removeDoomedStep();

    await expect(
      repository.applyRuntimeMutationPostgres(payload(), answerTo(DOOMED_STEP_ID, 3))
    ).resolves.toBeTruthy();

    const rows = await storedResponses();
    // The answer to the live question survived - the whole point of the save
    // not aborting.
    expect(rows).toContainEqual(
      expect.objectContaining({ study_id: STUDY_ID, step_id: LIVE_STEP_ID })
    );
    // And the orphaned answer was kept, detached, under the wording the
    // participant was actually shown.
    expect(rows).toContainEqual(
      expect.objectContaining({
        study_id: null,
        step_id: null,
        step_prompt: DOOMED_PROMPT_AS_SHOWN,
        response_payload: { rating: 3 }
      })
    );
  });

  it("detaches a stored answer rather than destroying it when its question is removed", async () => {
    // ON DELETE SET NULL over the composite key, asserted by deleting a step
    // and reading the row back. Were the foreign key CASCADE, this row would
    // simply be gone.
    const repository = await importRepository();
    await repository.applyRuntimeMutationPostgres(payload(), answerTo(DOOMED_STEP_ID, 4));

    await removeDoomedStep();

    expect(await storedResponses()).toEqual([
      expect.objectContaining({
        study_id: null,
        step_id: null,
        step_prompt: DOOMED_PROMPT_AS_SHOWN,
        response_payload: { rating: 4 }
      })
    ]);
  });

  it("files an answer as detached rather than adopting a same-named step from another study", async () => {
    // THE SCOPE ON THE ATTACHMENT LOOKUP, which nothing else here evaluates.
    //
    // `study_steps` is keyed on the PAIR (study_id, id), so the same step id
    // can legitimately exist in two studies - and the CTE that reads the step
    // back is what decides which of them an answer is filed against. Scoped to
    // `ss.id` alone it would resolve the OTHER study's row, and the composite
    // foreign key would raise nothing, because the pair it was handed is a
    // real one. One participant's answer would simply appear in a different
    // researcher's results, correctly attached, under their question.
    //
    // Provoked by removing this study's copy first, so exactly one row in the
    // table carries the id and the unscoped lookup has somewhere wrong to go.
    const OTHER_STUDY_ID = "study_other";
    await pool.query(
      `INSERT INTO firsthand.studies (id, title, intro_text, consent_text, kind)
       VALUES ($1, 'Somebody else', 'Intro', 'Consent', 'survey')`,
      [OTHER_STUDY_ID]
    );
    await pool.query(
      `INSERT INTO firsthand.study_steps (study_id, id, step_order, type, prompt)
       VALUES ($1, $2, 1, 'rating', 'Their question, not ours')`,
      [OTHER_STUDY_ID, DOOMED_STEP_ID]
    );

    await removeDoomedStep();

    const repository = await importRepository();
    await repository.applyRuntimeMutationPostgres(payload(), answerTo(DOOMED_STEP_ID, 3));

    // Detached, and detached means BOTH columns null - the only shape 0015's
    // CHECK permits, and the only one that keeps this answer out of the other
    // study's results.
    expect(await storedResponses()).toEqual([
      expect.objectContaining({
        study_id: null,
        step_id: null,
        step_prompt: DOOMED_PROMPT_AS_SHOWN,
        response_payload: { rating: 3 }
      })
    ]);

    // THE CONTROL. Asserting the row is not attached to OTHER_STUDY_ID proves
    // nothing on its own - a save that stored no row at all would satisfy it
    // just as well. This is what says the other study's step really is
    // reachable, so the assertion above had something to detect.
    const reachable = await pool.query(
      "SELECT id FROM firsthand.study_steps WHERE id = $1",
      [DOOMED_STEP_ID]
    );
    expect(reachable.rows).toHaveLength(1);
  });

  it("does not erase a detached answer on the next ordinary save", async () => {
    // A save DELETEs and re-INSERTs the session's responses. Without the
    // `step_id IS NOT NULL` filter on that delete, an unrelated answer to a
    // later question would take the detached row with it.
    const repository = await importRepository();
    await repository.applyRuntimeMutationPostgres(payload(), answerTo(DOOMED_STEP_ID, 4));
    await removeDoomedStep();

    await repository.applyRuntimeMutationPostgres(payload(), answerTo(LIVE_STEP_ID, 2));

    expect(await storedResponses()).toHaveLength(2);
    expect(await storedResponses()).toContainEqual(
      expect.objectContaining({
        study_id: null,
        step_id: null,
        step_prompt: DOOMED_PROMPT_AS_SHOWN
      })
    );
  });

  it("refuses to store an answer against a step id that was never in the study", async () => {
    // The hole the CHECK exists to close, from the other side. A composite
    // foreign key is MATCH SIMPLE, so a writer that left study_id NULL could
    // otherwise park any string at all in step_id and the database would raise
    // nothing - restoring exactly the unconstrained column 0015 ended.
    await expect(
      pool.query(
        `INSERT INTO firsthand.participant_responses
           (id, session_id, study_id, step_id, step_type, response_payload, saved_at)
         VALUES ('resp_bogus', 'session_1', NULL, 'a_step_that_never_existed',
                 'rating', '{"rating":1}'::jsonb, now())`
      )
    ).rejects.toThrow(/participant_responses_detached_together/);
  });
});
