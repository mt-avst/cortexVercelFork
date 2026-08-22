import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { EventEmitter } from "node:events";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../__tests__/helpers/postgres-instance";

/**
 * THE STREAMED EXPORT, AGAINST A REAL DATABASE.
 *
 * `survey-csv-export.test.ts` mocks `withRuntimeDatabaseClient` and dispatches
 * on `sql.includes(...)`, returning canned rows. It pins the SHAPE of the reads
 * - how many checkouts, how long each is held - and it is right to. What it
 * cannot see is the SQL itself: its predicate, its parameters, its ordering.
 *
 * A review gate demonstrated the cost by mutation. Deleting the batch predicate
 * entirely -
 *
 *     WHERE ${filter} AND r.session_id = ANY($n::text[])   ->   WHERE ${filter}
 *
 * - makes every batch read the study's whole answer set, N/100 times over,
 * which is strictly worse than the unbatched code this replaced. The suite
 * stayed green. So did a wrong parameter index, which in production breaks
 * every export past the preflight. Nine of thirteen mutations survived, and
 * none of them failed anything by name.
 *
 * So these tests never assert on SQL text. They seed rows Postgres actually
 * accepted, run the export, and compare the BYTES against `toResponsesCsv`
 * over the same rows - the oracle the streamed emitters were factored out of.
 * A test that restates the statement cannot detect drift from it; a test that
 * compares two readings of the same data can.
 *
 * RUNS IN CI, in the `test-backend-db` job, which supplies a Postgres
 * `services:` container through FIRSTHAND_TEST_DATABASE_URL. It used to be
 * skipped there - the runners are `no-docker` and this file could only get a
 * database by starting a container - and that skip was the single most
 * expensive thing about it: collapsing the export's tenant scope passed 588
 * tests while the one file that could see it sat switched off.
 *
 * It still starts its own container when no server is supplied, so a local run
 * needs Docker and behaves exactly as before.
 */
const execFileAsync = promisify(execFile);
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

const migrateScript = path.resolve(__dirname, "../../scripts/firsthand-migrate.mjs");

const STUDY_ID = "study_export";
const OPPORTUNITY_ID = "opp_export";
const OTHER_STUDY_ID = "study_other";
const OTHER_OPPORTUNITY_ID = "opp_other";

/** Enough participants to cross several batches of 100. */
const PARTICIPANTS = 250;
const QUESTIONS = 6;

/**
 * Removed-question columns, in INSERTION order. Their required order - by
 * first appearance - is the reverse, which is the only reason a missing
 * ORDER BY on that query is detectable at all.
 */
const REMOVED_PROMPTS = [
  "Deleted fourth",
  "Deleted third",
  "Deleted second",
  "Deleted first"
];

let databaseUrl: string;
let pool: pg.Pool;
let postgres: TestPostgres;

/**
 * The study and its steps must exist first.
 *
 * 0015 added a COMPOSITE FOREIGN KEY from `participant_responses(study_id,
 * step_id)` to `study_steps`, so an answer cannot be inserted against a
 * question the study does not have. The mocked suite never sees that - no
 * constraint is ever evaluated there - and it is exactly the class of thing
 * this file exists to run against a real database.
 */
async function seedStudy(studyId: string) {
  await pool.query(
    `INSERT INTO firsthand.studies (id, title, intro_text, consent_text, status)
     VALUES ($1, 'Export', 'Intro', 'Consent', 'launched')`,
    [studyId]
  );

  for (let q = 0; q < QUESTIONS; q += 1) {
    await pool.query(
      `INSERT INTO firsthand.study_steps
         (id, study_id, step_order, type, prompt)
       VALUES ($1, $2, $3, 'open_text', $4)`,
      [`${studyId}_q${q}`, studyId, q + 1, `Question ${q}`]
    );
  }
}

async function seedSession(input: {
  sessionId: string;
  studyId: string;
  opportunityId: string;
}) {
  await pool.query(
    `INSERT INTO firsthand.runtime_sessions
       (session_id, token, study_id, study_title, participant_id,
        participant_display_name, session_status, transcript_status,
        microphone_permission, screen_permission, recording_status,
        upload_status, created_at, updated_at, opportunity_id, steps,
        logical_session_id, attempt_number)
     VALUES ($1, $2, $3, 'Export', $4, 'P', 'active', 'none', 'granted',
             'granted', 'idle', 'idle', NOW(), NOW(), $5, $6::jsonb, $1, 1)`,
    [input.sessionId, `tok_${input.sessionId}`, input.studyId,
     `user_${input.sessionId}`, input.opportunityId, JSON.stringify([])]
  );
}

async function seedAnswer(input: {
  id: string;
  sessionId: string;
  studyId: string | null;
  stepId: string | null;
  stepType: string;
  prompt: string | null;
  payload: unknown;
  savedAt: string;
}) {
  await pool.query(
    `INSERT INTO firsthand.participant_responses
       (id, session_id, step_id, step_type, response_payload, saved_at,
        study_id, step_prompt)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    [input.id, input.sessionId, input.stepId, input.stepType,
     JSON.stringify(input.payload), input.savedAt, input.studyId, input.prompt]
  );
}

describe.skipIf(skipDbTests)("the streamed CSV export, against real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("csv-export");
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
    // Both, and studies CASCADEs into study_steps and thence into the
    // composite foreign key 0015 put on participant_responses.
    await pool.query("TRUNCATE firsthand.runtime_sessions CASCADE");
    await pool.query("TRUNCATE firsthand.studies CASCADE");
  });

  /** Rows that exercise every shape the CSV has to get right. */
  async function seedStudyRows() {
    await seedStudy(STUDY_ID);

    for (let p = 0; p < PARTICIPANTS; p += 1) {
      const sessionId = `s${String(p).padStart(3, "0")}`;
      await seedSession({ sessionId, studyId: STUDY_ID, opportunityId: OPPORTUNITY_ID });

      for (let q = 0; q < QUESTIONS; q += 1) {
        // Sparse, so gaps between columns are covered.
        if ((p + q) % 3 === 0) continue;
        await seedAnswer({
          id: `r_${p}_${q}`,
          sessionId,
          studyId: STUDY_ID,
          stepId: `${STUDY_ID}_q${q}`,
          stepType: "open_text",
          prompt: `Question ${q}`,
          payload: { text: `p${p} q${q}` },
          // Distinct timestamps: the ordering claim is about first-answer
          // order, and ties are a separate question this fixture avoids on
          // purpose so a failure here means the ORDER BY is wrong rather than
          // that two rows tied.
          // DESCENDING in p, so first-answer order is the REVERSE of insertion
          // order. That is deliberate and it is what makes the ORDER BY
          // observable: with timestamps rising alongside insertion, whatever
          // order Postgres happens to return rows in already matches the
          // required one, and dropping `ORDER BY MIN(saved_at)` changes
          // nothing. It survived exactly that way on the first run.
          savedAt: new Date(
            1_700_000_000_000 + (PARTICIPANTS - p) * 10_000 + q * 100
          ).toISOString()
        });
      }

      // FOUR removed questions, seeded so their first-appearance order is not
      // their insertion order. One was not enough: with a single column its
      // ordering is unobservable, and dropping the ORDER BY on the
      // removed-question query survived the whole file.
      //
      // `saved_at` here runs OPPOSITE to the loop, so the question inserted
      // first appears last.
      // A detached row whose type is NOT a question. Storable by any client
      // driving the participant API directly, and present in legacy/imported
      // rows - and until the type filter was added it became a phantom
      // "(removed question)" column that the unstreamed export never showed.
      if (p === 7) {
        await seedAnswer({
          id: `r_${p}_instruction`,
          sessionId,
          studyId: null,
          stepId: null,
          stepType: "instruction",
          prompt: "Read this first",
          payload: { text: "not an answer" },
          savedAt: new Date(1_700_000_000_000).toISOString()
        });
      }

      if (p % 25 === 0) {
        const slot = (p / 25) % REMOVED_PROMPTS.length;
        await seedAnswer({
          id: `r_${p}_gone`,
          sessionId,
          studyId: null,
          stepId: null,
          stepType: "open_text",
          prompt: REMOVED_PROMPTS[slot],
          payload: { text: `detached ${p}` },
          savedAt: new Date(
            1_700_000_000_000 + (REMOVED_PROMPTS.length - slot) * 1_000_000
          ).toISOString()
        });
      }
    }
  }

  /**
   * A SECOND OPPORTUNITY ON THE SAME STUDY, which is the case the opportunity
   * scope exists for and the one the first version of this fixture could not
   * see.
   *
   * It seeded the neighbour as a different study AND a different opportunity
   * together, so every session carrying `study_id = STUDY_ID` also carried
   * `opportunity_id = OPPORTUNITY_ID` and the two clauses selected identical
   * rows. The study-scoped and opportunity-scoped exports came out
   * byte-identical, so collapsing the opportunity scope to a study scope -
   * `kind: 'opportunity'` -> `kind: 'study'` - passed every assertion.
   *
   * That mutation is the worst outcome this product has. A study is reusable
   * by an opportunity its author did not create, so researcher A owning
   * opportunity A would receive every participant researcher B recruited under
   * B's consent wording. Found by the security gate, which reproduced it
   * against a real database rather than reasoning about it.
   *
   * This neighbour therefore carries its own marker AND its own removed
   * question, so the study export must contain both and the opportunity export
   * neither.
   */
  async function seedSecondOpportunity() {
    await seedSession({
      sessionId: "shared_1",
      studyId: STUDY_ID,
      opportunityId: OTHER_OPPORTUNITY_ID
    });
    await seedAnswer({
      id: "shared_r1",
      sessionId: "shared_1",
      studyId: STUDY_ID,
      stepId: `${STUDY_ID}_q0`,
      stepType: "open_text",
      prompt: "Question 0",
      payload: { text: "OTHER OPPORTUNITY ANSWER" },
      savedAt: new Date(1_700_000_000_000 - 1_000).toISOString()
    });
    await seedAnswer({
      id: "shared_gone",
      sessionId: "shared_1",
      studyId: null,
      stepId: null,
      stepType: "open_text",
      prompt: "Deleted in the other opportunity",
      payload: { text: "OTHER OPPORTUNITY DETACHED" },
      savedAt: new Date(1_700_000_000_000 - 2_000).toISOString()
    });
  }

  /** A different study AND a different opportunity, to catch a lost filter. */
  async function seedNeighbour() {
    await seedStudy(OTHER_STUDY_ID);
    await seedSession({
      sessionId: "other_1",
      studyId: OTHER_STUDY_ID,
      opportunityId: OTHER_OPPORTUNITY_ID
    });
    await seedAnswer({
      id: "other_r1",
      sessionId: "other_1",
      studyId: OTHER_STUDY_ID,
      stepId: `${OTHER_STUDY_ID}_q0`,
      stepType: "open_text",
      prompt: "Not yours",
      payload: { text: "SHOULD NEVER APPEAR" },
      savedAt: new Date(1_700_000_000_000).toISOString()
    });
  }

  const steps = Array.from({ length: QUESTIONS }, (_unused, q) => ({
    step_id: `${STUDY_ID}_q${q}`,
    order: q + 1,
    type: "open_text" as const,
    prompt: `Question ${q}`
  }));

  /**
   * Runs the streamed export end to end, THROUGH THE REAL WRITER, and returns
   * the bytes the socket would have received.
   *
   * This used to re-implement `writeSurveyCsv`'s loop inline, which quietly
   * made it a second implementation rather than a harness. Two consequences,
   * both measured: replacing the writer's line ending with "\n" passed this
   * file 5/5, and when the writer learned to skip participants whose answers
   * vanished, this copy did not - so the byte-for-byte claim was being made
   * about code that was no longer the code that runs.
   *
   * Driving the real writer means every assertion in this file is now about
   * production bytes, and the skip is covered against a real database rather
   * than only against a fake.
   */
  async function streamedCsv(scope: Parameters<
    typeof import("./survey-results-repository").openSurveyCsvExport
  >[0]) {
    const { openSurveyCsvExport } = await import("./survey-results-repository");
    const { writeSurveyCsv } = await import("./survey-csv-response");

    const chunks: string[] = [];
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
      end() {
        this.writableEnded = true;
      },
      destroy() {
        this.destroyed = true;
      }
    }) as unknown as import("express").Response & { destroyed: boolean };

    const csvExport = await openSurveyCsvExport(scope);
    await writeSurveyCsv(
      res,
      steps,
      csvExport.removedQuestions,
      () => csvExport.participants(new AbortController().signal),
      { studyId: "study_export" }
    );

    // The writer destroys rather than ends on failure, so a test that only
    // read the chunks would report a truncated body as a pass.
    expect(res.destroyed).toBe(false);
    return chunks.join("");
  }

  /**
   * Data rows in a CSV body, header excluded.
   *
   * THE CONTROL WITHOUT WHICH THE TWO BYTE-COMPARISONS BELOW CANNOT FAIL.
   * Both assert `streamed === oracle`, and both sides read the same database -
   * so when the fixture seeds nothing, both are a bare header row, the
   * comparison holds, every `not.toContain` is vacuous, and the test reports
   * green having exercised none of the code it names.
   *
   * Measured, not assumed. Turning all three seed helpers into no-ops fails
   * three of these five tests by name and leaves the two byte-comparisons
   * passing. The weaker `PARTICIPANTS = 0` is worse still: four of five pass,
   * because the batch test derived its own expectation from that constant.
   *
   * Splitting on the line ending is sound for THIS fixture and only because of
   * it: no seeded prompt, answer or marker contains a newline, so no quoted
   * field can span two lines. A fixture that seeds free text would need a real
   * parser here.
   */
  async function dataRows(csv: string): Promise<number> {
    const { CSV_LINE_ENDING } = await import("./survey-csv");
    return csv.split(CSV_LINE_ENDING).filter((line) => line !== "").length - 1;
  }

  it("streams byte-for-byte what the whole-string builder produces", async () => {
    await seedStudyRows();
    await seedNeighbour();

    const { listResponsesForStudy } = await import("./survey-results-repository");
    const { toResponsesCsv } = await import("./survey-csv");

    const oracle = toResponsesCsv(steps, await listResponsesForStudy(STUDY_ID));
    const streamed = await streamedCsv({ kind: "study", studyId: STUDY_ID });

    // THE ASSERTION THE MOCKED SUITE CANNOT MAKE. Both sides read the same
    // rows from the same database; only the assembly differs. A wrong
    // parameter index, a missing ORDER BY or a removed-columns query reading
    // the wrong side of `step_id IS NULL` all change these bytes.
    //
    // NOT a dropped batch predicate, which this comment used to claim. Deleting
    // `AND r.session_id = ANY(...)` together with its bind parameter leaves
    // these bytes identical - `streamParticipants` yields from the batch list
    // either way, so the extra rows each batch reads are discarded. Measured:
    // this whole file passes 5/5 under that mutation. It is caught in
    // survey-csv-export.test.ts, on the PARAMETERS, by `asks each batch for
    // ITS OWN hundred ids, and never for everything`.
    expect(streamed).toBe(oracle);
    expect(streamed).not.toContain("SHOULD NEVER APPEAR");

    // CONTROLS. `toBe` holds trivially when both sides are a bare header, and
    // `not.toContain` is satisfied by a body with nothing in it at all. 250 is
    // written here as a LITERAL on purpose: an expectation derived from
    // PARTICIPANTS moves with the fixture and so cannot report that the
    // fixture stopped seeding.
    expect(await dataRows(oracle)).toBe(250);
    expect(await dataRows(streamed)).toBe(250);
    expect(streamed).toContain("p0 q1");
  }, 120_000);

  it("scopes a per-opportunity export to that opportunity alone", async () => {
    await seedStudyRows();
    await seedNeighbour();
    await seedSecondOpportunity();

    const { listResponsesForOpportunity } = await import("./survey-results-repository");
    const { toResponsesCsv } = await import("./survey-csv");

    const oracle = toResponsesCsv(
      steps,
      await listResponsesForOpportunity({
        opportunityId: OPPORTUNITY_ID,
        studyId: STUDY_ID
      })
    );
    const streamed = await streamedCsv({
      kind: "opportunity",
      studyId: STUDY_ID,
      opportunityId: OPPORTUNITY_ID
    });

    expect(streamed).toBe(oracle);
    expect(streamed).not.toContain("SHOULD NEVER APPEAR");

    // THE ASSERTIONS THAT MAKE THE SCOPE OBSERVABLE. Both of these belong to a
    // different opportunity on the SAME study, so a study-scoped filter admits
    // them and only the opportunity clause keeps them out.
    expect(streamed).not.toContain("OTHER OPPORTUNITY ANSWER");
    expect(streamed).not.toContain("Deleted in the other opportunity");

    // THE CONTROL FOR THE TWO ABSENCE ASSERTIONS ABOVE. Neither can tell the
    // difference between "the opportunity scope kept the neighbour out" and
    // "this export returned nothing", and the second is what an empty database
    // gives them. `shared_1` belongs to the other opportunity on the SAME
    // study, so this count also fails if the scope stops excluding it.
    expect(await dataRows(oracle)).toBe(250);
    expect(await dataRows(streamed)).toBe(250);
    expect(streamed).toContain("p0 q1");
  }, 120_000);

  it("includes the whole study when the export is study-scoped", async () => {
    // The other direction, without which the assertions above are satisfied by
    // an export that returns nothing at all.
    await seedStudyRows();
    await seedSecondOpportunity();

    const streamed = await streamedCsv({ kind: "study", studyId: STUDY_ID });

    expect(streamed).toContain("OTHER OPPORTUNITY ANSWER");
    expect(streamed).toContain("Deleted in the other opportunity");
  }, 120_000);

  it("finds the removed-question columns, and only the detached rows", async () => {
    await seedStudyRows();
    // So that dropping the scope clause from THIS query leaks another
    // opportunity's deleted question prompt into a researcher's header row.
    await seedSecondOpportunity();

    const { surveyCsvColumns } = await import("./survey-results-repository");
    const columns = await surveyCsvColumns({ kind: "study", studyId: STUDY_ID });

    // A query reading `step_id IS NOT NULL` would return the six live
    // questions here; one that dropped its ORDER BY would return these four in
    // whatever order the grouping produced; and one missing the question-type
    // filter would add a fifth for the detached `instruction` row.
    // REVERSED relative to insertion, because the query orders by first
    // appearance and this fixture makes the two disagree on purpose. The
    // second opportunity's deleted question is seeded EARLIEST, so a
    // study-scoped read leads with it.
    expect(columns).toEqual([
      { type: "open_text", prompt: "Deleted in the other opportunity" },
      ...[...REMOVED_PROMPTS].reverse().map((prompt) => ({
        type: "open_text",
        prompt
      }))
    ]);

    // AND THE SAME QUERY, SCOPED TO ONE OPPORTUNITY, must not carry the
    // other's. Dropping `${filter}` from this query alone would put another
    // researcher's deleted question wording into this header row - a leak with
    // no row of data attached, which is exactly the kind that reads as
    // harmless until somebody recognises the prompt.
    const { surveyCsvColumns: scoped } = await import(
      "./survey-results-repository"
    );
    const mine = await scoped({
      kind: "opportunity",
      studyId: STUDY_ID,
      opportunityId: OPPORTUNITY_ID
    });

    expect(mine.map((c) => c.prompt)).not.toContain(
      "Deleted in the other opportunity"
    );
    expect(mine).toHaveLength(REMOVED_PROMPTS.length);
  }, 120_000);

  it("returns every participant exactly once across batch boundaries", async () => {
    await seedStudyRows();

    const { openSurveyCsvExport } = await import("./survey-results-repository");
    const csvExport = await openSurveyCsvExport({ kind: "study", studyId: STUDY_ID });

    const seen: string[] = [];
    for await (const participant of csvExport.participants(new AbortController().signal)) {
      seen.push(participant.sessionId);
    }

    // 250 across three batches of 100, each participant seen exactly once.
    //
    // This does NOT detect a dropped batch predicate, though it reads as
    // though it should. The predicate narrows what each batch READS; this loop
    // counts what the generator YIELDS, and that comes from the id list
    // regardless. Verified: predicate and bind parameter deleted together,
    // this file passes 5/5. `asks each batch for ITS OWN hundred ids, and
    // never for everything` in survey-csv-export.test.ts is what covers it,
    // by asserting the parameters each batch binds.
    //
    // LITERALS, not PARTICIPANTS. Both lines used to derive their expectation
    // from the constant, which made this test pass with the fixture seeding
    // nothing - `toHaveLength(0)` against an empty array. Setting
    // PARTICIPANTS = 0 left four of the five tests in this file green.
    // A test cannot both set a number and check it.
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    // That these 250 actually crossed a batch boundary is pinned in
    // survey-csv-export.test.ts, which asserts the three batches by their
    // PARAMETERS (100/100/50, union = the id list). Restating it here as
    // `expect(250).toBeGreaterThan(100)` would assert a fact about two
    // literals rather than about the code, so it is not restated.
  }, 120_000);
});
