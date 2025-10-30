import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../../db';
import { requireAuth } from '../../utils/auth';
import { createErrorResponse, getErrorMessage } from '../../utils/errors';
import { serializeRow } from '../../utils/helpers';

/**
 * GET /api/bookings/my/bookings
 * Get user's bookings (upcoming and past)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    // Get authenticated user from cookie
    const user = requireAuth(req);
    const userId = user.id;
    const now = new Date();

    const pool = getPool();

    // Get upcoming bookings (only active bookings for future sessions)
    const upcomingResult = await pool.query(`
      SELECT b.*, s.start_time as session_start_time, s.end_time as session_end_time, s.capacity as session_capacity,
             s.location_or_meet_link_optional as session_location,
             o.title as opportunity_title, o.type as opportunity_type,
             o.purpose_one_liner as opportunity_purpose,
             u.name as owner_name, u.email as owner_email
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      LEFT JOIN users u ON o.owner_user_id = u.id
      WHERE b.user_id = $1 AND b.status = 'booked' AND s.end_time > $2
      ORDER BY s.start_time ASC
    `, [userId, now]);

    // Get past bookings (cancelled bookings OR completed sessions)
    const pastResult = await pool.query(`
      SELECT b.*, s.start_time as session_start_time, s.end_time as session_end_time, s.capacity as session_capacity,
             s.location_or_meet_link_optional as session_location,
             o.title as opportunity_title, o.type as opportunity_type,
             o.purpose_one_liner as opportunity_purpose,
             u.name as owner_name, u.email as owner_email
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      LEFT JOIN users u ON o.owner_user_id = u.id
      WHERE b.user_id = $1 AND (b.status = 'cancelled' OR s.end_time <= $2)
      ORDER BY s.start_time DESC
    `, [userId, now]);

    // Serialize dates for API response
    const serializeBooking = (booking: any) => serializeRow(booking, [
      'session_start_time',
      'session_end_time',
      'cancelled_at',
      'created_at',
      'updated_at'
    ]);

    return res.status(200).json({
      upcoming: upcomingResult.rows.map(serializeBooking),
      past: pastResult.rows.map(serializeBooking)
    });

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
      createErrorResponse('Failed to fetch bookings', errorMessage)
    );
  }
}


