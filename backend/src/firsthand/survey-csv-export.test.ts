import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE POINT OF STREAMING HERE IS NOT SPEED, IT IS OCCUPANCY.
 *
 * A server-side cursor or `COPY` is the obvious way to stream an export, and
 * it is the wrong one on this pool: either holds a runtime connection open for
 * the whole download, which is exactly the defect the admission cap in
 * runtime-pool-admission.ts exists to close. Streaming the export by inverting
 * that fix would be a poor trade.
 *
 * So what these assert is the shape of the reads - how many checkouts, how long
 * each is held, and that nothing is held between batches - rather than the
 * bytes, which survey-csv-streaming.test.ts owns.
 */

/** Each entry is one checkout: the SQL it ran and the options it asked for. */
const checkouts: Array<{
  sql: string[];
  params: unknown[][];
  options?: { statementTimeoutMs?: number };
  openWhileAnotherWasOpen: boolean;
}> = [];

let open = 0;
let participantRows: Array<{ participant_id: string }> = [];
/**
 * What a batch read returns. `null` answers every batch with ONE row per
 * person it asked for - session id equal to the person's id - because the
 * export builds its sessions from the rows, and a batch returning nothing
 * now yields nothing (cto/AdaptaLabs#152).
 */
let answerRows: Array<Record<string, unknown>> | null = null;
let removedRows: Array<{ step_type: string; step_prompt: string | null }> = [];

/**
 * A hook the tests use to make a read FAIL, by SQL.
 *
 * Thrown from `query` rather than from admission, which is where a real
 * refusal comes from. The retry wraps the whole `withRuntimeDatabaseClient`
 * call, so the two are indistinguishable to it - and throwing from `query` is
 * the only place this fake can tell a batch read from a preflight.
 */
let onQuery: (sql: string) => void = () => {};

vi.mock("./runtime-database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-database")>()),
  isPostgresRuntimeConfigured: () => true,
  withRuntimeDatabaseClient: async (
    run: (client: {
      query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
    }) => Promise<unknown>,
    options?: { statementTimeoutMs?: number }
  ) => {
    const entry = {
      sql: [] as string[],
      params: [] as unknown[][],
      options,
      openWhileAnotherWasOpen: open > 0
    };
    checkouts.push(entry);
    open += 1;

    try {
      return await run({
        query: async (sql: string, params: unknown[] = []) => {
          entry.sql.push(sql);
          entry.params.push(params);
          onQuery(sql);
          if (sql.includes("GROUP BY r.step_type")) return { rows: removedRows };
          if (sql.includes("GROUP BY s.participant_id")) return { rows: participantRows };
          if (answerRows !== null) return { rows: answerRows };
          const asked = (params[params.length - 1] ?? []) as string[];
          return {
            rows: asked.map((id) => ({
              session_id: id,
              participant_id: id,
              step_id: "q1",
              step_prompt: null,
              step_type: "open_text",
              response_payload: {},
              saved_at: "2026-08-21T10:00:00.000Z"
            }))
          };
        }
      });
    } finally {
      open -= 1;
    }
  }
}));

vi.mock("../utils/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { openSurveyCsvExport } from "./survey-results-repository";
import { RESULTS_STATEMENT_TIMEOUT_MS } from "./runtime-database";
import {
  RuntimeDatabaseAdmissionTimeoutError,
  RuntimeDatabaseBusyError
} from "./runtime-pool-admission";

const IS_BATCH = (sql: string) => sql.includes("s.participant_id = ANY");
const IS_PARTICIPANT_PREFLIGHT = (sql: string) =>
  sql.includes("GROUP BY s.participant_id");

const scope = { kind: "study" as const, studyId: "study_abc" };

async function drain() {
  const csvExport = await openSurveyCsvExport(scope);
  const seen: string[] = [];
  for await (const participant of csvExport.participants(new AbortController().signal)) {
    seen.push(participant.sessionId);
  }
  return { csvExport, seen };
}

describe("opening and draining a CSV export", () => {
  beforeEach(() => {
    checkouts.length = 0;
    open = 0;
    onQuery = () => {};
    removedRows = [];
    answerRows = null;
    participantRows = Array.from({ length: 250 }, (_u, i) => ({
      participant_id: `s${i}`
    }));
  });

  it("takes one checkout per batch, and never holds one across a batch boundary", async () => {
    const { seen } = await drain();

    expect(seen).toHaveLength(250);

    // Two preflight reads (removed columns, participant ids) plus one per
    // batch of 100. If this ever reads 3, somebody has replaced the batching
    // with a cursor and the connection is being held for the whole export.
    expect(checkouts).toHaveLength(2 + 3);
    expect(checkouts.every((entry) => !entry.openWhileAnotherWasOpen)).toBe(true);
  });

  it("asks each batch for ITS OWN hundred ids, and never for everything", async () => {
    const { seen } = await drain();
    expect(seen).toHaveLength(250);

    // THE PROPERTY THE BYTES CANNOT SHOW. `streamParticipants` yields
    // `for (const sessionId of batch)`, so the output is identical whether the
    // batch read fetched 100 participants or all 250 - which means deleting
    // the `participant_id = ANY(...)` predicate AND its parameter together changes
    // nothing anybody can see. It survived every test in four files, including
    // the real-Postgres one, because that file only ever compares output.
    //
    // What it changes is that each batch loads the study's whole answer set,
    // N/100 times over: the exact heap this MR exists to remove, paid
    // repeatedly. So the assertion is on the PARAMETERS - what was asked for -
    // rather than on the answer.
    const batches = checkouts
      .filter((entry) => entry.sql.some((sql) => sql.includes("s.participant_id = ANY")))
      .map((entry) => entry.params[0]?.at(-1) as string[]);

    expect(batches).toHaveLength(3);
    expect(batches.map((ids) => ids.length)).toEqual([100, 100, 50]);

    // Every participant asked for exactly once, and the union is the id list -
    // so a batch that quietly widened its own scope fails here too.
    const asked = batches.flat();
    expect(asked).toHaveLength(250);
    expect(new Set(asked).size).toBe(250);
    expect(asked).toEqual(seen);
  });

  it("holds no connection while the consumer is slow", async () => {
    const csvExport = await openSurveyCsvExport(scope);
    const checkoutsAfterOpen = checkouts.length;

    const iterator = csvExport.participants(new AbortController().signal);
    await iterator.next();

    // A slow client is the case that matters: between yields there must be
    // nothing checked out, or a participant on a bad connection would hold a
    // fifth of the pool for as long as their download took.
    expect(open).toBe(0);
    expect(checkouts.length).toBeGreaterThan(checkoutsAfterOpen);

    await iterator.return(undefined);
  });

  it("gives every read the loose statement bound, not the default", async () => {
    await drain();

    for (const entry of checkouts) {
      expect(entry.options?.statementTimeoutMs).toBe(RESULTS_STATEMENT_TIMEOUT_MS);
    }
  });

  it("stops reading batches when the consumer stops asking", async () => {
    const csvExport = await openSurveyCsvExport(scope);
    const before = checkouts.length;

    const iterator = csvExport.participants(new AbortController().signal);
    await iterator.next();
    await iterator.return(undefined);

    // One batch, not three. A caller who hangs up mid-download must not go on
    // costing pool checkouts for a file nobody is reading.
    expect(checkouts.length - before).toBe(1);
  });

  it("yields participants in the order the id list gives, not the order rows arrive", async () => {
    participantRows = [{ participant_id: "b" }, { participant_id: "a" }, { participant_id: "c" }];
    answerRows = [
      { session_id: "c", participant_id: "c", step_id: "q1", step_prompt: null, step_type: "open_text", response_payload: {}, saved_at: "2026-08-21T10:00:00.000Z" },
      { session_id: "a", participant_id: "a", step_id: "q1", step_prompt: null, step_type: "open_text", response_payload: {}, saved_at: "2026-08-21T10:00:00.000Z" },
      { session_id: "b", participant_id: "b", step_id: "q1", step_prompt: null, step_type: "open_text", response_payload: {}, saved_at: "2026-08-21T10:00:00.000Z" }
    ];

    const { seen } = await drain();

    // The id list carries first-answer order, which is what makes the streamed
    // export byte-identical to the unbatched one. A batch query's own row
    // order is not that.
    expect(seen).toEqual(["b", "a", "c"]);
  });

  it("yields every session one person holds, together, in first-answer order", async () => {
    // cto/AdaptaLabs#152. A person's sessions are ADJACENT in the export so a
    // researcher comparing them is not hunting through the file, and the
    // superseded flag is computed with both in hand.
    participantRows = [{ participant_id: "p1" }, { participant_id: "p2" }];
    answerRows = [
      { session_id: "p1-old", participant_id: "p1", step_id: "q1", step_prompt: null, step_type: "open_text", response_payload: { text: "before" }, saved_at: "2026-08-21T10:00:00.000Z" },
      { session_id: "p2-only", participant_id: "p2", step_id: "q1", step_prompt: null, step_type: "open_text", response_payload: { text: "other" }, saved_at: "2026-08-21T11:00:00.000Z" },
      { session_id: "p1-new", participant_id: "p1", step_id: "q1", step_prompt: null, step_type: "open_text", response_payload: { text: "after" }, saved_at: "2026-08-22T10:00:00.000Z" }
    ];

    const csvExport = await openSurveyCsvExport(scope);
    const rows: Array<{ sessionId: string; participantId: string | null; superseded: boolean }> = [];
    for await (const row of csvExport.participants(new AbortController().signal)) {
      rows.push({ sessionId: row.sessionId, participantId: row.participantId, superseded: row.superseded });
    }

    expect(rows).toEqual([
      { sessionId: "p1-old", participantId: "p1", superseded: true },
      { sessionId: "p1-new", participantId: "p1", superseded: false },
      { sessionId: "p2-only", participantId: "p2", superseded: false }
    ]);
  });

  it("yields nothing for a person whose answers vanished before their batch", async () => {
    // A retake cascades the old session's rows away between the preflight and
    // the batch. The export builds sessions from the rows it read, so the
    // person is an ABSENCE - never a row of empty cells in somebody's
    // response-rate denominator.
    participantRows = [{ participant_id: "ghost" }];
    answerRows = [];

    const { seen } = await drain();

    expect(seen).toEqual([]);
  });

  it("asks the database for one participant more than it will return", async () => {
    await openSurveyCsvExport(scope);

    // THE +1 IS THE DETECTOR, and without this assertion losing it is
    // invisible. `LIMIT ${MAX_CSV_PARTICIPANTS + 1}` -> `LIMIT
    // ${MAX_CSV_PARTICIPANTS}` makes `rows.length > MAX_CSV_PARTICIPANTS`
    // unsatisfiable, so the 413 becomes unreachable and a 200,001-participant
    // study quietly exports the first 200,000 as a CSV that parses - refusal
    // turned into truncation, which is the one outcome this file's own
    // headline forbids. That mutation survived all 824 jest and all 602 vitest
    // tests.
    //
    // A LITERAL, not `MAX_CSV_PARTICIPANTS + 1`. An expectation computed from
    // the constant moves with it and so cannot report that it moved - the same
    // reason survey-results-repository.test.ts spells out `LIMIT 200001` for
    // the row bound, which is the template this copies.
    const listing = checkouts.find((entry) =>
      entry.sql.some((sql) => sql.includes("GROUP BY s.participant_id"))
    );

    // The control: `find` returning undefined would make any assertion on it
    // vacuous, and a renamed query would do exactly that.
    expect(listing).toBeDefined();
    expect(listing?.sql.join("\n")).toContain("LIMIT 200001");
  });

  it("admits a set that exactly fills the bound", async () => {
    // THE ACCEPTING SIDE. Only the refusing side was pinned, so `>` becoming
    // `>=` survived every test in this repository - and in production that
    // turns the largest legitimate export into a 413 that names a limit it has
    // not actually reached. A boundary needs both of its sides.
    participantRows = Array.from({ length: 200_000 }, (_u, i) => ({
      participant_id: `s${i}`
    }));

    await expect(openSurveyCsvExport(scope)).resolves.toBeDefined();
  });

  it("refuses before yielding anything when there are too many participants", async () => {
    participantRows = Array.from({ length: 200_001 }, (_u, i) => ({
      participant_id: `s${i}`
    }));

    // A 413 is impossible once the response has started, so the bound has to
    // be decided while the caller is still awaiting `open`.
    await expect(openSurveyCsvExport(scope)).rejects.toMatchObject({
      statusCode: 413
    });
  });
});

/**
 * ONE BUSY-POOL REFUSAL MUST NOT DESTROY A MINUTES-OLD DOWNLOAD
 * (cto/AdaptaLabs#6).
 *
 * Batching bought the occupancy fix at the cost of attempt count: `2 +
 * ceil(N/100)` admission attempts where the unbatched reader made one. Before
 * the first byte a refusal is a clean 503 the caller can retry; after it the
 * status is already 200, so the only honest failure left is a destroyed
 * socket - a researcher watching a download of several minutes break with no
 * explanation.
 *
 * So the BATCH read retries and the PREFLIGHT does not, and both halves of
 * that are asserted. A test that only proved the retry works would not notice
 * a retry quietly added in front of the honest, immediate 503.
 */
describe("retrying a batch read the runtime pool refused", () => {
  beforeEach(() => {
    checkouts.length = 0;
    open = 0;
    onQuery = () => {};
    removedRows = [];
    answerRows = null;
    participantRows = Array.from({ length: 250 }, (_u, i) => ({
      participant_id: `s${i}`
    }));
  });

  it("survives a refusal mid-export and still returns every participant", async () => {
    let attempts = 0;
    onQuery = (sql) => {
      if (!IS_BATCH(sql)) return;
      attempts += 1;
      // The SECOND batch is refused once. Mid-export on purpose: a refusal on
      // the first batch is nearly the pre-streaming case, and the download
      // that hurts to lose is the one already minutes old.
      if (attempts === 2) {
        throw new RuntimeDatabaseAdmissionTimeoutError(10_000);
      }
    };

    const { seen } = await drain();

    expect(seen).toHaveLength(250);
    // Three batches plus the one retry. Asserted rather than inferred from
    // `seen`, because a retry that silently re-read the WHOLE study would also
    // produce 250 participants.
    expect(attempts).toBe(4);
    expect(new Set(seen).size).toBe(250);
  });

  it("gives up after exactly three retries rather than forever", async () => {
    let attempts = 0;
    onQuery = (sql) => {
      if (!IS_BATCH(sql)) return;
      attempts += 1;
      throw new RuntimeDatabaseAdmissionTimeoutError(10_000);
    };

    const startedAt = Date.now();
    await expect(drain()).rejects.toMatchObject({ statusCode: 503 });
    const elapsed = Date.now() - startedAt;

    // THE BACKOFF GROWS, and this is what says so. 250 + 500 + 1000 is 1750ms;
    // a flat 250ms backoff spends 750 and nothing else here can tell the two
    // apart. A LOWER bound only - `setTimeout` never fires early, so this
    // cannot flake upward on a loaded machine.
    expect(elapsed).toBeGreaterThanOrEqual(1_700);

    // FOUR, AS A LITERAL: the first attempt plus CSV_BATCH_RETRY_ATTEMPTS.
    // Derived from the constant this could not report that the constant moved,
    // and an unbounded retry here is an export that never gives the permit
    // back - the defect cto/AdaptaLabs#5 is about, reintroduced through the
    // fix for this one.
    expect(attempts).toBe(4);
  });

  it("does not retry the preflight, whose refusal is the honest 503", async () => {
    let attempts = 0;
    onQuery = (sql) => {
      if (!IS_PARTICIPANT_PREFLIGHT(sql)) return;
      attempts += 1;
      throw new RuntimeDatabaseBusyError();
    };

    await expect(openSurveyCsvExport(scope)).rejects.toMatchObject({
      statusCode: 503
    });

    // ONE. The preflight runs before a byte is written, so its refusal reaches
    // the caller as a 503 they can act on immediately. A retry in front of it
    // makes an admin wait half a minute to be told to try again.
    expect(attempts).toBe(1);
  });

  it("does not retry a failure that is not a capacity refusal", async () => {
    let attempts = 0;
    onQuery = (sql) => {
      if (!IS_BATCH(sql)) return;
      attempts += 1;
      throw new Error('relation "participant_responses" does not exist');
    };

    await expect(drain()).rejects.toThrow("does not exist");

    // A schema error, a syntax error or a dropped connection are not going to
    // fix themselves. Retrying them spends the export's deadline and then
    // fails anyway.
    expect(attempts).toBe(1);
  });

  it("abandons its backoff the moment the export deadline fires", async () => {
    const deadline = new AbortController();
    let attempts = 0;
    onQuery = (sql) => {
      if (!IS_BATCH(sql)) return;
      attempts += 1;
      deadline.abort(new Error("export deadline"));
      throw new RuntimeDatabaseAdmissionTimeoutError(10_000);
    };

    const csvExport = await openSurveyCsvExport(scope);
    const iterator = csvExport.participants(deadline.signal);

    await expect(iterator.next()).rejects.toThrow("export deadline");
    // Not four. A backoff that slept through the deadline would hold the only
    // results-read permit past the bound that exists to release it.
    expect(attempts).toBe(1);
  });

  it("abandons a backoff already under way when the deadline fires", async () => {
    // The other half of the abandonment. Above, the deadline had already
    // fired before the sleep began; here it fires DURING it, which is the path
    // through the abort listener rather than the already-aborted check. With
    // only one of the two covered, removing either is invisible.
    const deadline = new AbortController();
    let attempts = 0;
    onQuery = (sql) => {
      if (!IS_BATCH(sql)) return;
      attempts += 1;
      setTimeout(() => deadline.abort(new Error("export deadline")), 50);
      throw new RuntimeDatabaseAdmissionTimeoutError(10_000);
    };

    const csvExport = await openSurveyCsvExport(scope);
    const iterator = csvExport.participants(deadline.signal);

    await expect(iterator.next()).rejects.toThrow("export deadline");
    expect(attempts).toBe(1);
  });

  it("throws rather than ending quietly when the deadline fires between batches", async () => {
    const deadline = new AbortController();
    const csvExport = await openSurveyCsvExport(scope);
    const iterator = csvExport.participants(deadline.signal);

    const seen: string[] = [];
    let threw: unknown;

    await iterator.next();
    seen.push("first");
    deadline.abort(new Error("export deadline"));

    try {
      // The rest of batch one is already in hand, so this runs on to the batch
      // boundary, which is where the check lives.
      for (let i = 0; i < 250; i += 1) {
        const next = await iterator.next();
        if (next.done) break;
        seen.push(next.value.sessionId);
      }
    } catch (error) {
      threw = error;
    }

    // A RETURN HERE WOULD BE SILENT DATA LOSS. The consumer's `for await` ends
    // normally on a return, and its normal ending calls `res.end()` - handing
    // the researcher a CSV that parses and holds the first hundred
    // participants of two hundred and fifty.
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toBe("export deadline");
    expect(seen.length).toBeLessThan(250);
  });
});
