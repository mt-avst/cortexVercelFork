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
let participantRows: Array<{ session_id: string }> = [];
let answerRows: Array<Record<string, unknown>> = [];
let removedRows: Array<{ step_type: string; step_prompt: string | null }> = [];

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
          if (sql.includes("GROUP BY r.step_type")) return { rows: removedRows };
          if (sql.includes("GROUP BY r.session_id")) return { rows: participantRows };
          return { rows: answerRows };
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

const scope = { kind: "study" as const, studyId: "study_abc" };

async function drain() {
  const csvExport = await openSurveyCsvExport(scope);
  const seen: string[] = [];
  for await (const participant of csvExport.participants()) {
    seen.push(participant.sessionId);
  }
  return { csvExport, seen };
}

describe("opening and draining a CSV export", () => {
  beforeEach(() => {
    checkouts.length = 0;
    open = 0;
    removedRows = [];
    answerRows = [];
    participantRows = Array.from({ length: 250 }, (_u, i) => ({
      session_id: `s${i}`
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
    // the `session_id = ANY(...)` predicate AND its parameter together changes
    // nothing anybody can see. It survived every test in four files, including
    // the real-Postgres one, because that file only ever compares output.
    //
    // What it changes is that each batch loads the study's whole answer set,
    // N/100 times over: the exact heap this MR exists to remove, paid
    // repeatedly. So the assertion is on the PARAMETERS - what was asked for -
    // rather than on the answer.
    const batches = checkouts
      .filter((entry) => entry.sql.some((sql) => sql.includes("r.session_id = ANY")))
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

    const iterator = csvExport.participants();
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

    const iterator = csvExport.participants();
    await iterator.next();
    await iterator.return(undefined);

    // One batch, not three. A caller who hangs up mid-download must not go on
    // costing pool checkouts for a file nobody is reading.
    expect(checkouts.length - before).toBe(1);
  });

  it("yields participants in the order the id list gives, not the order rows arrive", async () => {
    participantRows = [{ session_id: "b" }, { session_id: "a" }, { session_id: "c" }];
    answerRows = [
      { session_id: "c", step_id: "q1", step_prompt: null, step_type: "open_text", response_payload: {}, saved_at: "2026-08-21T10:00:00.000Z" },
      { session_id: "a", step_id: "q1", step_prompt: null, step_type: "open_text", response_payload: {}, saved_at: "2026-08-21T10:00:00.000Z" }
    ];

    const { seen } = await drain();

    // The id list carries first-answer order, which is what makes the streamed
    // export byte-identical to the unbatched one. A batch query's own row
    // order is not that.
    expect(seen).toEqual(["b", "a", "c"]);
  });

  it("yields a participant with no rows rather than skipping them", async () => {
    participantRows = [{ session_id: "ghost" }];
    answerRows = [];

    const { seen } = await drain();

    expect(seen).toEqual(["ghost"]);
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
      entry.sql.some((sql) => sql.includes("GROUP BY r.session_id"))
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
      session_id: `s${i}`
    }));

    await expect(openSurveyCsvExport(scope)).resolves.toBeDefined();
  });

  it("refuses before yielding anything when there are too many participants", async () => {
    participantRows = Array.from({ length: 200_001 }, (_u, i) => ({
      session_id: `s${i}`
    }));

    // A 413 is impossible once the response has started, so the bound has to
    // be decided while the caller is still awaiting `open`.
    await expect(openSurveyCsvExport(scope)).rejects.toMatchObject({
      statusCode: 413
    });
  });
});
