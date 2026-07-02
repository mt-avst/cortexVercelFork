import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../../../db';
import { requireAuth } from '../../../utils/auth';
import { createErrorResponse, createSafeErrorResponse } from '../../../utils/errors';

/**
 * POST /api/bookings/sessions/[id]/complete
 * Mark the authenticated user's own booking for the given SESSION id as completed
 * (self-reported), pending admin approval.
 *
 * Auth: the authenticated user must have an active ('booked') booking for this
 * session — this is a participant self-service action, not an admin action.
 *
 * Response: { message: string; status: 'completed'; awaitingApproval: true }
 *
 * Mirrors backend/src/routes/bookings.ts POST /api/bookings/sessions/:id/complete.
 * No calendar or gamification interaction here (points are only awarded on admin
 * approval, via /api/bookings/[id]/approve).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    const { id: sessionId } = req.query;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json(createErrorResponse('Session ID is required'));
    }

    const user = requireAuth(req);
    const userId = user.id;

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get session and the requesting user's own booking for it (if any)
      const sessionResult = await client.query(`
        SELECT s.*, o.type as opportunity_type, o.title as opportunity_title,
               o.owner_user_id, b.id as booking_id, b.status as booking_status
        FROM sessions s
        JOIN opportunities o ON s.opportunity_id = o.id
        LEFT JOIN bookings b ON s.id = b.session_id AND b.user_id = $1 AND b.status = 'booked'
        WHERE s.id = $2
      `, [userId, sessionId]);

      if (sessionResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json(createErrorResponse('Session not found'));
      }

      const session = sessionResult.rows[0];

      // Check if user has an active booking for this session
      if (!session.booking_id) {
        await client.query('ROLLBACK');
        return res.status(400).json(createErrorResponse('You are not booked for this session'));
      }

      // Check if session has already ended (can only complete after session ends)
      const now = new Date();
      const sessionEndTime = new Date(session.end_time);

      if (now < sessionEndTime) {
        await client.query('ROLLBACK');
        return res.status(400).json(createErrorResponse('Cannot complete session before it ends'));
      }

      // Check if session has already been marked as completed
      const existingCompletion = await client.query(`
        SELECT completion_status FROM bookings
        WHERE user_id = $1 AND session_id = $2 AND completion_status != 'pending'
      `, [userId, sessionId]);

      if (existingCompletion.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json(createErrorResponse('Session completion already submitted'));
      }

      // Mark session as completed (pending admin approval)
      await client.query(`
        UPDATE bookings
        SET completion_status = 'completed', completed_at = NOW()
        WHERE user_id = $1 AND session_id = $2
      `, [userId, sessionId]);

      await client.query('COMMIT');

      return res.status(200).json({
        message: 'Session completion submitted successfully. Awaiting admin approval for AdaptaBits.',
        status: 'completed',
        awaitingApproval: true,
      });
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    // Handle auth errors
    if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
      return res.status(401).json(createErrorResponse(
        typeof error === 'object' && 'error' in error
          ? String(error.error)
          : 'Not authenticated'
      ));
    }

    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Failed to complete session' })
    );
  }
}
