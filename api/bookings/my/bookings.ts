import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../../db';

/**
 * GET /api/bookings/my/bookings
 * Get user's bookings (upcoming and past)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get authenticated user from cookie
    const cookies = req.headers.cookie || '';
    const cookiePairs = cookies.split(';').map(c => c.trim());
    let sessionData: string | null = null;

    // Find session cookie (check from end to get most recent)
    for (let i = cookiePairs.length - 1; i >= 0; i--) {
      const pair = cookiePairs[i];
      if (pair.startsWith('adaptalabs_session=')) {
        sessionData = pair.substring('adaptalabs_session='.length);
        break;
      }
    }

    if (!sessionData) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Parse user from cookie
    let user: any;
    try {
      let decodedData: string;
      try {
        decodedData = decodeURIComponent(sessionData);
        if (decodedData === sessionData && sessionData.startsWith('{')) {
          decodedData = sessionData;
        }
      } catch {
        decodedData = sessionData;
      }
      user = JSON.parse(decodedData);
    } catch (error) {
      console.error('Error parsing session:', error);
      return res.status(401).json({ error: 'Invalid session' });
    }

    if (!user.id) {
      return res.status(401).json({ error: 'Invalid session - missing user ID' });
    }

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
    const serializeBooking = (booking: any) => ({
      ...booking,
      session_start_time: booking.session_start_time.toISOString(),
      session_end_time: booking.session_end_time.toISOString(),
      cancelled_at: booking.cancelled_at ? booking.cancelled_at.toISOString() : undefined,
      created_at: booking.created_at.toISOString(),
      updated_at: booking.updated_at.toISOString(),
    });

    return res.status(200).json({
      upcoming: upcomingResult.rows.map(serializeBooking),
      past: pastResult.rows.map(serializeBooking)
    });

  } catch (error: any) {
    console.error('Error fetching user bookings:', error);
    return res.status(500).json({
      error: 'Failed to fetch bookings',
      details: error.message,
    });
  }
}

