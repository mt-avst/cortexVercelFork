import { pool } from '../config';

/**
 * All-time recruitment progress for one opportunity, for the admin studies
 * table: booked seats against offered seats across EVERY session the study has
 * ever had.
 *
 * WHY THIS IS NOT DERIVED FROM THE LIST'S `sessions` ARRAY. The admin list only
 * carries sessions ending in the last fourteen days (`ADMIN_RECENT_SESSIONS_ONLY`,
 * cto/AdaptaLabs#103), so summing that array reads a closed or long-running
 * study as "-" or as a fraction of its real progress. These totals are the
 * unwindowed figure the table's Progress column means.
 *
 * `total_booked` counts bookings with `status = 'booked'` only - a cancelled
 * booking released its seat. `total_capacity` is the sum of `sessions.capacity`.
 */
export interface OpportunityProgressTotals {
  total_booked: number;
  total_capacity: number;
}

/**
 * One batched read of all-time totals for the given opportunity ids, keyed by
 * opportunity id.
 *
 * THE CALLER'S ID LIST IS THE WHOLE OF THE SCOPE. This function never re-derives
 * ownership or visibility: it answers for exactly the ids it is handed, so an
 * owner-scoped list (`scope=mine`) yields owner-scoped totals by construction.
 *
 * AN OPPORTUNITY WITH NO SESSIONS IS ABSENT FROM THE MAP, not present as 0/0.
 * The route keys the response fields on presence, so "no sessions" reaches the
 * client as absent fields rather than a fabricated zero.
 *
 * BOOKINGS ARE COUNTED PER SESSION BEFORE CAPACITY IS SUMMED. A flat
 * `sessions LEFT JOIN bookings ... SUM(capacity)` repeats a session's capacity
 * once per booking row, so a capacity-4 session holding 2 bookings would read
 * 2/8. The LATERAL count collapses each session's bookings to one number first,
 * so every session contributes its capacity exactly once. It is served by
 * `idx_bookings_session`.
 *
 * Cost grows with the listed studies' lifetime session and booking count, not
 * with rows returned: the result is one row per opportunity, and the id list is
 * already bounded by `MAX_OPPORTUNITIES_RETURNED`.
 */
export async function loadOpportunityProgressTotals(
  opportunityIds: readonly string[]
): Promise<Map<string, OpportunityProgressTotals>> {
  const totals = new Map<string, OpportunityProgressTotals>();
  if (opportunityIds.length === 0) {
    return totals;
  }

  const result = await pool.query<{
    opportunity_id: string;
    total_booked: number;
    total_capacity: number;
  }>(
    `SELECT s.opportunity_id,
            COALESCE(SUM(per_session.booked), 0)::int AS total_booked,
            COALESCE(SUM(s.capacity), 0)::int AS total_capacity
     FROM sessions s
     CROSS JOIN LATERAL (
       SELECT COUNT(*)::int AS booked
       FROM bookings b
       WHERE b.session_id = s.id
         AND b.status = 'booked'
     ) per_session
     WHERE s.opportunity_id = ANY($1::uuid[])
     GROUP BY s.opportunity_id`,
    [opportunityIds]
  );

  for (const row of result.rows) {
    totals.set(String(row.opportunity_id), {
      total_booked: Number(row.total_booked),
      total_capacity: Number(row.total_capacity),
    });
  }
  return totals;
}

interface MockSessionShape {
  capacity?: unknown;
  booked_count?: unknown;
}

const toCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/**
 * The no-database fallback's equivalent of `loadOpportunityProgressTotals`, so
 * the admin list has the same shape on both paths. Mock sessions are never
 * windowed and carry a precomputed `booked_count`, so the totals are a plain sum
 * over the array the mock path already returns. `undefined` when there are no
 * sessions, matching the database path's absence.
 */
export function mockOpportunityProgressTotals(
  sessions: unknown
): OpportunityProgressTotals | undefined {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return undefined;
  }
  return (sessions as MockSessionShape[]).reduce<OpportunityProgressTotals>(
    (sum, session) => ({
      total_booked: sum.total_booked + toCount(session?.booked_count),
      total_capacity: sum.total_capacity + toCount(session?.capacity),
    }),
    { total_booked: 0, total_capacity: 0 }
  );
}
