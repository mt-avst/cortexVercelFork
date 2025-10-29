import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../../db';

/**
 * POST /api/bookings/[id]/cancel
 * Cancel a booking for the authenticated user
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { id: bookingId } = req.query;

    if (!bookingId || typeof bookingId !== 'string') {
      return res.status(400).json({ error: 'Booking ID is required' });
    }

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
    const isAdmin = user.role === 'researcher_admin';

    const pool = getPool();

    // Load booking with session and opportunity details
    const bookingResult = await pool.query(`
      SELECT b.*, s.end_time, s.opportunity_id, o.owner_user_id, o.title as opportunity_title,
             u.name as owner_name, u.email as owner_email
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      JOIN users u ON o.owner_user_id = u.id
      WHERE b.id = $1
    `, [bookingId]);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];

    // Authorization check
    const canCancel = booking.user_id === userId || 
                     (isAdmin && booking.owner_user_id === userId);
    
    if (!canCancel) {
      return res.status(403).json({ error: 'Not authorized to cancel this booking' });
    }

    // State checks
    if (booking.status === 'cancelled') {
      return res.status(200).json({ message: 'Booking already cancelled' });
    }

    if (new Date(booking.end_time) <= new Date()) {
      return res.status(400).json({ error: 'Cannot cancel past sessions' });
    }

    // Start transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update booking status
      await client.query(`
        UPDATE bookings 
        SET status = 'cancelled', cancelled_at = NOW()
        WHERE id = $1
      `, [bookingId]);

      // Decrement session booked_count (with safeguard to prevent negative values)
      await client.query(`
        UPDATE sessions 
        SET booked_count = GREATEST(booked_count - 1, 0)
        WHERE id = $1
      `, [booking.session_id]);

      await client.query('COMMIT');

      return res.status(200).json({ message: 'Booking cancelled successfully' });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error: any) {
    console.error('Error cancelling booking:', error);
    return res.status(500).json({
      error: 'Failed to cancel booking',
      details: error.message,
    });
  }
}

