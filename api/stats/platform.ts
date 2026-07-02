import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { createErrorResponse } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * GET /api/stats/platform
 * Public endpoint (no auth required — mirrors backend/src/routes/stats.ts,
 * mounted with the comment "public, no auth required").
 *
 * Returns platform-wide statistics for the homepage KPI display:
 * - activeStudies: Count of published opportunities
 * - participantsRegistered: Count of unique users with bookings
 * - rewardsDistributed: Placeholder value (completed bookings * $15, or a
 *   fallback constant if that computes to 0)
 *
 * On any error, falls back to fixed placeholder values (still 200 OK) so the
 * homepage widget never breaks — this matches the Express reference exactly.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    // Count active (published) studies
    const activeStudiesResult = await query(
      `SELECT COUNT(*) as count FROM opportunities WHERE status = 'published'`
    );
    const activeStudies = parseInt(
      String((activeStudiesResult.rows[0] as { count?: string })?.count || '0'),
      10
    );

    // Count unique participants (users who have made at least one booking)
    const participantsResult = await query(`SELECT COUNT(DISTINCT user_id) as count FROM bookings`);
    const participantsRegistered = parseInt(
      String((participantsResult.rows[0] as { count?: string })?.count || '0'),
      10
    );

    // Rewards distributed - placeholder value based on completed bookings
    const completedBookingsResult = await query(
      `SELECT COUNT(*) as count
       FROM bookings b
       JOIN sessions s ON b.session_id = s.id
       WHERE s.start_time < NOW()`
    );
    const completedBookings = parseInt(
      String((completedBookingsResult.rows[0] as { count?: string })?.count || '0'),
      10
    );
    // Assume average $15 reward per completed session
    const rewardsDistributed = completedBookings * 15 || 1200; // Fallback to placeholder

    return res.status(200).json({
      activeStudies,
      participantsRegistered,
      rewardsDistributed,
    });
  } catch (error: unknown) {
    logger.error('Error fetching platform stats', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // Return placeholder values on error (matches Express reference behavior)
    return res.status(200).json({
      activeStudies: 9,
      participantsRegistered: 875,
      rewardsDistributed: 1200,
    });
  }
}
