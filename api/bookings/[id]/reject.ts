import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../../db';
import { requireAdmin, assertOwnerOrSuperadmin, handleAuthError } from '../../utils/auth';
import { createErrorResponse, createSafeErrorResponse, getErrorMessage } from '../../utils/errors';
import { logger } from '../../utils/logger';

/**
 * POST /api/bookings/[id]/reject
 * Reject a completed session booking (no gamification points, no calendar interaction).
 *
 * Auth: requires researcher_admin or superadmin. A researcher_admin may only reject
 * bookings for opportunities they own; superadmin may reject any (via
 * `assertOwnerOrSuperadmin`, consistent with approve.ts and every other admin-ownership
 * check in this codebase).
 *
 * Request body: { adminNotes?: string }
 * Response: { message: string; status: 'rejected' }
 *
 * Mirrors backend/src/routes/bookings.ts POST /api/bookings/:bookingId/reject.
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

      // Get booking details
      const bookingResult = await client.query(`
        SELECT b.*, o.owner_user_id
        FROM bookings b
        JOIN sessions s ON b.session_id = s.id
        JOIN opportunities o ON s.opportunity_id = o.id
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

      // Update booking status to rejected
      await client.query(`
        UPDATE bookings
        SET completion_status = 'rejected',
            approved_at = NOW(),
            approved_by = $1,
            admin_notes = $2
        WHERE id = $3
      `, [adminId, adminNotes || null, bookingId]);

      await client.query('COMMIT');

      return res.status(200).json({
        message: 'Session rejected successfully',
        status: 'rejected',
      });
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    logger.error('Error rejecting session', {
      errorMessage: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Failed to reject session' })
    );
  }
}
