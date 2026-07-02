import { pool } from '../config';

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
