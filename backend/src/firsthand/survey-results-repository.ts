import type { PoolClient } from "pg";

import {
  isPostgresRuntimeConfigured,
  withRuntimeDatabaseClient,
  RESULTS_STATEMENT_TIMEOUT_MS
} from "./runtime-database";
import {
  RuntimeDatabaseBusyError,
  isRuntimePoolRefusal
} from "./runtime-pool-admission";
import { UNKNOWN_REMOVED_PROMPT, type StoredResponse } from "./survey-results";
import {
  QUESTION_TYPES,
  type CsvSessionRow,
  type RemovedQuestion
} from "./survey-csv";
import { logger } from "../utils/logger";
import { AppError } from "../../../shared/types";

type ResponseRow = {
  session_id: string;
  /**
   * WHO answered, from the joined session row - the key the respondent count
   * is taken over, so two sessions belonging to one person are one respondent
   * (cto/AdaptaLabs#129, MEDIUM-2). `TEXT NOT NULL` in migration 0001, so it
   * is not nullable HERE; `StoredResponse` widens it for the pure function's
   * own fallback.
   */
  participant_id: string;
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

/**
 * The most free-text characters an aggregate results BODY may carry.
 * cto/AdaptaLabs#9, option A.
 *
 * `MAX_RESPONSE_ROWS` bounds the row count, but not the body: an open-text
 * answer has no length limit at the write boundary (`surveyAnswerSchema.text`
 * is a bare `z.string()`), so the AGGREGATE of many normal answers - or a few
 * large ones, each still under the 100kb request-body limit - is a
 * few-hundred-megabyte `res.json` on a single-replica 2Gi pod. That is two
 * problems, and this closes ONE of them outright:
 *
 *  - the heap that OOM-kills every live participant session - CLOSED, the body
 *    is now bounded;
 *  - the buffered body a stalled reader holds the one results permit against
 *    until `close` - only BOUNDED, not closed. These routes still `res.json`
 *    the whole body and release the permit on `close`, and a bounded body is
 *    still ~12-19MB at the ceiling, which does not fit the socket buffer and so
 *    still stalls. Closing that means not buffering the aggregate at all, the
 *    way the CSV twin streams - tracked as cto/AdaptaLabs#85, newly viable now
 *    the heap is bounded.
 *
 * The CSV twin STREAMS and has neither problem, which is why the refusal points
 * a large study there rather than at nothing.
 *
 * Counted over the free-text PAYLOAD fields only - `text`, `selectedOption`,
 * `selectedOptions` - because that is the only axis a participant can drive
 * unbounded per answer. The other text in the body, `step_prompt` (surfaced in
 * `asked_as` and `removed_questions`), is server-sourced from the study and
 * capped at `maxPromptLength` per wording, and it appears in the body once per
 * DISTINCT wording, not per answer - so its cost scales with the number of
 * author rewordings, an authoring-limited quantity, not with the answer count.
 *
 * ponytail: `step_prompt` length is uncounted here. Its pathological ceiling is
 *   ~200k distinct 2000-char wordings (~400MB), reachable only by ~100k+
 *   interleaved author edits each answered once - author self-sabotage, not a
 *   participant DoS - so it stays comment-only per AGENTS.md (production cannot
 *   realistically hit it). The upgrade path if it ever matters: count distinct
 *   `step_prompt` values here, or bound the serialised body directly (#85).
 *
 * Five million characters is past any interactive study; a study larger than
 * this is a database export, not a page. Written as a literal here and asserted
 * as the same literal in the test, not derived from it.
 */
export const MAX_AGGREGATE_RESPONSE_CHARS = 5_000_000;

/**
 * The free-text length one stored answer contributes to the body.
 *
 * Only the fields `surveyAnswerSchema` allows to be unbounded strings. `rating`
 * is an integer and negligible; the session id and timestamps are fixed width.
 */
function payloadTextLength(payload: Record<string, unknown>): number {
  let total = 0;

  const text = payload.text;
  if (typeof text === "string") total += text.length;

  const selectedOption = payload.selectedOption;
  if (typeof selectedOption === "string") total += selectedOption.length;

  const selectedOptions = payload.selectedOptions;
  if (Array.isArray(selectedOptions)) {
    for (const option of selectedOptions) {
      if (typeof option === "string") total += option.length;
    }
  }

  return total;
}

/** The one row mapping, shared by every reader in this file. */
function toStoredResponse(row: ResponseRow): StoredResponse {
  return {
    session_id: row.session_id,
    participant_id: row.participant_id,
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
        SELECT r.session_id, s.participant_id, r.step_id, r.step_prompt, r.step_type,
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

      /**
       * REFUSED BEFORE THE BODY IS BUILT - the second half of the bound.
       *
       * Summed here, over the raw rows and with an early exit, rather than by
       * serialising the aggregate and measuring it: a body large enough to
       * refuse is a body too large to have built safely on this pod, so the
       * check that saves the heap cannot be the one that allocates it. The
       * structural body (a `session_id` per open-text answer) is bounded by
       * `MAX_RESPONSE_ROWS`, and the wording text by authoring - so the
       * participant-driven free text is the only axis left to bound here. See
       * the constant's docblock for the axis this deliberately does not count.
       */
      let totalTextChars = 0;
      for (const row of result.rows) {
        totalTextChars += payloadTextLength(row.response_payload ?? {});
        if (totalTextChars > MAX_AGGREGATE_RESPONSE_CHARS) {
          throw new AppError(
            "This study has collected more open-text than can be shown in one request. Ask for a database export.",
            413,
            "RESULTS_BODY_TOO_LARGE"
          );
        }
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
 *
 * EXPORTED FOR ONE READER ONLY: backend/probe/csv-interrupt.ts sizes its seed
 * from this so the export it interrupts is genuinely multi-batch. A probe that
 * duplicated the number would keep passing while silently testing a
 * single-batch export the day this moves.
 */
export const CSV_PARTICIPANT_BATCH = 100;

/**
 * How many EXTRA attempts one batch read gets when the runtime pool refuses.
 *
 * Batching bought the occupancy fix at the cost of attempt count: the export
 * makes `2 + ceil(N/100)` admission attempts where the unbatched reader made
 * one, so a two-thousand-participant export has twenty-two separate chances to
 * meet a busy pool. Before batching, a refusal arrived as a clean retryable
 * 503 before any byte was sent. After it, a refusal on batch seventeen cannot
 * be a 503 - the status is already 200 - so it is correctly a destroyed
 * socket, which the researcher experiences as a download that broke after
 * several minutes with no explanation.
 *
 * ON THE BATCH READ ONLY. The preflight is deliberately excluded and must stay
 * excluded: its refusal happens before the first byte, so it IS the honest,
 * immediate, retryable 503, and putting a retry in front of it would make an
 * admin wait half a minute to be told to try again.
 *
 * Three, not more. The bound that matters is the export's wall-clock deadline
 * (SURVEY_CSV_EXPORT_DEADLINE_MS); retries spend that budget, and a refusal
 * that survives three attempts across roughly half a minute is a pool that is
 * saturated rather than momentarily busy.
 */
const CSV_BATCH_RETRY_ATTEMPTS = 3;

/**
 * The first backoff, doubled per attempt: 250ms, 500ms, 1000ms.
 *
 * Small on purpose, because the wait that dominates is not this one. Admin
 * work queues for ADMIN_ADMISSION_TIMEOUT_MS before it is refused at all, so
 * an attempt has already spent ten seconds by the time this delay is added.
 * Its job is only to avoid re-queueing in the same instant as the last
 * refusal.
 */
const CSV_BATCH_RETRY_BASE_DELAY_MS = 250;

/**
 * A sleep that gives up the moment the export's deadline fires.
 *
 * THE ALREADY-ABORTED CHECK IS NOT DEFENCE IN DEPTH, it is the common case and
 * it was missing first time round. `addEventListener('abort')` on a signal
 * that has ALREADY aborted never fires - and the deadline firing during the
 * refused query is exactly how this is reached, so without the check the
 * backoff slept through the deadline and the retry loop ran on. The same shape
 * as `close` firing once on a response destroyed before the first write; found
 * here by a test written to assert the abandonment, not by reading.
 */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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
async function readRemovedColumns(
  client: PoolClient,
  filter: ResponseFilter,
  params: unknown[]
): Promise<RemovedQuestion[]> {
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
}

/**
 * The removed-question columns for a scope, on their own checkout.
 *
 * The export reads this inside the shared preflight snapshot (see
 * `readSurveyCsvPreflight`); this wrapper exists for the callers that want the
 * columns alone - the results-page JSON view and the tests that pin the query
 * directly.
 */
export async function surveyCsvColumns(
  scope: ResponseScope
): Promise<RemovedQuestion[]> {
  if (!isPostgresRuntimeConfigured()) {
    return [];
  }

  const { filter, params } = filterFor(scope);

  return withRuntimeDatabaseClient(
    (client) => readRemovedColumns(client, filter, params),
    { statementTimeoutMs: RESULTS_STATEMENT_TIMEOUT_MS }
  );
}

/**
 * Every SESSION that answered, grouped by person: people in the order they
 * first answered, and each person's sessions in the order THEY first
 * answered. That is the order `toCsvSessionRows` produces for the oracle, and
 * it puts one person's sessions next to each other so a researcher comparing
 * them is not hunting through the file (cto/AdaptaLabs#152).
 *
 * SESSIONS, NOT PEOPLE, is the unit batches are cut from - and that is a
 * bound, not a preference. A session holds at most one answer per question,
 * so a batch of a hundred sessions is bounded by the study's length. A person
 * is bounded by nothing: an abandoned session earns a fresh mint, so one
 * account can hold thousands of answer-carrying sessions, and a batch of a
 * hundred PEOPLE read one such account's ~100MB in a single statement (the
 * security gate measured it on an intermediate version of #152). Whether a
 * session holds a superseded answer needs the person's OTHER sessions, so that
 * is decided in SQL by `supersededCsvSessions` below rather than by reading
 * them all into one batch.
 *
 * `MIN(saved_at), MIN(id)` reproduces the unbatched order EXCEPT WHERE TWO
 * ROWS TIE ON THE MILLISECOND. That exception is real and was demonstrated on
 * Postgres 16 by a review gate, against an earlier comment which claimed the
 * output was "byte-identical, not merely equivalent". `MIN(id)` is taken over
 * the whole group independently of which row carries the minimum `saved_at`,
 * and `participant_responses.id` is a random uuid stored as TEXT, so it has no
 * relation to insertion order; two PEOPLE tied on their first millisecond are
 * ordered by `participant_id` here and by that uuid in the oracle. `saved_at`
 * has millisecond precision (stamped by the server unless an API caller
 * supplies one), so ties are not exotic - imported and seeded data tie
 * routinely. Left as it is, deliberately: the consequence of a tie is that two
 * rows swap places in a spreadsheet - not a wrong value, not a missing row.
 */
async function readCsvSessions(
  client: PoolClient,
  filter: ResponseFilter,
  params: unknown[]
): Promise<{ sessionId: string; participantId: string }[]> {
  const result = await client.query<{
    session_id: string;
    participant_id: string;
  }>(
    `
        SELECT r.session_id, s.participant_id
        FROM participant_responses AS r
        JOIN runtime_sessions AS s ON s.session_id = r.session_id
        WHERE ${filter}
        GROUP BY r.session_id, s.participant_id
        ORDER BY MIN(MIN(r.saved_at)) OVER (PARTITION BY s.participant_id) ASC,
                 s.participant_id ASC,
                 MIN(r.saved_at) ASC, MIN(r.id) ASC
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

  return result.rows.map((row) => ({
    sessionId: row.session_id,
    participantId: row.participant_id
  }));
}

/**
 * Text that `String.prototype.trim` would NOT reduce to nothing, as a
 * Postgres regular expression: at least one character outside the exact set
 * ECMAScript trims (WhiteSpace plus LineTerminator - tab, vertical tab, form
 * feed, space, U+00A0, U+1680, U+2000-U+200A, U+202F, U+205F, U+3000, U+FEFF,
 * line feed, carriage return, U+2028, U+2029).
 *
 * The SQL half of `countsAsAnswer` in survey-results.ts, which decides
 * blankness with `.trim()`. Spelled out character by character because
 * `[:space:]` and `\S` are locale-dependent in Postgres and disagree with
 * JavaScript on U+00A0 at least - an answer of nothing but non-breaking
 * spaces would then be blank on the page and an answer in the CSV's flag.
 */
const NON_BLANK_TEXT =
  "[^\\t\\v\\f \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff\\n\\r\\u2028\\u2029]";

/**
 * The sessions holding at least one SUPERSEDED answer (cto/AdaptaLabs#152):
 * an answer that the same person's later answer to the same question replaces
 * on the results page.
 *
 * THE SAME RULE AS `supersededAnswers` in survey-results.ts, RESTATED IN SQL,
 * and that duplication is the price of the bound above: the stream reads a
 * hundred sessions at a time, and a person's other sessions may sit in any
 * batch, so the flag cannot be computed from the rows a batch holds. Each part
 * of the rule has its SQL twin here:
 *
 *   - who: `respondentKey` - the participant id, or the session for a row
 *     with none (the column is NOT NULL, so that arm is unreachable)
 *   - which question: `questionKey` - the step id, or for a removed question
 *     the type and the wording, NULL wording standing for the unknown one
 *   - what counts: `countsAsAnswer` - a question type, and a payload the
 *     tallies would count (non-blank text, a string selection, a non-empty
 *     multi-selection, a numeric rating)
 *   - which wins: the latest `(saved_at, id)`, which is exactly "later in the
 *     input" for rows both readers order by `(saved_at, id)`
 *
 * The two cannot drift apart unnoticed: survey-csv-export-postgres.test.ts
 * compares the streamed export byte for byte against `toResponsesCsv`, which
 * computes the flag in JavaScript, over a fixture seeded to exercise every
 * arm above.
 *
 * The `AND r.step_type = ANY(...)` line is BELT-AND-BRACES: every OR arm below
 * already names its own type (`open_text`, `rating`/`nps`, `single_choice`,
 * `multi_choice` - which is exactly `QUESTION_TYPES`), so a row matching any
 * arm already has a question type and the ANY clause admits nothing more. It
 * stays because it keeps the scope of the read legible at a glance and it is
 * what `csv-superseded-sql-keeps-to-the-export-scope` mutates to prove the
 * `${filter}` scope holds.
 *
 * Bounded by the session list: it returns ids, never payloads.
 */
async function readSupersededSessions(
  client: PoolClient,
  filter: ResponseFilter,
  params: unknown[]
): Promise<Set<string>> {
  const typesParam = `$${params.length + 1}`;
  const unknownParam = `$${params.length + 2}`;
  const nonBlankParam = `$${params.length + 3}`;

  const result = await client.query<{ session_id: string }>(
    `
        SELECT DISTINCT ranked.session_id
        FROM (
          SELECT r.session_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY
                     CASE WHEN s.participant_id <> ''
                          THEN 'p:' || s.participant_id
                          ELSE 's:' || r.session_id END,
                     r.step_id,
                     CASE WHEN r.step_id IS NULL THEN r.step_type END,
                     CASE WHEN r.step_id IS NULL
                          THEN COALESCE(r.step_prompt, ${unknownParam}) END
                   ORDER BY r.saved_at DESC, r.id DESC
                 ) AS recency
          FROM participant_responses AS r
          JOIN runtime_sessions AS s ON s.session_id = r.session_id
          WHERE ${filter}
            AND r.step_type = ANY(${typesParam}::text[])
            AND (
              (r.step_type = 'open_text'
                AND jsonb_typeof(r.response_payload -> 'text') = 'string'
                AND (r.response_payload ->> 'text') ~ ${nonBlankParam})
              OR (r.step_type IN ('rating', 'nps')
                AND jsonb_typeof(r.response_payload -> 'rating') = 'number')
              OR (r.step_type = 'single_choice'
                AND jsonb_typeof(r.response_payload -> 'selectedOption') = 'string')
              OR (r.step_type = 'multi_choice'
                AND jsonb_typeof(r.response_payload -> 'selectedOptions') = 'array'
                AND EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(r.response_payload -> 'selectedOptions') AS picked(value)
                  WHERE jsonb_typeof(picked.value) = 'string'
                ))
            )
        ) AS ranked
        WHERE ranked.recency > 1
      `,
    [...params, [...QUESTION_TYPES], UNKNOWN_REMOVED_PROMPT, NON_BLANK_TEXT]
  );

  return new Set(result.rows.map((row) => row.session_id));
}

/**
 * One batch of answers, retried while the pool is busy rather than giving up.
 *
 * Only pool REFUSALS are retried. A statement timeout, a syntax error or a
 * dropped connection are not capacity conditions and repeating them wastes the
 * export's deadline before failing anyway - so `isRuntimePoolRefusal` decides,
 * and it names both refusals the admission gate can produce: the immediate
 * `RuntimeDatabaseBusyError` and the `RuntimeDatabaseAdmissionTimeoutError`
 * that arrives after ADMIN_ADMISSION_TIMEOUT_MS of queueing, which is the one
 * this path actually meets - the batch read queues rather than skipping.
 */
async function readBatch(
  filter: ResponseFilter,
  params: unknown[],
  batch: string[],
  signal: AbortSignal
): Promise<StoredResponse[]> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withRuntimeDatabaseClient(
        async (client) => {
          const result = await client.query<ResponseRow>(
            `
        SELECT r.session_id, s.participant_id, r.step_id, r.step_prompt, r.step_type,
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
    } catch (error) {
      if (attempt >= CSV_BATCH_RETRY_ATTEMPTS || !isRuntimePoolRefusal(error)) {
        throw error;
      }

      logger.warn("Retrying a survey CSV batch read after a pool refusal", {
        attempt: attempt + 1,
        of: CSV_BATCH_RETRY_ATTEMPTS,
        participants: batch.length
      });

      await pause(CSV_BATCH_RETRY_BASE_DELAY_MS * 2 ** attempt, signal);
    }
  }
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
 * the alternative is holding a transaction open for the length of a download.
 *
 * The PREFLIGHT is different: the session list, the removed-question columns
 * and the superseded flags are read together in one REPEATABLE READ snapshot
 * (`readSurveyCsvPreflight`), so they describe one instant. A session started
 * after that snapshot is consistently absent rather than half-present, and -
 * the part a separate flag read got wrong - a session the list holds cannot be
 * flagged superseded against a later answer that the file does not contain,
 * because the flag and the list saw the same rows.
 */
async function* streamParticipants(
  scope: ResponseScope,
  sessions: { sessionId: string; participantId: string }[],
  superseded: ReadonlySet<string>,
  signal: AbortSignal
): AsyncGenerator<CsvSessionRow> {
  const { filter, params } = filterFor(scope);

  for (
    let index = 0;
    index < sessions.length;
    index += CSV_PARTICIPANT_BATCH
  ) {
    // THROWS RATHER THAN RETURNING, checked before paying for the next batch.
    // Returning would end the consumer's `for await` normally, and its normal
    // ending calls `res.end()` - a short CSV that parses, which is the exact
    // outcome the refusal design exists to prevent.
    signal.throwIfAborted();

    const batch = sessions.slice(index, index + CSV_PARTICIPANT_BATCH);

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
    const rows = await readBatch(
      filter,
      params,
      batch.map((session) => session.sessionId),
      signal
    );

    const bySession = new Map<string, StoredResponse[]>();
    for (const row of rows) {
      const group = bySession.get(row.session_id);
      if (group) {
        group.push(row);
      } else {
        bySession.set(row.session_id, [row]);
      }
    }

    // Yielded in the ORDER OF THE ID LIST, not the order the batch query
    // happened to return them. The list is what carries the grouped,
    // first-answer order. A session whose answers vanished between the
    // preflight and this read - a retake cascades them away - is yielded with
    // none, and the writer skips it as an absence.
    for (const session of batch) {
      yield {
        sessionId: session.sessionId,
        participantId: session.participantId || null,
        superseded: superseded.has(session.sessionId),
        answers: bySession.get(session.sessionId) ?? []
      };
    }
  }
}

/**
 * The three preflight reads, in ONE checkout and ONE snapshot.
 *
 * The session list, the removed-question columns and the superseded flags have
 * to agree, because the writer pairs them row by row: a flag set against a
 * session the list holds must describe the same rows the list was built from.
 * Read on three separate checkouts, as they once were, a session saved between
 * the list read and the flag read could be flagged superseded against a later
 * answer that the export - already scoped to the earlier list - does not
 * contain. A probe reproduced exactly that.
 *
 * So all three run on one client inside a REPEATABLE READ, READ ONLY
 * transaction. REPEATABLE READ freezes the snapshot at the first statement, so
 * the three see identical rows; READ ONLY says none of them writes and lets
 * Postgres skip the bookkeeping for a rollback it will never need. One checkout
 * rather than three is also one admission attempt rather than three on the
 * five-connection pool live participants share.
 *
 * The transaction wraps the PREFLIGHT ONLY. The batch reads run afterwards, on
 * their own short-lived checkouts with nothing held between them - the
 * occupancy property `streamParticipants` documents - so a slow download never
 * holds a transaction open.
 */
async function readSurveyCsvPreflight(scope: ResponseScope): Promise<{
  sessions: { sessionId: string; participantId: string }[];
  removedQuestions: RemovedQuestion[];
  superseded: Set<string>;
}> {
  const { filter, params } = filterFor(scope);

  return withRuntimeDatabaseClient(
    async (client) => {
      await client.query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
      );

      try {
        // THE BOUND FIRST, so the refusal is the cheap thing. All three scan
        // participant_responses under the same 120s statement budget, but only
        // the session list is bounded - it carries `LIMIT MAX_CSV_PARTICIPANTS
        // + 1` and decides the 413. Run last, a study too large to export would
        // pay for the other two reads before anyone told it no. All three are
        // reads of the same scope and none writes, so ordering only decides
        // WHICH pre-first-byte refusal arrives first, and either is honest.
        const sessions = await readCsvSessions(client, filter, params);
        const removedQuestions = await readRemovedColumns(client, filter, params);
        const superseded = await readSupersededSessions(client, filter, params);

        await client.query("COMMIT");
        return { sessions, removedQuestions, superseded };
      } catch (error) {
        // A read that threw (the 413, a pool refusal, a lost connection) leaves
        // the transaction open on a pooled connection the next borrower would
        // inherit mid-transaction - node-pg does not reset a connection on
        // release. Roll back before it goes home. Swallowed because the read's
        // own error is the one worth surfacing and a READ ONLY rollback has
        // nothing to fail at.
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    },
    { statementTimeoutMs: RESULTS_STATEMENT_TIMEOUT_MS }
  );
}

/**
 * Everything that can REFUSE an export, done before the export begins.
 *
 * A generator body does not run until its first `next()`, so a design where the
 * route set its headers and then started pulling would have discovered the
 * participant bound - and its 413 - with the response already committed. Once a
 * byte of the body is written the status is fixed, and the only honest failure
 * left is to destroy the connection. So the preflight happens HERE, in an
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
  participants: (signal: AbortSignal) => AsyncGenerator<CsvSessionRow>;
}> {
  if (!isPostgresRuntimeConfigured()) {
    return {
      removedQuestions: [],
      // eslint-disable-next-line require-yield
      participants: async function* (_signal: AbortSignal) {
        return;
      }
    };
  }

  const { sessions, removedQuestions, superseded } =
    await readSurveyCsvPreflight(scope);

  return {
    removedQuestions,
    // REQUIRED, not optional. An optional signal is a deadline a caller can
    // drop by accident, and the drop is silent - the export simply goes back
    // to being unbounded on the database side.
    participants: (signal: AbortSignal) =>
      streamParticipants(scope, sessions, superseded, signal)
  };
}
