import {
  isPostgresRuntimeConfigured,
  withRuntimeDatabaseClient
} from "./runtime-database";
import type { StoredResponse } from "./survey-results";
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

  return withRuntimeDatabaseClient(async (client) => {
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

    return result.rows.map((row) => ({
      session_id: row.session_id,
      step_id: row.step_id,
      step_prompt: row.step_prompt,
      step_type: row.step_type,
      response_payload: row.response_payload ?? {},
      saved_at: new Date(row.saved_at).toISOString()
    }));
  });
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
    return await withRuntimeDatabaseClient(async (client) => {
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
       * does not fit a JS number safely, so the driver refuses to guess. Passed
       * through it survives JSON and reaches the form as `"0"`, which is
       * truthy: every question with no answers would warn.
       */
      return Object.fromEntries(
        result.rows.map((row) => [row.step_id, Number(row.answers)])
      );
    });
  } catch (error) {
    logger.warn("Could not count answers per question", {
      studyId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return null;
  }
}
