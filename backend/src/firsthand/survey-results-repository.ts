import {
  isPostgresRuntimeConfigured,
  withRuntimeDatabaseClient,
  RESULTS_STATEMENT_TIMEOUT_MS
} from "./runtime-database";
import { RuntimeDatabaseBusyError } from "./runtime-pool-admission";
import { UNKNOWN_REMOVED_PROMPT, type StoredResponse } from "./survey-results";
import { QUESTION_TYPES, type RemovedQuestion } from "./survey-csv";
import { logger } from "../utils/logger";
import { AppError } from "../../../shared/types";

type ResponseRow = {
  session_id: string;
  /** NULL once the question this answer was given against has been removed. */
  step_id: string | null;
  /** The prompt the participant was shown. NULL for rows written before 0015. */
  step_prompt: string | null;
  step_type: string;
  response_payload: Record<string, unknown>;
  saved_at: Date | string;
};

/**
 * The two clauses that may ever appear, as a type.
 *
 * A `string` parameter here would accept an interpolated one, and this clause
 * is what decides who may see whose answers. Naming the alternatives makes
 * interpolation a compile error rather than a convention a future third reader
 * has to notice.
 */
type ResponseFilter =
  | "s.study_id = $1"
  | "s.study_id = $1 AND s.opportunity_id = $2";

/**
 * The most answer rows either reader will return.
 *
 * A hundred questions answered by two thousand participants is 200,000 rows, so
 * this is past any internal study rather than near one. It exists because the
 * query is unpaginated and runs on the FirstHand runtime pool, which is capped
 * at five connections and shared with live participant sessions.
 */
const MAX_RESPONSE_ROWS = 200_000;

/** The one row mapping, shared by every reader in this file. */
function toStoredResponse(row: ResponseRow): StoredResponse {
  return {
    session_id: row.session_id,
    step_id: row.step_id,
    step_prompt: row.step_prompt,
    step_type: row.step_type,
    response_payload: row.response_payload ?? {},
    saved_at: new Date(row.saved_at).toISOString()
  };
}

/**
 * The one projection both readers use.
 *
 * The join is how a study's answers are identified, and it is still the join
 * rather than `participant_responses.study_id` - which 0015 added, but which
 * exists to carry the foreign key and is NULLED when a question is removed.
 * Scoping on it would silently drop exactly the detached answers this reader
 * has to surface. `runtime_sessions.study_id` never moves.
 *
 * Only the WHERE clause differs between the two callers, and it is the clause
 * that decides who is allowed to see what, so it is passed in explicitly rather
 * than assembled from optional arguments.
 */
async function listResponsesWhere(
  filter: ResponseFilter,
  params: unknown[]
): Promise<StoredResponse[]> {
  if (!isPostgresRuntimeConfigured()) {
    return [];
  }

  return withRuntimeDatabaseClient(
    async (client) => {
      const result = await client.query<ResponseRow>(
        `
        SELECT r.session_id, r.step_id, r.step_prompt, r.step_type,
               r.response_payload, r.saved_at
        FROM participant_responses AS r
        JOIN runtime_sessions AS s ON s.session_id = r.session_id
        WHERE ${filter}
        ORDER BY r.saved_at ASC, r.id ASC
        LIMIT ${MAX_RESPONSE_ROWS + 1}
      `,
        params
      );

      /**
       * REFUSED, NOT TRUNCATED - and that is the whole point of the +1 above.
       *
       * A capped read that quietly returned the first 200,000 rows would hand a
       * researcher a mean, an NPS and a CSV computed over part of their data,
       * with nothing on the page saying so. A wrong finding presented as a
       * finding is worse than no finding: the limit exists to protect the
       * database, and it must not buy that at the cost of the answer.
       */
      if (result.rows.length > MAX_RESPONSE_ROWS) {
        throw new AppError(
          "This study has collected more responses than can be read in one request. Ask for a database export.",
          413,
          "RESPONSE_SET_TOO_LARGE"
        );
      }

      return result.rows.map(toStoredResponse);
    },
    // The one read here that is expected to be slow, and the one the default
    // per-statement bound would refuse. `LIMIT 200001` bounds this in ROWS and
    // nothing bounded it in TIME - so before this, a single results read could
    // hold one of five connections past the point where several participants
    // had already failed to save.
    { statementTimeoutMs: RESULTS_STATEMENT_TIMEOUT_MS }
  );
}

/**
 * Every stored answer for a study, across every opportunity that used it.
 *
 * Superadmin-only at the route, and that is not merely strict: a study is
 * reusable by an opportunity its author did not create, so this set spans
 * participants recruited by different researchers under different consent
 * wording. `listResponsesForOpportunity` is the reader a researcher gets.
 *
 * Its own module rather than another function on studies-repository: that file
 * is being extended on another branch, and this needs nothing from it.
 */
export async function listResponsesForStudy(
  studyId: string
): Promise<StoredResponse[]> {
  return listResponsesWhere("s.study_id = $1", [studyId]);
}

/**
 * The answers one opportunity collected, which is the set its owner may read.
 *
 * Filtered on BOTH columns rather than `opportunity_id` alone. An opportunity's
 * study link can be repointed after answers exist, and answers carried over
 * from the study it used to link name step ids the current steps do not have -
 * they would be counted in `respondents` while appearing under no question,
 * which reads as participants who answered nothing.
 *
 * `opportunity_id` is TEXT and `opportunities.id` is `uuid`, so this compares
 * bytes where Postgres compared uuids. The caller must pass the id Postgres
 * parsed, never the raw path segment: a participant who wrote their own URL
 * with different casing or braces would otherwise drop their answers out of
 * the researcher's results.
 *
 * Sessions minted before 7.37.0 have a NULL `opportunity_id` and are excluded
 * here by that equality, deliberately - NULL matches nothing. They stay
 * readable only through the study-wide superadmin route. Backfilling them by
 * heuristic would attribute real participants' answers to an opportunity that
 * may not have collected them.
 */
export async function listResponsesForOpportunity(input: {
  opportunityId: string;
  studyId: string;
}): Promise<StoredResponse[]> {
  return listResponsesWhere("s.study_id = $1 AND s.opportunity_id = $2", [
    input.studyId,
    input.opportunityId
  ]);
}

/**
 * Whether a study has collected any answer at all.
 *
 * Existence, not a count and not the rows: the only question the caller has is
 * "would rewriting this study's steps put someone's answer under a different
 * question", and for that one matters exactly as much as ten thousand.
 * `listResponsesForStudy` would load every stored answer to decide it, on the
 * five-connection runtime pool that live participant sessions share, and the
 * projection it builds is bounded elsewhere precisely because it can be large.
 *
 * `LIMIT 1` and `SELECT 1`, so Postgres stops at the first matching row.
 *
 * Same join as every other read here, and for the same reason: the study id
 * that never moves is the session's, not the response's own nullable one.
 *
 * Fails CLOSED when the runtime database is unconfigured - it answers `true`,
 * "assume there are answers". Every other read in this file answers `[]` for
 * that case, because an empty result is the honest answer to "show me the
 * answers" when there is nowhere to read them from. This one drives a REFUSAL,
 * so the same instinct would invert its meaning: "no answers" would read as
 * "safe to rewrite the steps", and the guard would be disabled by exactly the
 * misconfiguration that makes it impossible to check.
 */
export async function studyHasResponses(studyId: string): Promise<boolean> {
  if (!isPostgresRuntimeConfigured()) {
    return true;
  }

  return withRuntimeDatabaseClient(async (client) => {
    const result = await client.query(
      `
        SELECT 1
        FROM participant_responses AS r
        JOIN runtime_sessions AS s ON s.session_id = r.session_id
        WHERE s.study_id = $1
        LIMIT 1
      `,
      [studyId]
    );

    return result.rows.length > 0;
  });
}

/**
 * How many answers each of a study's questions currently holds, keyed by the
 * stored step id.
 *
 * The reader behind the authoring form's removal warning. Before F2, changing
 * the questions of a study that had collected answers was refused outright, so
 * there was nothing to warn about; F2 narrows that refusal to type and scale
 * changes, and a question can now be DELETED from a live study. 0015's
 * `ON DELETE SET NULL` means that keeps the answers - they surface under
 * "Removed questions" in the results - but the author is the one person who
 * cannot see that happening, because the Remove control behaves identically
 * whether the question has none or three hundred.
 *
 * Deliberately a COUNT per step rather than the study-wide existence check
 * `studyHasResponses` already offers. A study-level boolean can only produce
 * "this study has answers somewhere", which fires on a question nobody has
 * answered as readily as on one three hundred people have - and a dialog that
 * cries wolf on every card is a dialog authors learn to dismiss. This file
 * already refuses to confirm the removal of an empty card for that exact
 * reason.
 *
 * NO JOIN, unlike every other reader here, and that is what makes it cheap
 * enough to run on an ordinary form load. The others reach `runtime_sessions`
 * because `participant_responses` had no study of its own; 0015 gave it one and
 * indexed `(study_id, step_id)`, so this reads that index directly and returns
 * one row per QUESTION rather than one per answer. Keep it that way: a join
 * creeping back in would put a walk of `runtime_sessions` on the
 * five-connection runtime pool that live participant sessions share, on every
 * form load.
 *
 * Measured rather than assumed - EXPLAIN against a real Postgres 16 with every
 * firsthand migration applied:
 *
 *   GroupAggregate -> Sort -> Bitmap Heap Scan on participant_responses
 *     -> Bitmap Index Scan on participant_responses_step_idx
 *        Index Cond: study_id = $1 AND step_id IS NOT NULL
 *
 * So it is NOT index-only: there is a heap recheck and a sort, and the scan
 * covers every answer row of the study rather than stopping at the first the
 * way `studyHasResponses` does. It is still bounded work on the right index
 * with no join, and what crosses the wire is bounded by the question count -
 * but it is not free, which is the reason the caller does not run it at all
 * for a reader who could not act on the answer.
 *
 * Two answers:
 *
 *  - a map, when the read succeeded. A question absent from it has no answers;
 *    there is no row to count and inventing a zero would only make the caller
 *    iterate two collections instead of one
 *  - `null` when the count could not be established, which the caller must
 *    render as "not known" and never as "none"
 *
 * `null` covers BOTH an attempted read that failed and a runtime database that
 * is not configured, and collapsing those two is a correction rather than
 * laziness. The first version answered `{}` for the unconfigured case, on the
 * reasoning that a deployment with nowhere to store an answer cannot have one.
 * That reasoning is fine in isolation and wrong beside its neighbour:
 * `studyHasResponses` reads the SAME env predicate - `isPostgresRuntimeConfigured`
 * is `Boolean(getRuntimeDatabaseUrl())`, a config check and not a connectivity
 * one - and answers `true`, "assume there are answers", because it gates a
 * destructive rewrite and must fail closed.
 *
 * Both are consulted about one study in one click. With `{}` here, the form
 * told an author every question had zero answers and removal was free, and
 * `updateLinkedStudyContent` then refused their save naming answers already
 * collected. Two readers of one fact, contradicting each other on screen. `null`
 * does not agree with `true` exactly - it says "unknown" where the guard says
 * "assume the worst" - but it no longer CONTRADICTS it, and the sentence the
 * author gets ("could not be checked") is true of that deployment.
 *
 * Caught rather than thrown for the same reason. This runs inside
 * `GET /api/firsthand/studies/:studyId`, which the opportunity form loads
 * before it can render anything; a pool exhausted by live participants must not
 * 500 the form and lock an author out of editing their own study. The warning
 * degrades, the form does not.
 */
export async function answerCountsByStep(
  studyId: string
): Promise<Record<string, number> | null> {
  if (!isPostgresRuntimeConfigured()) {
    // Unknown, not zero. See the docblock: `studyHasResponses` reads this same
    // predicate and answers "assume there are answers", and the two must not
    // tell one author opposite things about one study.
    return null;
  }

  try {
    return await withRuntimeDatabaseClient(
      async (client) => {
        const result = await client.query<{ step_id: string; answers: string }>(
          `
          SELECT r.step_id, COUNT(*) AS answers
          FROM participant_responses AS r
          WHERE r.study_id = $1 AND r.step_id IS NOT NULL
          GROUP BY r.step_id
        `,
          [studyId]
        );

        /**
         * `Number`, because node-pg hands back COUNT(*) as a STRING - a bigint
         * does not fit a JS number safely, so the driver refuses to guess.
         * Passed through it survives JSON and reaches the form as `"0"`, which
         * is truthy: every question with no answers would warn.
         */
        return Object.fromEntries(
          result.rows.map((row) => [row.step_id, Number(row.answers)])
        );
      },
      /**
       * SKIPPED RATHER THAN QUEUED when the admin admission cap is full, which
       * is the one place in this file where that is right.
       *
       * This warning is advisory - it already answers `null` for "could not be
       * established" and the form already renders that as "could not be
       * checked". Waiting out the admission budget for it would spend an
       * author's form load on a value the form is prepared to do without, and
       * would hold a slot another admin needs for work that has no fallback.
       *
       * Every other read here waits, because every other read has to produce
       * an answer or refuse. Nothing else in this file may copy this.
       */
      { whenBusy: "skip" }
    );
  } catch (error) {
    if (error instanceof RuntimeDatabaseBusyError) {
      // Logged apart from a failed query on purpose. "The pool was busy so the
      // count was skipped" is a capacity fact an operator should be able to
      // count; folded into the line below it would read as the query itself
      // going wrong, and send somebody looking at the SQL.
      logger.info("Skipped counting answers per question: runtime pool busy", {
        studyId
      });
      return null;
    }

    logger.warn("Could not count answers per question", {
      studyId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return null;
  }
}

/**
 * WHOSE ANSWERS, as a value rather than two more boolean arguments.
 *
 * The same distinction `listResponsesForStudy` and `listResponsesForOpportunity`
 * draw, hoisted so the streaming reader below can take it once and reuse it
 * across several statements. The clause it produces is still one of the two
 * literals in `ResponseFilter`, so it still cannot be interpolated.
 */
export type ResponseScope =
  | { kind: "study"; studyId: string }
  | { kind: "opportunity"; studyId: string; opportunityId: string };

function filterFor(scope: ResponseScope): {
  filter: ResponseFilter;
  params: unknown[];
} {
  return scope.kind === "study"
    ? { filter: "s.study_id = $1", params: [scope.studyId] }
    : {
        filter: "s.study_id = $1 AND s.opportunity_id = $2",
        params: [scope.studyId, scope.opportunityId]
      };
}

/**
 * How many participants' answers are read - and held - at once.
 *
 * The number that decides the export's memory ceiling. A hundred participants
 * of a hundred-question survey is ten thousand rows in flight, a few megabytes,
 * against the few hundred the unbatched reader holds for a large study.
 *
 * Not larger, because the ceiling is the point; not smaller, because each batch
 * is a round trip AND a pool checkout, and a batch of one would turn a
 * two-thousand-participant export into two thousand checkouts on the five
 * connections live participants share.
 */
const CSV_PARTICIPANT_BATCH = 100;

/**
 * The most participants one export will stream.
 *
 * Still a refusal, and still decided BEFORE a byte of the body is written -
 * the only place it can be decided, because a 413 is impossible once the
 * response has started. But it bounds PARTICIPANTS where `listResponsesWhere`
 * bounds ROWS, so it is strictly more permissive: five thousand people
 * answering a hundred questions is half a million rows, which that reader
 * refuses outright and this exports without difficulty.
 *
 * What has to fit in memory here is the LIST - an identifier each - not their
 * answers.
 */
const MAX_CSV_PARTICIPANTS = 200_000;

/**
 * The removed-question columns, asked of the database directly.
 *
 * Grouped, FILTERED and ordered exactly as `removedQuestionColumns` does it in
 * survey-csv.ts - by `(step_type, step_prompt)`, question types only, in
 * first-appearance order - because the streamed header must match the columns
 * the row emitter later fills.
 *
 * The type filter was missing, and both gates caught it. Without it a detached
 * `instruction` row becomes a "(removed question)" column the unstreamed export
 * never showed. No live write path can produce one today - the participant API
 * refuses a non-answerable step - but legacy and imported rows can, and
 * inline-study.ts anticipates machine-only step types.
 *
 * That the two agree is now asserted by survey-csv-export-postgres.ts, which
 * compares the bytes of both paths over the same seeded rows. The previous
 * version of this comment claimed such a test existed when it did not.
 *
 * Bounded by the number of DELETED QUESTIONS, so it stays small however many
 * answers the study holds.
 */
export async function surveyCsvColumns(
  scope: ResponseScope
): Promise<RemovedQuestion[]> {
  if (!isPostgresRuntimeConfigured()) {
    return [];
  }

  const { filter, params } = filterFor(scope);

  return withRuntimeDatabaseClient(
    async (client) => {
      const result = await client.query<{
        step_type: string;
        step_prompt: string | null;
      }>(
        `
        SELECT r.step_type, r.step_prompt
        FROM participant_responses AS r
        JOIN runtime_sessions AS s ON s.session_id = r.session_id
        WHERE ${filter} AND r.step_id IS NULL
          AND r.step_type = ANY($${params.length + 1}::text[])
        GROUP BY r.step_type, r.step_prompt
        ORDER BY MIN(r.saved_at) ASC, MIN(r.id) ASC
      `,
        [...params, [...QUESTION_TYPES]]
      );

      return result.rows.map((row) => ({
        type: row.step_type,
        prompt: row.step_prompt ?? UNKNOWN_REMOVED_PROMPT
      }));
    },
    { statementTimeoutMs: RESULTS_STATEMENT_TIMEOUT_MS }
  );
}

/**
 * Every participant who answered, in the order they first answered.
 *
 * `MIN(saved_at), MIN(id)` reproduces the order the unbatched CSV produced -
 * it built its rows from a set ordered by `(saved_at, id)` and kept first
 * appearance - EXCEPT WHERE TWO PARTICIPANTS TIE ON THE MILLISECOND of their
 * first answer.
 *
 * That exception is real and was demonstrated on Postgres 16 by a review gate,
 * against an earlier version of this comment which claimed the output was
 * "byte-identical, not merely equivalent". It is not: `MIN(id)` is taken over
 * the whole group independently of which row carries the minimum `saved_at`,
 * and `participant_responses.id` is an application-generated uuid stored as
 * TEXT, so its minimum is a lexicographic minimum of random values with no
 * relation to insertion order. `saved_at` is client-supplied at millisecond
 * precision, so ties are not exotic - imported and seeded data tie routinely.
 *
 * Left as it is rather than fixed, deliberately. Ordering by the first row
 * instead needs a correlated subquery or `DISTINCT ON` over a
 * `(saved_at, id)`-ordered scan on every export, and the consequence of the
 * tie is that two participants swap places in a spreadsheet - not a wrong
 * value, not a missing row. Recorded here so the next reader does not discover
 * the claim was stronger than the code.
 */
async function surveyCsvParticipantIds(
  scope: ResponseScope
): Promise<string[]> {
  const { filter, params } = filterFor(scope);

  return withRuntimeDatabaseClient(
    async (client) => {
      const result = await client.query<{ session_id: string }>(
        `
        SELECT r.session_id
        FROM participant_responses AS r
        JOIN runtime_sessions AS s ON s.session_id = r.session_id
        WHERE ${filter}
        GROUP BY r.session_id
        ORDER BY MIN(r.saved_at) ASC, MIN(r.id) ASC
        LIMIT ${MAX_CSV_PARTICIPANTS + 1}
      `,
        params
      );

      if (result.rows.length > MAX_CSV_PARTICIPANTS) {
        throw new AppError(
          "This study has collected answers from more participants than can be exported in one request. Ask for a database export.",
          413,
          "RESPONSE_SET_TOO_LARGE"
        );
      }

      return result.rows.map((row) => row.session_id);
    },
    { statementTimeoutMs: RESULTS_STATEMENT_TIMEOUT_MS }
  );
}

/**
 * The export, a participant at a time.
 *
 * ONE CHECKOUT PER BATCH, NOT ONE FOR THE WHOLE EXPORT, and that is the whole
 * design. A server-side cursor or `COPY` is the obvious way to stream this and
 * is the wrong one: either holds a runtime-pool connection open for the entire
 * download, which is precisely the occupancy defect the admission cap exists to
 * close. Streaming the export by inverting that fix would be a poor trade.
 * Between batches this holds no connection at all, so a slow client costs the
 * pool nothing.
 *
 * The consequence worth knowing: the batches are separate reads, so an answer
 * saved DURING an export may or may not appear, depending on whether its
 * participant had already been passed. The unbatched reader took one statement
 * and therefore one snapshot. That is a real difference and an acceptable one -
 * the alternative is holding a transaction open for the length of a download -
 * and the participant LIST is fixed up front, so somebody who starts answering
 * mid-export is consistently absent rather than half-present.
 */
async function* streamParticipants(
  scope: ResponseScope,
  participantIds: string[]
): AsyncGenerator<{ sessionId: string; answers: StoredResponse[] }> {
  const { filter, params } = filterFor(scope);

  for (
    let index = 0;
    index < participantIds.length;
    index += CSV_PARTICIPANT_BATCH
  ) {
    const batch = participantIds.slice(index, index + CSV_PARTICIPANT_BATCH);

    // `${filter}` in the statement below is DEFENCE IN DEPTH AND CANNOT BE
    // TESTED, which is worth saying so nobody deletes it as dead or claims it
    // is covered. `session_id` is the primary key of runtime_sessions and
    // these ids came from the scoped preflight, so the `ANY(...)` clause
    // already fixes the row set - collapsing this filter to a study-wide one
    // is an equivalent mutant and survives every test, correctly. It stays
    // because a later change to how the id list is built should not be able to
    // widen the read silently.
    //
    // The BATCH clause is a different matter and IS pinned: deleting it with
    // its bind parameter is caught in survey-csv-export.test.ts, on the
    // parameters, by `asks each batch for ITS OWN hundred ids`.
    const rows = await withRuntimeDatabaseClient(
      async (client) => {
        const result = await client.query<ResponseRow>(
          `
        SELECT r.session_id, r.step_id, r.step_prompt, r.step_type,
               r.response_payload, r.saved_at
        FROM participant_responses AS r
        JOIN runtime_sessions AS s ON s.session_id = r.session_id
        WHERE ${filter} AND r.session_id = ANY($${params.length + 1}::text[])
        ORDER BY r.saved_at ASC, r.id ASC
      `,
          [...params, batch]
        );

        return result.rows.map(toStoredResponse);
      },
      { statementTimeoutMs: RESULTS_STATEMENT_TIMEOUT_MS }
    );

    const byParticipant = new Map<string, StoredResponse[]>();
    for (const row of rows) {
      const group = byParticipant.get(row.session_id);
      if (group) {
        group.push(row);
      } else {
        byParticipant.set(row.session_id, [row]);
      }
    }

    // Yielded in the ORDER OF THE ID LIST, not the order the batch query
    // happened to return them. The list is what carries first-answer order.
    for (const sessionId of batch) {
      yield { sessionId, answers: byParticipant.get(sessionId) ?? [] };
    }
  }
}

/**
 * Everything that can REFUSE an export, done before the export begins.
 *
 * A generator body does not run until its first `next()`, so a design where the
 * route set its headers and then started pulling would have discovered the
 * participant bound - and its 413 - with the response already committed. Once a
 * byte of the body is written the status is fixed, and the only honest failure
 * left is to destroy the connection. So both preflight reads happen HERE, in an
 * ordinary awaited call, and the caller gets a generator that is known to have
 * something to say.
 *
 * That ordering is the same reason `toCsvContentDisposition` and
 * `toResponsesCsv` were both built before any header was set in the unstreamed
 * version: a throw after `setHeader` is served as text/csv, so the browser
 * downloads the error instead of showing it.
 */
export async function openSurveyCsvExport(scope: ResponseScope): Promise<{
  removedQuestions: RemovedQuestion[];
  participants: () => AsyncGenerator<{
    sessionId: string;
    answers: StoredResponse[];
  }>;
}> {
  if (!isPostgresRuntimeConfigured()) {
    return {
      removedQuestions: [],
      // eslint-disable-next-line require-yield
      participants: async function* () {
        return;
      }
    };
  }

  // THE BOUND FIRST, so the refusal is the cheap thing. Both reads scan
  // participant_responses under the same 120s statement budget, but only this
  // one is bounded - it carries `LIMIT MAX_CSV_PARTICIPANTS + 1` and decides
  // the 413. Run second, as it was, a study too large to export still pays for
  // the unbounded removed-columns grouping before anyone tells it no.
  //
  // Order is all that changes. Both are independent reads of the same scope
  // and neither writes, so the only observable difference is WHICH refusal
  // arrives first when both would fail - and both are pre-first-byte refusals,
  // so either is honest.
  const participantIds = await surveyCsvParticipantIds(scope);
  const removedQuestions = await surveyCsvColumns(scope);

  return {
    removedQuestions,
    participants: () => streamParticipants(scope, participantIds)
  };
}
