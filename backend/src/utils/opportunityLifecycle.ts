import { pool } from '../config';
import { logger } from './logger';

// Closes an opportunity once every session under it is in the past. Shared between
// sessions.ts (called after creating sessions) and opportunities.ts (the explicit
// close-if-past endpoint), since both need to trigger the same check.
export const autoCloseOpportunityIfNeeded = async (opportunityId: string): Promise<void> => {
  const result = await pool.query(`
    SELECT COUNT(*) as total_sessions,
           COUNT(CASE WHEN end_time < NOW() THEN 1 END) as past_sessions,
           status
    FROM sessions s
    JOIN opportunities o ON s.opportunity_id = o.id
    WHERE s.opportunity_id = $1
    GROUP BY o.status
  `, [opportunityId]);

  if (result.rows.length > 0) {
    const { total_sessions, past_sessions, status } = result.rows[0];
    if (total_sessions > 0 && past_sessions == total_sessions && status === 'published') {
      await pool.query(
        'UPDATE opportunities SET status = $1 WHERE id = $2',
        ['closed', opportunityId]
      );
    }
  }
};

/**
 * Closes every published study whose `end_date` is in the past (Decision 3 /
 * WZ ended-studies). A study advertised as live past the date its author set is
 * a study lying to participants; auto-closing at `end_date` makes the participant
 * detail page show the closed state (the 410 OPPORTUNITY_CLOSED path) and drops
 * it out of the participant Home's published list and its "N active studies"
 * count.
 *
 * A set-based sweep rather than a per-row check because it runs on a schedule
 * over the whole table, and unlike `autoCloseOpportunityIfNeeded` it does NOT
 * need a session: a survey or poll that hands off has no sessions but still has
 * an `end_date`, and that is exactly the case the session-based close could
 * never reach. `end_date IS NOT NULL` leaves open-ended studies alone, and
 * `status = 'published'` means a draft with a past date stays a draft and an
 * already-closed study is untouched - the sweep only ever moves published ->
 * closed. `NOW()` is the database clock, so the boundary is a real timestamptz
 * comparison, not an app-server time the test would have to stub.
 *
 * Returns the number of studies it closed, for the cron log.
 */
export const autoClosePublishedStudiesPastEndDate = async (): Promise<number> => {
  const result = await pool.query(
    `UPDATE opportunities
     SET status = 'closed'
     WHERE status = 'published'
       AND end_date IS NOT NULL
       AND end_date < NOW()
     RETURNING id`
  );
  const closed = result.rowCount ?? 0;
  if (closed > 0) {
    logger.info('Auto-closed studies past their end date', {
      count: closed,
      ids: result.rows.map((row) => row.id),
    });
  }
  return closed;
};
