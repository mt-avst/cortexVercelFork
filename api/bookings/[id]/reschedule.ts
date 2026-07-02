import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../../db';
import { requireAuth } from '../../utils/auth';
import { createErrorResponse, createSafeErrorResponse } from '../../utils/errors';
import type { RescheduleBookingRequest } from '../../../shared/types';

/**
 * POST /api/bookings/[id]/reschedule
 * Move an active ('booked') booking owned by the authenticated user to a different
 * session of the same opportunity.
 *
 * Auth: the authenticated user must be the booking's owner (participant). Unlike some
 * other booking-lifecycle endpoints, there is no admin bypass here — this mirrors the
 * Express reference, whose query scopes the lookup to `b.user_id = $2` (the requester).
 *
 * Request body: { target_session_id: string }
 * Response: { message: string }
 *
 * Mirrors backend/src/routes/bookings.ts POST /api/bookings/:id/reschedule, with one
 * intentional omission: the post-commit calendar-sync block (update/recreate the
 * gcal_event_id event via calendarService) is NOT ported here. `backend/src/services/calendar.ts`
 * is hard-coded to demo mode today ("Always use demo mode for now"), the Express handler
 * wraps that whole block in a try/catch that swallows any failure and always returns
 * success regardless of calendar outcome, so omitting it is functionally equivalent to
 * today's behavior. Porting a real calendarService is deferred to a separate Google
 * Calendar service port (Phase B4 follow-up).
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

    const user = requireAuth(req);
    const userId = user.id;

    const { target_session_id } = (req.body ?? {}) as RescheduleBookingRequest;

    if (!target_session_id) {
      return res.status(400).json(createErrorResponse('target_session_id is required'));
    }

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Load booking with current session details, scoped to the requesting user's
      // own active booking.
      const bookingResult = await client.query(`
        SELECT b.*, s.opportunity_id as current_opportunity_id, o.title as opportunity_title
        FROM bookings b
        JOIN sessions s ON b.session_id = s.id
        JOIN opportunities o ON s.opportunity_id = o.id
        WHERE b.id = $1 AND b.user_id = $2 AND b.status = 'booked'
      `, [bookingId, userId]);

      if (bookingResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json(createErrorResponse('Active booking not found'));
      }

      const booking = bookingResult.rows[0];

      // Load target session with opportunity details, locked for update.
      const targetSessionResult = await client.query(`
        SELECT s.*, o.status as opportunity_status, o.title as opportunity_title,
               o.purpose_one_liner, o.id as opportunity_id, o.owner_user_id
        FROM sessions s
        JOIN opportunities o ON s.opportunity_id = o.id
        WHERE s.id = $1
        FOR UPDATE NOWAIT
      `, [target_session_id]);

      if (targetSessionResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json(createErrorResponse('Target session not found'));
      }

      const targetSession = targetSessionResult.rows[0];

      // Guardrails
      if (targetSession.opportunity_id !== booking.current_opportunity_id) {
        await client.query('ROLLBACK');
        return res.status(400).json(createErrorResponse('Target session must be from the same opportunity'));
      }

      if (targetSession.opportunity_status !== 'published') {
        await client.query('ROLLBACK');
        return res.status(400).json(createErrorResponse('Target opportunity not published'));
      }

      if (new Date(targetSession.end_time) <= new Date()) {
        await client.query('ROLLBACK');
        return res.status(400).json(createErrorResponse('Cannot reschedule to past sessions'));
      }

      if (targetSession.booked_count >= targetSession.capacity) {
        await client.query('ROLLBACK');
        return res.status(409).json(createErrorResponse('Target session is full'));
      }

      // Lock current session for update
      await client.query(`
        SELECT * FROM sessions WHERE id = $1 FOR UPDATE
      `, [booking.session_id]);

      // Move booking to target session
      await client.query(`
        UPDATE bookings
        SET session_id = $1
        WHERE id = $2
      `, [target_session_id, bookingId]);

      // Update booked counts atomically (with safeguards)
      await client.query(`
        UPDATE sessions
        SET booked_count = GREATEST(booked_count - 1, 0)
        WHERE id = $1
      `, [booking.session_id]);

      await client.query(`
        UPDATE sessions
        SET booked_count = booked_count + 1
        WHERE id = $1
      `, [target_session_id]);

      await client.query('COMMIT');

      // Calendar sync intentionally omitted here — see handler doc comment above.

      return res.status(200).json({ message: 'Booking rescheduled successfully' });
    } catch (error: unknown) {
      await client.query('ROLLBACK');

      // Handle lock timeout specifically (mirrors Express's ConflictError for code 55P03)
      if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') {
        return res.status(409).json(createErrorResponse('Session is being modified by another user. Please try again.'));
      }

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
      createSafeErrorResponse(error, { userMessage: 'Failed to reschedule booking' })
    );
  }
}
