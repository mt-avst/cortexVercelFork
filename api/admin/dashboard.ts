import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';
import { createErrorResponse, getErrorMessage } from '../utils/errors';
import { requireAuth } from '../utils/auth';
import { logger } from '../utils/logger';

export interface RecentBookingItem {
  id: string;
  opportunity_id: string;
  opportunity_title: string;
  session_start: string;
  participant_name: string;
  participant_email: string;
  status: string;
  booked_at: string;
}

interface DashboardStats {
  total_opportunities: number;
  published_opportunities: number;
  draft_opportunities: number;
  closed_opportunities: number;
  total_bookings: number;
  upcoming_bookings: number;
  past_bookings: number;
  total_participants: number;
  total_sessions: number;
  total_slots: number;
  booked_slots: number;
  available_slots: number;
  recent_bookings: RecentBookingItem[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    // Get authenticated user from cookie
    const user = requireAuth(req);
    
    // Check admin role
    if (user.role !== 'researcher_admin' && user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Forbidden: Admin access required'));
    }

    const userId = user.id;
    // Superadmin sees global stats; researcher_admin sees only their opportunities
    const filterOwnerId = user.role === 'superadmin' ? null : userId;
    const pool = getPool();

    // Get opportunity counts (filter by owner unless superadmin)
    const oppCounts = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'published') as published,
        COUNT(*) FILTER (WHERE status = 'draft') as draft,
        COUNT(*) FILTER (WHERE status = 'closed') as closed
      FROM opportunities
      WHERE ($1::uuid IS NULL OR owner_user_id = $1)
    `, [filterOwnerId]);

    // Get booking counts
    const now = new Date();
    const bookingCounts = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE b.status = 'booked' AND s.start_time > $1) as upcoming,
        COUNT(*) FILTER (WHERE (b.status = 'booked' AND s.start_time <= $1) OR b.status = 'cancelled') as past
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      WHERE ($2::uuid IS NULL OR o.owner_user_id = $2)
    `, [now, filterOwnerId]);

    // Get unique participants count
    const participantsCount = await pool.query(`
      SELECT COUNT(DISTINCT b.user_id) as total
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      WHERE ($1::uuid IS NULL OR o.owner_user_id = $1) AND b.status = 'booked'
    `, [filterOwnerId]);

    // Get session and slot statistics
    const sessionStats = await pool.query(`
      SELECT 
        COUNT(DISTINCT s.id) as total_sessions,
        SUM(s.capacity) as total_slots,
        SUM(s.booked_count) as booked_slots
      FROM sessions s
      JOIN opportunities o ON s.opportunity_id = o.id
      WHERE ($1::uuid IS NULL OR o.owner_user_id = $1)
    `, [filterOwnerId]);

    // M7: Recent bookings list (with session times)
    const recentBookingsResult = await pool.query(`
      SELECT b.id, o.id as opportunity_id, o.title as opportunity_title,
             s.start_time as session_start, u.name as participant_name, u.email as participant_email,
             b.status, b.booked_at
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      JOIN users u ON b.user_id = u.id
      WHERE ($1::uuid IS NULL OR o.owner_user_id = $1)
      ORDER BY b.booked_at DESC
      LIMIT 15
    `, [filterOwnerId]);

    const oppRow = oppCounts.rows[0] || {};
    const bookingRow = bookingCounts.rows[0] || {};
    const participantRow = participantsCount.rows[0] || {};
    const sessionRow = sessionStats.rows[0] || {};

    const totalSlots = parseInt(String(sessionRow.total_slots || '0')) || 0;
    const bookedSlots = parseInt(String(sessionRow.booked_slots || '0')) || 0;

    const recent_bookings: RecentBookingItem[] = (recentBookingsResult.rows || []).map((row: Record<string, unknown>) => ({
      id: String(row.id),
      opportunity_id: String(row.opportunity_id),
      opportunity_title: String(row.opportunity_title || ''),
      session_start: row.session_start ? new Date(row.session_start as Date).toISOString() : '',
      participant_name: String(row.participant_name || ''),
      participant_email: String(row.participant_email || ''),
      status: String(row.status || 'booked'),
      booked_at: row.booked_at ? new Date(row.booked_at as Date).toISOString() : '',
    }));

    const stats: DashboardStats = {
      total_opportunities: parseInt(String(oppRow.total || '0')) || 0,
      published_opportunities: parseInt(String(oppRow.published || '0')) || 0,
      draft_opportunities: parseInt(String(oppRow.draft || '0')) || 0,
      closed_opportunities: parseInt(String(oppRow.closed || '0')) || 0,
      total_bookings: parseInt(String(bookingRow.total || '0')) || 0,
      upcoming_bookings: parseInt(String(bookingRow.upcoming || '0')) || 0,
      past_bookings: parseInt(String(bookingRow.past || '0')) || 0,
      total_participants: parseInt(String(participantRow.total || '0')) || 0,
      total_sessions: parseInt(String(sessionRow.total_sessions || '0')) || 0,
      total_slots: totalSlots,
      booked_slots: bookedSlots,
      available_slots: totalSlots - bookedSlots,
      recent_bookings,
    };

    return res.status(200).json({
      success: true,
      data: stats
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

    logger.error('Error fetching dashboard stats', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    const errorMessage = getErrorMessage(error);
    return res.status(500).json(
      createErrorResponse('Failed to fetch dashboard statistics', errorMessage)
    );
  }
}

