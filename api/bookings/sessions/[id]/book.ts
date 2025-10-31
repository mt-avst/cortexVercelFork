import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../../../db';
import { requireAuth } from '../../../utils/auth';
import { createErrorResponse, getErrorMessage } from '../../../utils/errors';

/**
 * POST /api/bookings/sessions/[id]/book
 * Book a session for the authenticated user
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

    // Get authenticated user from cookie
    const user = requireAuth(req);
    const userId = user.id;

    // Start transaction for atomic booking
    const client = await getPool().connect();
    
    try {
      await client.query('BEGIN');

      // Lock session row for update to prevent race conditions
      const sessionResult = await client.query(`
        SELECT s.*, o.status as opportunity_status, o.title as opportunity_title,
               o.owner_user_id
        FROM sessions s
        JOIN opportunities o ON s.opportunity_id = o.id
        WHERE s.id = $1
        FOR UPDATE NOWAIT
      `, [sessionId]);

      if (sessionResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json(createErrorResponse('Session not found'));
      }

      const session = sessionResult.rows[0];

      // Guardrails
      if (session.opportunity_status !== 'published') {
        await client.query('ROLLBACK');
        return res.status(404).json(createErrorResponse('Session not found or opportunity not published'));
      }

      if (new Date(session.end_time) <= new Date()) {
        await client.query('ROLLBACK');
        return res.status(400).json(createErrorResponse('Cannot book past sessions'));
      }

      // Check if already booked by this user (only active bookings)
      const existingBooking = await client.query(
        'SELECT id FROM bookings WHERE user_id = $1 AND session_id = $2 AND status = $3',
        [userId, sessionId, 'booked']
      );

      if (existingBooking.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json(createErrorResponse('Already booked for this session'));
      }

      // Check capacity (double-check after lock)
      if (session.booked_count >= session.capacity) {
        await client.query('ROLLBACK');
        return res.status(409).json(createErrorResponse('Session is full'));
      }

      // Create booking
      const bookingResult = await client.query(`
        INSERT INTO bookings (user_id, session_id, status)
        VALUES ($1, $2, 'booked')
        RETURNING *
      `, [userId, sessionId]);

      // Increment booked_count atomically
      await client.query(`
        UPDATE sessions 
        SET booked_count = booked_count + 1
        WHERE id = $1
      `, [sessionId]);

      await client.query('COMMIT');

      const booking = bookingResult.rows[0];

      // Return booking with serialized dates
      return res.status(201).json({
        ...booking,
        created_at: booking.created_at.toISOString(),
        updated_at: booking.updated_at.toISOString(),
        cancelled_at: booking.cancelled_at ? booking.cancelled_at.toISOString() : null,
      });

    } catch (error: unknown) {
      await client.query('ROLLBACK');
      
      // Handle specific PostgreSQL errors
      if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') {
        // Lock timeout - session is being booked by another user
        return res.status(409).json(createErrorResponse('Session is being booked by another user. Please try again.'));
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

    const errorMessage = getErrorMessage(error);
    return res.status(500).json(
      createErrorResponse('Failed to book session', errorMessage)
    );
  }
}

