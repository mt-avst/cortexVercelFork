import {
  isPostgresRuntimeConfigured,
  withRuntimeDatabaseClient
} from "./runtime-database";
import type { StoredResponse } from "./survey-results";

/**
 * Reads every stored answer for a study, for the results view.
 *
 * `participant_responses` has no study_id of its own - it hangs off
 * `runtime_sessions`, which does - so the join is how a study's answers are
 * identified at all.
 *
 * Its own module rather than another function on studies-repository: that file
 * is being extended on another branch, and this needs nothing from it.
 */
export async function listResponsesForStudy(
  studyId: string
): Promise<StoredResponse[]> {
  if (!isPostgresRuntimeConfigured()) {
    return [];
  }

  return withRuntimeDatabaseClient(async (client) => {
    const result = await client.query<{
      session_id: string;
      step_id: string;
      step_type: string;
      response_payload: Record<string, unknown>;
      saved_at: Date | string;
    }>(
      `
        SELECT r.session_id, r.step_id, r.step_type, r.response_payload, r.saved_at
        FROM participant_responses AS r
        JOIN runtime_sessions AS s ON s.session_id = r.session_id
        WHERE s.study_id = $1
        ORDER BY r.saved_at ASC, r.id ASC
      `,
      [studyId]
    );

    return result.rows.map((row) => ({
      session_id: row.session_id,
      step_id: row.step_id,
      step_type: row.step_type,
      response_payload: row.response_payload ?? {},
      saved_at: new Date(row.saved_at).toISOString()
    }));
  });
}
