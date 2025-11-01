import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/authenticate';
import { pool } from '../config/index';
import { asyncHandler } from '../utils/errorHandler';

const router: Router = Router();

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
}

// GET /api/admin/dashboard - Get dashboard statistics
router.get('/dashboard', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  
  // Check admin role
  if (user.role !== 'researcher_admin') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }

  const userId = user.id;
  
  // Get opportunity counts
  const oppCounts = await pool.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'published') as published,
      COUNT(*) FILTER (WHERE status = 'draft') as draft,
      COUNT(*) FILTER (WHERE status = 'closed') as closed
    FROM opportunities
    WHERE owner_user_id = $1
  `, [userId]);

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
    WHERE o.owner_user_id = $2
  `, [now, userId]);

  // Get unique participants count
  const participantsCount = await pool.query(`
    SELECT COUNT(DISTINCT b.user_id) as total
    FROM bookings b
    JOIN sessions s ON b.session_id = s.id
    JOIN opportunities o ON s.opportunity_id = o.id
    WHERE o.owner_user_id = $1 AND b.status = 'booked'
  `, [userId]);

  // Get session and slot statistics
  const sessionStats = await pool.query(`
    SELECT 
      COUNT(DISTINCT s.id) as total_sessions,
      SUM(s.capacity) as total_slots,
      SUM(s.booked_count) as booked_slots
    FROM sessions s
    JOIN opportunities o ON s.opportunity_id = o.id
    WHERE o.owner_user_id = $1
  `, [userId]);

  const oppRow = oppCounts.rows[0] || {};
  const bookingRow = bookingCounts.rows[0] || {};
  const participantRow = participantsCount.rows[0] || {};
  const sessionRow = sessionStats.rows[0] || {};

  const totalSlots = parseInt(String(sessionRow.total_slots || '0')) || 0;
  const bookedSlots = parseInt(String(sessionRow.booked_slots || '0')) || 0;

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
    available_slots: totalSlots - bookedSlots
  };

  return res.status(200).json({
    success: true,
    data: stats
  });
}));

export default router;

