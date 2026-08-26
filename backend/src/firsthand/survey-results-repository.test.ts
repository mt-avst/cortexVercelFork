import { beforeEach, describe, expect, it, vi } from "vitest";

const isPostgresRuntimeConfigured = vi.fn(() => true);
const captured: Array<{ sql: string; params: unknown[] }> = [];
const rowsToReturn: Array<Record<string, unknown>> = [];

/**
 * What the runtime pool does instead of answering, when a test asks it to fail.
 *
 * The five-connection FirstHand pool is shared with live participant sessions,
 * so "the read did not happen" is an ordinary operating state rather than an
 * exotic one, and the readers here differ in how they must answer it. Without a
 * way to make the client throw, every test in this file would only ever
 * describe the happy path.
 */
let queryFailure: Error | null = null;

/**
 * What the readers asked the pool for, checkout by checkout.
 *
 * Captured because the arguments are decisions, not plumbing: the results read
 * asks for the loose per-statement bound, and the advisory count asks to be
 * skipped rather than queued. Both are invisible in the SQL.
 */
const checkouts: Array<{ statementTimeoutMs?: number; whenBusy?: string }> = [];

/**
 * SPREADS THE REAL MODULE rather than listing its exports.
 *
 * A factory listing exports by hand does not fail where the omission is - it
 * fails wherever the missing export is first read, with a message naming this
 * file rather than the change that caused it. Adding
 * RESULTS_STATEMENT_TIMEOUT_MS to runtime-database.ts broke nine tests here
 * for a reason none of their assertions mention. Same trap !201 hit in five
 * factories at once.
 */
vi.mock("./runtime-database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-database")>()),
  isPostgresRuntimeConfigured: () => isPostgresRuntimeConfigured(),
  withRuntimeDatabaseClient: async (
    run: (client: {
      query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
    }) => Promise<unknown>,
    options?: { statementTimeoutMs?: number; whenBusy?: string }
  ) => {
    checkouts.push({ ...options });
    return run({
      query: async (sql: string, params: unknown[]) => {
        captured.push({ sql, params });
        if (queryFailure) throw queryFailure;
        return { rows: [...rowsToReturn] };
      }
    });
  }
}));

vi.mock("../utils/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import {
  answerCountsByStep,
  listResponsesForOpportunity,
  listResponsesForStudy,
  studyHasResponses,
  MAX_AGGREGATE_RESPONSE_CHARS
} from "./survey-results-repository";
import { RESULTS_STATEMENT_TIMEOUT_MS } from "./runtime-database";
import { RuntimeDatabaseBusyError } from "./runtime-pool-admission";
import { logger } from "../utils/logger";

/**
 * The WHERE clause here IS the authorisation boundary.
 *
 * The routes that call these are tested with this module mocked, so nothing
 * above this file can tell the two readers apart - a `listResponsesForOpportunity`
 * that quietly ignored its opportunity would return the study-wide set to a
 * researcher entitled only to their own, and every route test would still pass.
 */
describe("survey results readers", () => {
  beforeEach(() => {
    captured.length = 0;
    checkouts.length = 0;
    rowsToReturn.length = 0;
    queryFailure = null;
    isPostgresRuntimeConfigured.mockReturnValue(true);
  });

  const whereClauseOf = (sql: string) =>
    sql.split(/\bWHERE\b/)[1].split(/\bORDER BY\b/)[0].trim();

  describe("listResponsesForOpportunity", () => {
    it("filters on the opportunity as well as the study", async () => {
      await listResponsesForOpportunity({
        // Deliberately unalike, and neither is a substring of the other: a
        // shared value cannot tell a correct binding from a swapped one.
        opportunityId: "opportunity-777",
        studyId: "study_abc"
      });

      // Asserted as a literal rather than against the module's own string.
      // An assertion that reads the constant moves with it, so it survives the
      // clause being narrowed to the study alone.
      expect(whereClauseOf(captured[0].sql)).toBe(
        "s.study_id = $1 AND s.opportunity_id = $2"
      );
    });

    it("binds the study first and the opportunity second", async () => {
      await listResponsesForOpportunity({
        opportunityId: "opportunity-777",
        studyId: "study_abc"
      });

      // Positional, not toContain: both values appear in the array either way,
      // so a swap is only visible by index.
      expect(captured[0].params[0]).toBe("study_abc");
      expect(captured[0].params[1]).toBe("opportunity-777");
    });

    it("maps a stored row into the shape the aggregation reads", async () => {
      rowsToReturn.push({
        session_id: "session_1",
        step_id: "q1",
        step_prompt: "How easy was that?",
        step_type: "rating",
        response_payload: { rating: 4 },
        saved_at: "2026-08-17T10:00:00.000Z"
      });

      const responses = await listResponsesForOpportunity({
        opportunityId: "opportunity-777",
        studyId: "study_abc"
      });

      expect(responses).toEqual([
        {
          session_id: "session_1",
          step_id: "q1",
          step_prompt: "How easy was that?",
          step_type: "rating",
          response_payload: { rating: 4 },
          saved_at: "2026-08-17T10:00:00.000Z"
        }
      ]);
    });

    it("carries a detached answer through rather than dropping it", async () => {
      // A null step_id is a question the researcher removed after this person
      // answered it. The reader has to surface it - `removed_questions` is
      // built from exactly these rows - and the scoping join is on the SESSION,
      // so nulling the response's own study_id cannot hide it.
      rowsToReturn.push({
        session_id: "session_1",
        step_id: null,
        step_prompt: "A question that was removed",
        step_type: "open_text",
        response_payload: { text: "an answer nobody should lose" },
        saved_at: "2026-08-17T10:00:00.000Z"
      });

      const responses = await listResponsesForOpportunity({
        opportunityId: "opportunity-777",
        studyId: "study_abc"
      });

      expect(responses).toHaveLength(1);
      expect(responses[0].step_id).toBeNull();
      expect(responses[0].step_prompt).toBe("A question that was removed");
    });

    it("asks the database for the prompt each answer was given against", async () => {
      // An independent mutation pass found this gap: dropping `r.step_prompt`
      // from the SELECT left every test green. The mapper reads a column that
      // is simply not there, `step_prompt` comes back undefined on every row,
      // and both `asked_as` and `removed_questions` silently stop reporting -
      // which is the whole reason 0015 stores it.
      await listResponsesForOpportunity({
        opportunityId: "opportunity-777",
        studyId: "study_abc"
      });

      const selected = captured[0].sql
        .split(/\bSELECT\b/)[1]
        .split(/\bFROM\b/)[0];

      for (const column of ["r.session_id", "r.step_id", "r.step_prompt", "r.step_type"]) {
        expect(selected).toContain(column);
      }
    });

    it("reads nothing at all when the runtime database is not configured", async () => {
      isPostgresRuntimeConfigured.mockReturnValue(false);

      const responses = await listResponsesForOpportunity({
        opportunityId: "opportunity-777",
        studyId: "study_abc"
      });

      expect(responses).toEqual([]);
      expect(captured).toHaveLength(0);
    });
  });

  describe("the row bound", () => {
    /**
     * A loop, not `push(...rowsOf(n))`. Spreading two hundred thousand items
     * into a call exceeds the argument limit and throws RangeError, which
     * surfaces as "Maximum call stack size exceeded" and reads as a fault in
     * the repository rather than in the fixture.
     */
    const pushRows = (count: number) => {
      for (let index = 0; index < count; index += 1) {
        rowsToReturn.push({
          session_id: `session_${index}`,
          step_id: "q1",
          step_type: "rating",
          response_payload: { rating: 4 },
          saved_at: "2026-08-17T10:00:00.000Z"
        });
      }
    };

    it("asks the database for one row more than it will return", async () => {
      await listResponsesForOpportunity({ opportunityId: "o", studyId: "s" });

      // The +1 is the detector. Without it a full page is indistinguishable
      // from a complete result set.
      expect(captured[0].sql).toContain("LIMIT 200001");
    });

    it("refuses rather than truncating when the bound is passed", async () => {
      pushRows(200_001);

      // A mean, an NPS and a CSV computed over part of the data, with nothing
      // saying so, is a wrong finding presented as a finding.
      await expect(
        listResponsesForOpportunity({ opportunityId: "o", studyId: "s" })
      ).rejects.toMatchObject({ statusCode: 413 });
    });

    it("returns a result set that exactly fills the bound", async () => {
      pushRows(200_000);

      const responses = await listResponsesForOpportunity({
        opportunityId: "o",
        studyId: "s"
      });

      // Off-by-one in the other direction: refusing at the bound rather than
      // past it would refuse a study that fits.
      expect(responses).toHaveLength(200_000);
    });
  });

  /**
   * THE OPEN-TEXT BODY BOUND. cto/AdaptaLabs#9, option A.
   *
   * The row bound above does not bound the BODY: `surveyAnswerSchema.text` is a
   * bare `z.string()` with no length limit, so a handful of multi-megabyte
   * answers is a few-hundred-megabyte `res.json` - the heap that OOM-kills live
   * sessions on the 2Gi pod, and the body a stalled reader holds the one results
   * permit against. This is the SECOND 413, on total free-text characters rather
   * than row count.
   *
   * Both directions, and every free-text field, because a counter that saw only
   * `text` would pass a study whose whole payload was in `selectedOption`.
   */
  describe("the open-text body bound", () => {
    const pushAnswer = (payload: Record<string, unknown>) => {
      rowsToReturn.push({
        session_id: `session_${rowsToReturn.length}`,
        step_id: "q1",
        step_type: "open_text",
        response_payload: payload,
        saved_at: "2026-08-17T10:00:00.000Z"
      });
    };

    it("pins the character ceiling as a literal", () => {
      // A number reported to a reviewer is the literal or it is derived from
      // the thing it is meant to guard. Asserted here so a change to the
      // ceiling is a failing test, not a silent policy move.
      expect(MAX_AGGREGATE_RESPONSE_CHARS).toBe(5_000_000);
    });

    it("refuses rather than serving a body past the character ceiling", async () => {
      // One answer, one character over the line. A researcher handed a
      // few-hundred-megabyte page is a browser that hangs and a pod that may
      // OOM; the streamed CSV export is the path for a study this large.
      pushAnswer({ text: "x".repeat(MAX_AGGREGATE_RESPONSE_CHARS + 1) });

      await expect(
        listResponsesForOpportunity({ opportunityId: "o", studyId: "s" })
      ).rejects.toMatchObject({ statusCode: 413 });
    });

    it("serves a body sitting exactly on the character ceiling", async () => {
      // Refusing at the bound rather than past it would refuse a study that
      // fits - the same off-by-one the row bound guards in both directions.
      pushAnswer({ text: "x".repeat(MAX_AGGREGATE_RESPONSE_CHARS) });

      const responses = await listResponsesForOpportunity({
        opportunityId: "o",
        studyId: "s"
      });

      expect(responses).toHaveLength(1);
    });

    it("counts selectedOption and selectedOptions, not only text", async () => {
      // The budget is spread across three free-text fields so no single answer
      // is over the line, but their sum is. A counter reading only `text` would
      // serve this body.
      const third = Math.floor(MAX_AGGREGATE_RESPONSE_CHARS / 3) + 1;
      pushAnswer({ text: "a".repeat(third) });
      pushAnswer({ selectedOption: "b".repeat(third) });
      pushAnswer({ selectedOptions: ["c".repeat(third)] });

      await expect(
        listResponsesForOpportunity({ opportunityId: "o", studyId: "s" })
      ).rejects.toMatchObject({ statusCode: 413 });
    });

    it("applies the same bound to the study-wide reader", async () => {
      pushAnswer({ text: "x".repeat(MAX_AGGREGATE_RESPONSE_CHARS + 1) });

      await expect(listResponsesForStudy("s")).rejects.toMatchObject({
        statusCode: 413
      });
    });
  });

  describe("listResponsesForStudy", () => {
    it("spans every opportunity, which is why its route stays superadmin-only", async () => {
      await listResponsesForStudy("study_abc");

      expect(whereClauseOf(captured[0].sql)).toBe("s.study_id = $1");
      expect(captured[0].params).toEqual(["study_abc"]);
    });
  });
});

/**
 * The existence check that decides whether a study's questions may be
 * rewritten in place. It is a refusal predicate, not a reader, so its failure
 * direction is the opposite of everything above.
 */
describe("studyHasResponses", () => {
  beforeEach(() => {
    captured.length = 0;
    checkouts.length = 0;
    rowsToReturn.length = 0;
    queryFailure = null;
    isPostgresRuntimeConfigured.mockReturnValue(true);
  });

  it("reports false when the study has no stored answers", async () => {
    expect(await studyHasResponses("study_abc")).toBe(false);
  });

  it("reports true as soon as one answer exists", async () => {
    rowsToReturn.push({ "?column?": 1 });

    expect(await studyHasResponses("study_abc")).toBe(true);
  });

  it("filters on the study, through the session that carries it", async () => {
    await studyHasResponses("study_abc");

    // participant_responses has no study_id of its own, so the join IS the
    // filter. Asserted as literals rather than against the module's strings.
    expect(captured[0].sql).toContain(
      "JOIN runtime_sessions AS s ON s.session_id = r.session_id"
    );
    expect(captured[0].sql.split(/\bWHERE\b/)[1]).toContain("s.study_id = $1");
    expect(captured[0].params[0]).toBe("study_abc");
  });

  it("stops at the first row rather than loading the answers", async () => {
    await studyHasResponses("study_abc");

    // The whole point of not reusing listResponsesForStudy: this runs on the
    // five-connection pool that live participant sessions share, and the
    // answer set it would otherwise materialise is unbounded.
    expect(captured[0].sql).toContain("LIMIT 1");
    expect(captured[0].sql).not.toContain("response_payload");
  });

  it("assumes there ARE answers when the runtime database is not configured", async () => {
    // Fails CLOSED, unlike every reader above, and that inversion is the
    // point. This drives a refusal, so answering "no answers" would read as
    // "safe to rewrite the questions" and disable the guard by exactly the
    // misconfiguration that makes it impossible to check.
    isPostgresRuntimeConfigured.mockReturnValue(false);

    expect(await studyHasResponses("study_abc")).toBe(true);
    expect(captured).toHaveLength(0);
  });
});

/**
 * How many answers each question currently holds.
 *
 * The reader behind the removal warning on the authoring form: before F2 an
 * author could not delete a question of a live study at all, and now they can,
 * so the only thing standing between "tidying the form" and "moving somebody's
 * research into a separate section of the results" is being told the number
 * first.
 *
 * Its failure direction is neither of the two above, which is why it has its
 * own describe. `listResponsesFor*` answer `[]` when there is nowhere to read
 * from, because an empty result is the honest answer to "show me the answers".
 * `studyHasResponses` answers `true`, because it drives a REFUSAL and the
 * misconfiguration must not disable the guard. This one drives a SENTENCE, and
 * a sentence has a third option neither of those has: say that it does not
 * know.
 */
describe("answerCountsByStep", () => {
  beforeEach(() => {
    captured.length = 0;
    checkouts.length = 0;
    rowsToReturn.length = 0;
    queryFailure = null;
    isPostgresRuntimeConfigured.mockReturnValue(true);
  });

  it("counts per question without joining the sessions table", async () => {
    rowsToReturn.push(
      { step_id: "study_abc_q1", answers: "47" },
      { step_id: "study_abc_q2", answers: "3" }
    );

    const counts = await answerCountsByStep("study_abc");

    expect(counts).toEqual({ "study_abc_q1": 47, "study_abc_q2": 3 });

    // THE SCOPE, asserted on the SQL itself rather than on the parameter.
    //
    // A bound parameter stays bound whether or not the statement uses it, so
    // `params` alone cannot tell `WHERE r.study_id = $1` from no WHERE clause
    // at all. Dropping it makes this count EVERY study's answers and report
    // them against this study's questions: the form warns on ordinary saves,
    // and one researcher's participation volume is served to another. The
    // route's own tests mock this module, so nothing above here would see it.
    expect(captured[0].sql).toContain("r.study_id = $1");
    expect(captured[0].params).toEqual(["study_abc"]);

    // And the column it groups BY, not merely that it groups. `GROUP BY
    // r.study_id` returns one row for the whole study under a key no card
    // holds, so every question reports zero and the warning silently never
    // fires again.
    expect(captured[0].sql).toContain("GROUP BY r.step_id");

    // 0015 put `study_id` on the answer row and indexed `(study_id, step_id)`,
    // which is what lets this read that index directly rather than making the
    // join every other reader in this file has to. A join creeping back in
    // would turn a read that runs on every form load into one that also walks
    // runtime_sessions, on the pool live participants share.
    expect(captured[0].sql).not.toContain("JOIN");
  });

  it("counts a bigint as a number rather than passing the driver's string through", async () => {
    // node-pg returns COUNT(*) as a STRING, because a bigint does not fit a JS
    // number safely. Passed through unconverted it survives JSON, reaches the
    // form as "47", and `count > 0` is true for "0" - so a question with no
    // answers would warn, which is the exact noise this feature exists to avoid.
    rowsToReturn.push({ step_id: "study_abc_q1", answers: "0" });

    const counts = await answerCountsByStep("study_abc");

    expect(counts).toEqual({ "study_abc_q1": 0 });
  });

  it("reports a question with no answers by omitting it", async () => {
    const counts = await answerCountsByStep("study_abc");

    // Not null. A read that returned no rows is a KNOWN "nothing has been
    // answered", and the caller must be able to tell it apart from a read that
    // did not happen - one is silence on every card, the other is a warning on
    // every card.
    expect(counts).toEqual({});
  });

  it("excludes an answer already detached from its question", async () => {
    await answerCountsByStep("study_abc");

    // A detached row has both `study_id` and `step_id` NULL together, so the
    // study filter alone would already miss it. The explicit clause is what
    // stops a future widening of that filter counting removed questions'
    // answers against the questions that remain.
    expect(captured[0].sql).toContain("step_id IS NOT NULL");
  });

  it("answers unknown, not no-answers, when there is no runtime database", async () => {
    isPostgresRuntimeConfigured.mockReturnValue(false);

    const counts = await answerCountsByStep("study_abc");

    // `studyHasResponses` reads THIS SAME predicate and answers `true`,
    // "assume there are answers", because it gates a destructive rewrite.
    // Answering `{}` here made the form tell an author every question had zero
    // answers and removal was free, and the save then refused them naming
    // answers already collected - two readers of one fact contradicting each
    // other in one click. `null` does not agree with `true` exactly, but it no
    // longer contradicts it.
    expect(counts).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("answers unknown rather than throwing when the read fails", async () => {
    queryFailure = new Error("sorry, too many clients already");

    const counts = await answerCountsByStep("study_abc");

    // This runs inside GET /api/firsthand/studies/:studyId, which is on the
    // critical path for opening the opportunity form. A pool exhausted by live
    // participants must not 500 the form and lock the author out of editing;
    // null lets the form load and say it could not check.
    expect(counts).toBeNull();
  });
});

/**
 * How each reader asks for its connection.
 *
 * Neither of these facts appears in the SQL, and both are decisions about who
 * gets starved when the five-connection pool is contended. Without these, the
 * two arguments could be swapped - handing the unpaginated results read a
 * fifteen-second bound it would routinely blow, and making an author's form
 * load wait out the admission budget for a warning the form can do without -
 * and every other test in this file would still pass.
 */
describe("how each reader asks for the runtime pool", () => {
  beforeEach(() => {
    checkouts.length = 0;
    rowsToReturn.length = 0;
    queryFailure = null;
    isPostgresRuntimeConfigured.mockReturnValue(true);
    // The logger mock is module-scoped, so calls from the describes above
    // survive into this one. Asserting an absence against a shared spy is how
    // a test comes to pass for a reason nothing to do with its subject.
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
  });

  it("gives the study-wide results read the loose per-statement bound", async () => {
    await listResponsesForStudy("study_abc");

    expect(checkouts).toEqual([
      { statementTimeoutMs: RESULTS_STATEMENT_TIMEOUT_MS }
    ]);
    // A results read has no fallback answer, so it must never be skipped.
    expect(checkouts[0].whenBusy).toBeUndefined();
  });

  it("gives the per-opportunity results read the same bound", async () => {
    await listResponsesForOpportunity({
      opportunityId: "opp_1",
      studyId: "study_abc"
    });

    expect(checkouts).toEqual([
      { statementTimeoutMs: RESULTS_STATEMENT_TIMEOUT_MS }
    ]);
  });

  it("skips the advisory answer count rather than queueing for it", async () => {
    await answerCountsByStep("study_abc");

    expect(checkouts).toEqual([{ whenBusy: "skip" }]);
    // The default bound, not the loose one: this is an indexed group-by that
    // runs on an ordinary form load, and nothing about it is slow by design.
    expect(checkouts[0].statementTimeoutMs).toBeUndefined();
  });

  it("makes the destructive-rewrite guard wait its turn like any other read", async () => {
    await studyHasResponses("study_abc");

    // It gates a refusal, so it has to produce an answer. Skipping would make
    // a busy pool read as "no answers collected" and silently disable the
    // guard - which is the direction studyHasResponses documents it must
    // never fail in.
    expect(checkouts).toEqual([{}]);
  });

  it("answers unknown, not zero, when the pool refuses the advisory count", async () => {
    queryFailure = new RuntimeDatabaseBusyError();

    const counts = await answerCountsByStep("study_abc");

    expect(counts).toBeNull();
    // Told apart from a failed query in the log, because "the pool was busy"
    // is a capacity fact and "the query went wrong" sends somebody to the SQL.
    expect(logger.info).toHaveBeenCalledWith(
      "Skipped counting answers per question: runtime pool busy",
      { studyId: "study_abc" }
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
