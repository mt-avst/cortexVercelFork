import {
  isPostgresRuntimeConfigured,
  withRuntimeDatabaseClient
} from "./runtime-database";
import type { StoredResponse } from "./survey-results";
import { AppError } from "../../../shared/types";

type ResponseRow = {
  session_id: string;
  step_id: string;
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
 * `participant_responses` has no study_id of its own - it hangs off
 * `runtime_sessions`, which does - so the join is how a study's answers are
 * identified at all. Only the WHERE clause differs between the two callers,
 * and it is the clause that decides who is allowed to see what, so it is
 * passed in explicitly rather than assembled from optional arguments.
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
        SELECT r.session_id, r.step_id, r.step_type, r.response_payload, r.saved_at
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
