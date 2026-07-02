import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../../db';
import { requireAdmin, assertOwnerOrSuperadmin, handleAuthError } from '../../utils/auth';
import { createErrorResponse, createSafeErrorResponse, getErrorMessage } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { awardPointsAfterApproval } from '../../../shared/services/gamification';
import type { OpportunityType } from '../../../shared/types';

/**
 * POST /api/bookings/[id]/approve
 * Approve a completed session booking, awarding AdaptaBits (gamification points) to
 * the participant.
 *
 * Auth: requires researcher_admin or superadmin. A researcher_admin may only approve
 * bookings for opportunities they own; superadmin may approve any (via
 * `assertOwnerOrSuperadmin`, consistent with every other admin-ownership check in
 * this codebase).
 *
 * Request body: { adminNotes?: string }
 * Response: { message: string; pointsAwarded: number; newLevel: number; levelUp: boolean; totalPoints: number }
 *
 * Mirrors backend/src/routes/bookings.ts POST /api/bookings/:bookingId/approve, with
 * one bug fix: the Express reference's booking-lookup query never selects
 * `o.id as opportunity_id`, so its call to `awardPointsAfterApproval` passes
 * `opportunityId = undefined` (silently stored as NULL in points_transactions,
 * does not throw). This port adds `o.id as opportunity_id` to the SELECT (matching
 * how book.ts/reschedule.ts already alias it) so a real opportunity ID is recorded.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    const { id: bookingId } = req.query;

    if (!bookingId || typeof bookingId !== 'string') {
      return res.status(400).json(createErrorResponse('Booking ID is required'));
    }

    let admin;
    try {
      admin = requireAdmin(req);
    } catch (authErr) {
      if (handleAuthError(res, authErr)) return;
      throw authErr;
    }
    const adminId = admin.id;

    const { adminNotes } = (req.body ?? {}) as { adminNotes?: string };

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get booking details (opportunity_id added vs. Express — see doc comment above)
      const bookingResult = await client.query(`
        SELECT b.*, s.start_time, s.end_time, o.title as opportunity_title, o.type as opportunity_type,
               o.id as opportunity_id, o.owner_user_id, u.name as user_name
        FROM bookings b
        JOIN sessions s ON b.session_id = s.id
        JOIN opportunities o ON s.opportunity_id = o.id
        JOIN users u ON b.user_id = u.id
        WHERE b.id = $1 AND b.completion_status = 'completed'
      `, [bookingId]);

      if (bookingResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json(createErrorResponse('Completed session booking not found'));
      }

      const booking = bookingResult.rows[0];

      try {
        assertOwnerOrSuperadmin(admin, booking.owner_user_id);
      } catch (authErr) {
        await client.query('ROLLBACK');
        if (handleAuthError(res, authErr)) return;
        throw authErr;
      }

      // Update booking status to approved
      await client.query(`
        UPDATE bookings
        SET completion_status = 'approved',
            approved_at = NOW(),
            approved_by = $1,
            admin_notes = $2
        WHERE id = $3
      `, [adminId, adminNotes || null, bookingId]);

      await client.query('COMMIT');

      // Award AdaptaBits after approval
      const pointsResult = await awardPointsAfterApproval(
        pool,
        booking.user_id,
        booking.opportunity_type as OpportunityType,
        booking.opportunity_id,
        booking.session_id,
        adminId
      );

      return res.status(200).json({
        message: 'Session approved successfully',
        pointsAwarded: pointsResult.points,
        newLevel: pointsResult.newLevel,
        levelUp: pointsResult.levelUp,
        totalPoints: pointsResult.totalPoints,
      });
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    logger.error('Error approving session', {
      errorMessage: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Failed to approve session' })
    );
  }
}
