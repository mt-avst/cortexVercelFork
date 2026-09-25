import { withRuntimeDatabaseClient } from './runtime-database';

/**
 * All-time count of distinct participants who have answered at least one
 * question of a native (`delivery_mode = 'native'`) poll, survey or question
 * opportunity - the admin studies table's Progress cell for those rows
 * (cto/AdaptaLabs#162).
 *
 * SAME DEFINITION AS THE RESULTS TAB, BYTE-IDENTICAL KEY. `respondentKey` in
 * survey-results.ts is `row.participant_id ? 'p:'+participant_id : 's:'+session_id`,
 * treating an empty string as absent. `COALESCE('p:' || NULLIF(s.participant_id,
 * ''), 's:' || s.session_id)` below is the same branch written as one SQL
 * expression - not the differently-prefixed `COALESCE(NULLIF(...), 'session:'
 * || ...)` shape it is easy to reach for instead, which would count correctly
 * but tag rows under a prefix nothing else in the codebase uses, and drift the
 * moment either copy is touched alone.
 *
 * ONE PAIR PER OPPORTUNITY, not just an id list. `runtime_sessions.study_id`
 * is compared against the CALLER-SUPPLIED study id for that specific
 * opportunity, not any study id at all - an opportunity's `firsthand_study_id`
 * can be repointed after answers exist, and a session minted under the old
 * link must not be counted against the new one. This mirrors
 * `listResponsesForOpportunity` (survey-results-repository.ts), which the
 * Results tab reads through, except that reader takes one opportunity at a
 * time and this takes the caller's whole scoped list in one round trip.
 *
 * AN OPPORTUNITY IS ABSENT FROM THE MAP WHEN IT HAS NO STORED ANSWER, not
 * present as 0 - matching `loadOpportunityProgressTotals`. The caller decides
 * what "no answer yet" means for an applicable row (0, per cto/AdaptaLabs#162:
 * "0 is a real value for a native study with no answers").
 *
 * `WHERE EXISTS` rather than a `JOIN` against `participant_responses`, so cost
 * follows the matched SESSIONS (bounded by `runtime_sessions_opportunity_idx`),
 * not the answer rows a busy session can multiply - a join would re-count the
 * same session once per stored answer before `COUNT(DISTINCT ...)` folded it
 * back down, doing that work for nothing.
 *
 * Runs on the runtime pool (`withRuntimeDatabaseClient`), the same
 * five-connection pool `findParticipantCompletionsForOpportunities` shares
 * with live participant sessions - so this is skipped by the caller entirely
 * (see `routes/opportunities.ts`) rather than sent with an empty pair list,
 * and admits with `{ whenBusy: 'skip' }` exactly as the advisory answer-count
 * read in survey-results-repository.ts does: this feeds an admin list page,
 * not a page that has to produce an answer, so this would rather let this one
 * field go absent than queue behind participant admission and stall the
 * whole list for it. The caller treats `RuntimeDatabaseBusyError` the same
 * way it treats any other failure here - see the comment above the call site.
 */
export interface OpportunityResponseTotalInput {
  opportunityId: string;
  studyId: string;
}

export async function loadOpportunityResponseTotals(
  pairs: readonly OpportunityResponseTotalInput[]
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  if (pairs.length === 0) {
    return totals;
  }

  return withRuntimeDatabaseClient(
    async (client) => {
      const opportunityIds = pairs.map((pair) => pair.opportunityId);
      const studyIds = pairs.map((pair) => pair.studyId);

      const result = await client.query<{
        opportunity_id: string;
        responses_total: number;
      }>(
        `SELECT pairs.opportunity_id,
                COUNT(DISTINCT COALESCE('p:' || NULLIF(s.participant_id, ''), 's:' || s.session_id))::int
                  AS responses_total
         FROM unnest($1::text[], $2::text[]) AS pairs(opportunity_id, study_id)
         JOIN runtime_sessions s
           ON s.opportunity_id = pairs.opportunity_id
          AND s.study_id = pairs.study_id
         WHERE EXISTS (
           SELECT 1 FROM participant_responses r WHERE r.session_id = s.session_id
         )
         GROUP BY pairs.opportunity_id`,
        [opportunityIds, studyIds]
      );

      for (const row of result.rows) {
        totals.set(String(row.opportunity_id), Number(row.responses_total));
      }
      return totals;
    },
    { whenBusy: 'skip' }
  );
}
