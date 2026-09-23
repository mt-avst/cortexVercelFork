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
      // `auto_closed = true` in the SAME statement as the status flip, so a
      // study can never be observed closed-by-the-sweep but not marked so. The
      // admin table's "Auto-closed" caption reads this; a manual close through
      // PATCH /api/opportunities/:id writes false instead.
      //
      // `AND status = 'published'` because the SELECT above is a separate
      // statement: a manual close or a move to draft landing between the two
      // would otherwise be overwritten as a sweep close.
      //
      // POST /:id/close-if-past also lands here, started by the owner. That is
      // still an automatic close for this flag: the rule (every session over)
      // decided it, not the person, and the endpoint closes nothing otherwise.
      await pool.query(
        "UPDATE opportunities SET status = $1, auto_closed = true WHERE id = $2 AND status = 'published'",
        ['closed', opportunityId]
      );
    }
  }
};

/**
 * Closes every published study whose `end_date` is in the past (Decision 3 /
 * WZ ended-studies). A study advertised as live past the date its author set is
 * a study lying to participants; auto-closing at `end_date` drops it out of the
 * participant Home's published list and its "N active studies" count, and makes
 * the participant detail page show the closed state.
 *
 * THAT CLOSED STATE IS NO LONGER UNCONDITIONALLY THE 410 OPPORTUNITY_CLOSED
 * PATH (cto/AdaptaLabs#129). `GET /api/opportunities/:id` exempts exactly one
 * viewer from it: a signed-in participant holding an IN-FLIGHT runtime session
 * on a native survey, poll or one-question study, who is served 200 with
 * `completion.inProgress` so the page can offer Resume instead. This sweep is
 * what creates that case - it can flip a study to `closed` while somebody is
 * part-way through - and the survey-session mint route lets that participant
 * finish rather than refusing them. Everybody else still gets the 410. Note
 * the participant Home consequence above is NOT similarly exempted: the list
 * read hard-filters non-admins to `status = 'published'`, so the study leaves
 * Browse for that participant too and their Resume page is reachable only by
 * direct URL.
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
 * Sets `auto_closed = true` in the same UPDATE as the status, like
 * `autoCloseOpportunityIfNeeded`: both are the automatic closes the admin
 * table captions "Auto-closed", as opposed to a manual close through PATCH.
 *
 * Returns the number of studies it closed, for the cron log.
 */
export const autoClosePublishedStudiesPastEndDate = async (): Promise<number> => {
  const result = await pool.query(
    `UPDATE opportunities
     SET status = 'closed', auto_closed = true
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
