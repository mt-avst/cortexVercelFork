import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestPostgres, type TestPostgres } from "../__tests__/helpers/postgres-instance";

/**
 * WHAT EACH BATCH READ ACTUALLY BROUGHT BACK, against a real database.
 *
 * The batch predicate was only HALF pinned, and the half that was missing is
 * the half that matters. `survey-csv-export.test.ts` asserts the PARAMETERS -
 * that batch one binds a hundred ids, batch two the next hundred - which kills
 * the blunt mutation where the predicate and its bind parameter are deleted
 * together. It cannot see the statement widen underneath them:
 *
 *     WHERE ${filter} AND (r.session_id = ANY($n::text[]) OR TRUE)
 *
 * keeps the parameter bound and the substring present while every batch reads
 * the study's ENTIRE answer set. Measured on the base of this branch, across
 * survey-csv-export.test.ts, survey-csv-export-postgres.test.ts,
 * survey-csv-streaming.test.ts and survey-csv.test.ts: 62 tests, 4 files,
 * exit 0, the real-Postgres one included. That is precisely the heap the
 * streamed export exists to remove, restored in full, invisible to everything.
 *
 * Nothing downstream can see it, and that is not an oversight in the tests
 * downstream. `streamParticipants` yields from the ID LIST, so the surplus rows
 * a widened read returns are grouped, ignored and dropped: the CSV bytes are
 * identical, the participant count is identical, the ordering is identical. The
 * only observable difference is how much the database was asked to hand over.
 *
 * So this file observes exactly that, and nothing else. It wraps the client the
 * repository is given - through the same `withRuntimeDatabaseClient` seam the
 * repository already calls, against the same real Postgres, running the real
 * statement - and records, per batch read, what it BOUND and what it RECEIVED.
 *
 * TWO SEPARATE PROPERTIES, because the first version of this file asserted only
 * the first and claimed both. A refute gate found the gap by mutation:
 *
 *   WHOSE rows came back - the distinct participants received, against the ids
 *   bound. This is what kills a widened predicate.
 *
 *   HOW MANY rows came back - a literal count per read. This is what kills a
 *   FAN-OUT, where the right participants come back several times over. The
 *   gate's mutation was `CROSS JOIN generate_series(1, 20) AS dup`: twenty
 *   times the rows, twenty times the heap, and the first version of this file
 *   passed it, because deduplicating into a Set to count PARTICIPANTS discards
 *   exactly the evidence. It passed the sibling suites too - the gate measured
 *   58 tests, 0 failures, over survey-csv-export.test.ts,
 *   survey-csv-export-postgres.test.ts, survey-csv-streaming.test.ts and
 *   survey-results-repository.test.ts - for the same reason every other
 *   mutation here survives them: the CSV bytes do not change.
 *
 * WHICH MAKES THE ROW COUNT THE LOAD-BEARING ASSERTION, not the detector.
 * Measured: blinding `overRead` to return `[]` for everything leaves the first
 * test still failing on every mutation in the matrix, because `returned` and
 * `rows` catch them on their own - and it fails the SECOND test by name, which
 * is what that test is for. The detector names WHY a read was wrong; the two
 * counts are what notice.
 *
 * The realistic route to a fan-out is a join-key regression, which is why the
 * fixture seeds a second ATTEMPT (see `seedParticipants`): the schema carries
 * `logical_session_id` and `attempt_number`, so `JOIN ... ON
 * s.logical_session_id = r.session_id` duplicates a participant's answers once
 * per attempt they made. With one attempt each that mutation is undetectable
 * even by a row count.
 *
 * DELIBERATELY NOT A STRING MATCH ON THE SQL. A regex over the WHERE clause
 * would close the predicate half and would be prefix-fragile in the way this
 * repository has just been bitten by: `toContain("updated_at =
 * clock_timestamp()")` passed against `clock_timestamp() - interval '1 hour'`.
 * It would also have said nothing at all about the fan-out, which is not in
 * the WHERE clause. Both properties are properties of the rows returned, so
 * both are asserted on the rows returned.
 *
 * RUNS IN CI, in `test-backend-db`, which selects by filename with
 * `vitest run postgres` and supplies a Postgres `services:` container through
 * FIRSTHAND_TEST_DATABASE_URL. cto/AdaptaLabs#20.
 */

/** One parameterised statement the repository issued, and what came back. */
type RecordedRead = {
  readonly values: readonly unknown[];
  readonly rows: readonly Record<string, unknown>[];
};

const recorded = vi.hoisted(() => [] as RecordedRead[]);

/**
 * THE SEAM. The pool, the connection, the admission cap, the statement and the
 * database are all the real ones; only the client handed to the repository is
 * wrapped, and only to write down what it was asked and what it returned.
 *
 * Wrapping here rather than patching `pg.Client.prototype` keeps the recording
 * off `prepareRuntimeSession`, which runs its `SET search_path` on the raw
 * client before `operation` is called - so every entry in `recorded` is a
 * statement the repository itself issued, and no filtering by SQL text is
 * needed to tell them apart.
 */
vi.mock("./runtime-database", async (importActual) => {
  const actual = await importActual<typeof import("./runtime-database")>();

  const recording = (client: pg.PoolClient): pg.PoolClient =>
    new Proxy(client, {
      get(target, property) {
        if (property !== "query") {
          // `target` as the receiver, not the proxy: pg's methods reach for
          // own state on the client, and a proxy receiver would send those
          // reads back through this trap for no purpose.
          return Reflect.get(target, property, target);
        }

        return async (text: string, values?: readonly unknown[]) => {
          const result = await target.query<Record<string, unknown>>(
            text,
            values as unknown[]
          );
          recorded.push({ values: values ?? [], rows: result.rows });
          return result;
        };
      }
    });

  return {
    ...actual,
    withRuntimeDatabaseClient: <T,>(
      operation: (client: pg.PoolClient) => Promise<T>,
      options?: Parameters<typeof actual.withRuntimeDatabaseClient>[1]
    ) =>
      actual.withRuntimeDatabaseClient(
        (client) => operation(recording(client)),
        options
      )
  };
});

const execFileAsync = promisify(execFile);
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

const migrateScript = path.resolve(__dirname, "../../scripts/firsthand-migrate.mjs");

const STUDY_ID = "study_batch_scope";
const OPPORTUNITY_ID = "opp_batch_scope";

/**
 * ONE AND A HALF BATCHES, so the boundary is crossed and the two batches are
 * different sizes.
 *
 * A fixture inside a single batch cannot see any of this: with everything in
 * one read, "read the whole study" and "read this batch" are the same rows.
 * 150 gives reads of 100 and 50, which pins the batch size from both ends -
 * a larger CSV_PARTICIPANT_BATCH collapses the two reads into one, a smaller
 * one splits them into three.
 */
const PARTICIPANTS = 150;

let databaseUrl: string;
let pool: pg.Pool;
let postgres: TestPostgres;

/**
 * The ids a read RECEIVED, deduplicated.
 *
 * Reads `session_id` defensively rather than asserting a shape, so a mutation
 * that changes the projection fails on the count below rather than throwing
 * here with a stack trace nobody can read.
 */
function returnedParticipants(rows: readonly Record<string, unknown>[]): string[] {
  const ids = rows
    .map((row) => row.session_id)
    .filter((id): id is string => typeof id === "string");
  return [...new Set(ids)];
}

/**
 * The ids a read ASKED FOR: the `text[]` it bound, or null if it bound none.
 *
 * Null is the blunt mutation - predicate and bind parameter deleted together -
 * and it is reported rather than thrown on, so that entry keeps failing here
 * by name as well as in the mocked suite.
 *
 * ponytail: reads the LAST bound parameter, because that is where this
 *   statement puts its id list. A second array parameter on the same query
 *   would need this to select by position deliberately.
 */
function askedFor(values: readonly unknown[]): string[] | null {
  const last = values[values.length - 1];
  return Array.isArray(last) && last.every((id) => typeof id === "string")
    ? (last as string[])
    : null;
}

/**
 * THE DETECTOR: participants a read returned WITHOUT asking for them.
 *
 * Its own ability to fire is proved below, on a query this file writes and
 * widens itself, because an over-read count of zero reads identically whether
 * the predicate held or the detector is blind.
 */
function overRead(read: RecordedRead): string[] {
  const asked = askedFor(read.values);
  const returned = returnedParticipants(read.rows);

  if (asked === null) {
    return returned;
  }

  const wanted = new Set(asked);
  return returned.filter((id) => !wanted.has(id));
}

/**
 * How each read behaved, in the order the reads happened.
 *
 * `rows` IS NOT REDUNDANT WITH `returned`, and the difference is the whole of
 * the fan-out defect: `returned` deduplicates, `rows` does not. A read that
 * hands back the right hundred participants twenty times each scores
 * `returned: 100, overRead: 0` and `rows: 2000`. Only one of those three
 * numbers can see it.
 */
function readShapes(reads: readonly RecordedRead[]) {
  return reads.map((read) => ({
    asked: askedFor(read.values)?.length ?? null,
    returned: returnedParticipants(read.rows).length,
    rows: read.rows.length,
    overRead: overRead(read).length
  }));
}

describe.skipIf(skipDbTests)("the CSV batch read, against real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("csv-batch-scope");
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
    recorded.length = 0;
    await pool.query("TRUNCATE firsthand.runtime_sessions CASCADE");
    await pool.query("TRUNCATE firsthand.studies CASCADE");
  });

  /**
   * ONE ANSWER PER PARTICIPANT, so the row count per read is the participant
   * count per read and both can be written down as the same literal. Any
   * duplication in the numbers below is therefore duplication the statement
   * introduced.
   *
   * PLUS ONE SECOND ATTEMPT, which is the fixture's only asymmetry and is there
   * to make a join-key regression reachable. `runtime_sessions` is keyed by
   * `(logical_session_id, attempt_number)`, so a participant who restarted has
   * two rows sharing one logical id - and `JOIN ... ON s.logical_session_id =
   * r.session_id` then returns that participant's answers twice. With one
   * attempt each, `logical_session_id` and `session_id` are equal for every row
   * and that mutation is a no-op no assertion could see.
   *
   * The second attempt carries NO ANSWERS OF ITS OWN, deliberately. The session
   * list preflight (`readCsvSessions`) reads from participant_responses, so a
   * session with no answers adds no participant: the id list stays 150 and the
   * batches stay 100 and 50. It changes the JOIN's right-hand side and nothing
   * else.
   */
  async function seedParticipants(): Promise<void> {
    await pool.query(
      `INSERT INTO firsthand.studies (id, title, intro_text, consent_text, status)
       VALUES ($1, 'Batch scope', 'Intro', 'Consent', 'launched')`,
      [STUDY_ID]
    );
    await pool.query(
      `INSERT INTO firsthand.study_steps (id, study_id, step_order, type, prompt)
       VALUES ($1, $2, 1, 'open_text', 'Question 0')`,
      [`${STUDY_ID}_q0`, STUDY_ID]
    );

    for (let p = 0; p < PARTICIPANTS; p += 1) {
      const sessionId = `b${String(p).padStart(3, "0")}`;
      await pool.query(
        `INSERT INTO firsthand.runtime_sessions
           (session_id, token, study_id, study_title, participant_id,
            participant_display_name, session_status, transcript_status,
            microphone_permission, screen_permission, recording_status,
            upload_status, created_at, updated_at, opportunity_id, steps,
            logical_session_id, attempt_number)
         VALUES ($1, $2, $3, 'Batch scope', $4, 'P', 'active', 'none',
                 'granted', 'granted', 'idle', 'idle', NOW(), NOW(), $5,
                 $6::jsonb, $1, 1)`,
        [sessionId, `tok_${sessionId}`, STUDY_ID, `user_${sessionId}`,
         OPPORTUNITY_ID, JSON.stringify([])]
      );
      await pool.query(
        `INSERT INTO firsthand.participant_responses
           (id, session_id, step_id, step_type, response_payload, saved_at,
            study_id, step_prompt)
         VALUES ($1, $2, $3, 'open_text', $4::jsonb, $5, $6, 'Question 0')`,
        [`r_${sessionId}`, sessionId, `${STUDY_ID}_q0`,
         JSON.stringify({ text: `answer ${p}` }),
         new Date(1_700_000_000_000 + p * 10_000).toISOString(), STUDY_ID]
      );
    }

    // THE SECOND ATTEMPT, on the first participant of the first batch. Its
    // logical id is `b000`, so it shares one with attempt 1 while carrying its
    // own primary key - which is exactly the shape a join on the logical id
    // fans out across.
    await pool.query(
      `INSERT INTO firsthand.runtime_sessions
         (session_id, token, study_id, study_title, participant_id,
          participant_display_name, session_status, transcript_status,
          microphone_permission, screen_permission, recording_status,
          upload_status, created_at, updated_at, opportunity_id, steps,
          logical_session_id, attempt_number)
       VALUES ('b000_attempt2', 'tok_b000_attempt2', $1, 'Batch scope',
               'user_b000', 'P', 'active', 'none', 'granted', 'granted',
               'idle', 'idle', NOW(), NOW(), $2, $3::jsonb, 'b000', 2)`,
      [STUDY_ID, OPPORTUNITY_ID, JSON.stringify([])]
    );
  }

  it("reads only the participants each batch asked for", async () => {
    await seedParticipants();

    const { openSurveyCsvExport } = await import("./survey-results-repository");
    const csvExport = await openSurveyCsvExport({ kind: "study", studyId: STUDY_ID });

    // The two preflight reads are not batch reads, and they legitimately span
    // the whole study. Cleared here rather than filtered: `openSurveyCsvExport`
    // has already awaited both, so everything recorded from this line on was
    // issued by `streamParticipants`.
    recorded.length = 0;

    const seen: string[] = [];
    for await (const participant of csvExport.participants(
      new AbortController().signal
    )) {
      seen.push(participant.sessionId);
    }

    // THE ASSERTION THE PARAMETER TEST CANNOT MAKE. `asked` is what the
    // statement bound; `returned` is the distinct participants Postgres handed
    // back; `overRead` is the difference between those two, and it is the
    // widening defect. `rows` is the UNDEDUPLICATED count, and it is the
    // fan-out defect - the one the first version of this test could not see.
    //
    // `rows` EQUALS `returned` ONLY BECAUSE THE FIXTURE SEEDS ONE ANSWER EACH,
    // and that is what makes them independent assertions rather than one
    // written twice: any read where they disagree is a read that duplicated
    // something.
    //
    // LITERALS, not CSV_PARTICIPANT_BATCH. An expectation derived from the
    // constant moves with the constant and so cannot report that the constant
    // moved - which is exactly how a widened batch size would slip through.
    // 100 and 50 also pin PARTICIPANTS: a fixture that stopped seeding gives
    // an empty array here rather than a vacuous pass.
    expect(readShapes(recorded)).toEqual([
      { asked: 100, returned: 100, rows: 100, overRead: 0 },
      { asked: 50, returned: 50, rows: 50, overRead: 0 }
    ]);

    // CONTROL. The generator yields from the id list whatever the reads
    // returned, so this cannot see a widened predicate - it is here to prove
    // the export ran at all, which the counts above are otherwise consistent
    // with.
    expect(seen).toHaveLength(150);
  }, 120_000);

  it("the over-read detector still fires on a read that took more than it bound", async () => {
    await seedParticipants();

    // The batch predicate, and the issue's mutation of it, run side by side
    // against the same rows. WITHOUT THIS the assertion above is satisfied by
    // a detector that returns an empty array for everything - the shape of
    // absence-assertion this repository has been caught by before.
    const asked = ["b000", "b001"];
    const from = `FROM firsthand.participant_responses AS r
      JOIN firsthand.runtime_sessions AS s ON s.session_id = r.session_id`;

    const narrow = await pool.query<Record<string, unknown>>(
      `SELECT r.session_id ${from}
       WHERE s.study_id = $1 AND r.session_id = ANY($2::text[])`,
      [STUDY_ID, asked]
    );
    const widened = await pool.query<Record<string, unknown>>(
      `SELECT r.session_id ${from}
       WHERE s.study_id = $1 AND (r.session_id = ANY($2::text[]) OR TRUE)`,
      [STUDY_ID, asked]
    );

    expect(overRead({ values: [STUDY_ID, asked], rows: narrow.rows })).toEqual([]);
    // 148, not `PARTICIPANTS - asked.length`: the number is written down so a
    // fixture that stops seeding fails here instead of quietly agreeing with
    // itself.
    expect(overRead({ values: [STUDY_ID, asked], rows: widened.rows })).toHaveLength(
      148
    );

    // AND THE OTHER BLIND SPOT: a read that bound no id list at all is the
    // blunt mutation, and it must not read as "asked for nothing, took
    // nothing".
    expect(askedFor([STUDY_ID])).toBeNull();
    expect(
      overRead({ values: [STUDY_ID], rows: widened.rows })
    ).toHaveLength(150);
  }, 120_000);

  /**
   * ONE PERSON, MANY SESSIONS, STILL BOUNDED READS (cto/AdaptaLabs#152).
   *
   * An abandoned session earns a fresh mint, so one account can hold any
   * number of answer-carrying sessions. An intermediate version of #152
   * batched by PERSON and read all of one such account in a single statement
   * (~100MB, measured by the security gate). Batches are cut from SESSIONS,
   * so the reads below stay a hundred sessions each however many one person
   * holds - literals, like the test above.
   */
  it("reads one person's many sessions a hundred at a time", async () => {
    await pool.query(
      `INSERT INTO firsthand.studies (id, title, intro_text, consent_text, status)
       VALUES ($1, 'Batch scope', 'Intro', 'Consent', 'launched')`,
      [STUDY_ID]
    );
    await pool.query(
      `INSERT INTO firsthand.study_steps (id, study_id, step_order, type, prompt)
       VALUES ($1, $2, 1, 'open_text', 'Question 0')`,
      [`${STUDY_ID}_q0`, STUDY_ID]
    );
    await pool.query(
      `INSERT INTO firsthand.runtime_sessions
         (session_id, token, study_id, study_title, participant_id,
          participant_display_name, session_status, transcript_status,
          microphone_permission, screen_permission, recording_status,
          upload_status, created_at, updated_at, opportunity_id, steps,
          logical_session_id, attempt_number)
       SELECT 'many_' || n, 'tok_many_' || n, $1, 'Batch scope', 'user_many', 'P',
              'abandoned', 'none', 'granted', 'granted', 'idle', 'idle',
              NOW(), NOW(), $2, '[]'::jsonb, 'many_' || n, 1
       FROM generate_series(1, 250) AS n`,
      [STUDY_ID, OPPORTUNITY_ID]
    );
    await pool.query(
      `INSERT INTO firsthand.participant_responses
         (id, session_id, step_id, step_type, response_payload, saved_at,
          study_id, step_prompt)
       SELECT 'r_many_' || n, 'many_' || n, $1, 'open_text',
              jsonb_build_object('text', 'answer ' || n),
              TIMESTAMPTZ '2026-09-21 09:00:00+00' + n * INTERVAL '1 second',
              $2, 'Question 0'
       FROM generate_series(1, 250) AS n`,
      [`${STUDY_ID}_q0`, STUDY_ID]
    );

    const { openSurveyCsvExport } = await import("./survey-results-repository");
    const csvExport = await openSurveyCsvExport({ kind: "study", studyId: STUDY_ID });
    recorded.length = 0;

    let flagged = 0;
    let rows = 0;
    for await (const row of csvExport.participants(new AbortController().signal)) {
      rows += 1;
      if (row.superseded) flagged += 1;
    }

    expect(readShapes(recorded)).toEqual([
      { asked: 100, returned: 100, rows: 100, overRead: 0 },
      { asked: 100, returned: 100, rows: 100, overRead: 0 },
      { asked: 50, returned: 50, rows: 50, overRead: 0 }
    ]);
    // And the flag still sees across the batches it was not read in: every
    // session but the latest holds a superseded answer.
    expect(rows).toBe(250);
    expect(flagged).toBe(249);
  }, 120_000);
});
