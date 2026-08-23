import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin, requireSuperadmin } from '../middleware/authenticate';
import { getAppliedDbTlsModes } from '../config/dbTls';
import { pool } from '../config/index';
import { asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';

function escapeCsvField(field: string | null | undefined): string {
  if (field === null || field === undefined) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('\n') || str.includes('"')) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

const router: Router = Router();

interface RecentBookingItem {
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
  sessions_completed: number;
  total_slots: number;
  booked_slots: number;
  available_slots: number;
  recent_bookings: RecentBookingItem[];
}

// GET /api/admin/dashboard - Get dashboard statistics (M7: recent_bookings, superadmin global stats)
router.get('/dashboard', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;

  // Check admin role
  if (user.role !== 'researcher_admin' && user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }

  const userId = user.id;

  // TWO SCOPES, NOT ONE, AND THEY ARE DELIBERATELY NOT THE SAME CONSTANT.
  //
  // Superadmin sees global stats; researcher_admin sees only their own
  // opportunities. Both start from that same rule - and one `filterOwnerId`
  // governing all five queries here is how widening it becomes a one-word
  // edit. The first four return COUNTS, which read as presentational; the
  // fifth returns participant NAMES and EMAILS. A reviewer persuaded that the
  // counts could be global has, with the same edit, published every other
  // researcher's participants.
  //
  // Split so that edit cannot be made once. Each is pinned by its own named
  // test, and the participant one by a test that fails if the predicate stops
  // reaching the SQL at all. cto/AdaptaLabs#21, #16.
  const countsOwnerId = user.role === 'superadmin' ? null : userId;
  const participantIdentityOwnerId = user.role === 'superadmin' ? null : userId;

  // Get opportunity counts (filter by owner unless superadmin)
  const oppCounts = await pool.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'published') as published,
      COUNT(*) FILTER (WHERE status = 'draft') as draft,
      COUNT(*) FILTER (WHERE status = 'closed') as closed
    FROM opportunities
    WHERE ($1::uuid IS NULL OR owner_user_id = $1)
  `, [countsOwnerId]);

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
  `, [now, countsOwnerId]);

  // Get unique participants count
  const participantsCount = await pool.query(`
    SELECT COUNT(DISTINCT b.user_id) as total
    FROM bookings b
    JOIN sessions s ON b.session_id = s.id
    JOIN opportunities o ON s.opportunity_id = o.id
    WHERE ($1::uuid IS NULL OR o.owner_user_id = $1) AND b.status = 'booked'
  `, [countsOwnerId]);

  // Get session and slot statistics
  const sessionStats = await pool.query(`
    SELECT 
      COUNT(DISTINCT s.id) as total_sessions,
      COUNT(DISTINCT s.id) FILTER (WHERE s.start_time <= $2) as sessions_completed,
      SUM(s.capacity) as total_slots,
      SUM(s.booked_count) as booked_slots
    FROM sessions s
    JOIN opportunities o ON s.opportunity_id = o.id
    WHERE ($1::uuid IS NULL OR o.owner_user_id = $1)
  `, [countsOwnerId, now]);

  // M7: Recent bookings list (with session times) — bookings table uses created_at, not booked_at
  const recentBookingsResult = await pool.query(`
    SELECT b.id, o.id as opportunity_id, o.title as opportunity_title,
           s.start_time as session_start, u.name as participant_name, u.email as participant_email,
           b.status, b.created_at as booked_at
    FROM bookings b
    JOIN sessions s ON b.session_id = s.id
    JOIN opportunities o ON s.opportunity_id = o.id
    JOIN users u ON b.user_id = u.id
    WHERE ($1::uuid IS NULL OR o.owner_user_id = $1)
    ORDER BY b.created_at DESC
    LIMIT 15
  `, [participantIdentityOwnerId]);

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
    sessions_completed: parseInt(String(sessionRow.sessions_completed || '0')) || 0,
    total_slots: totalSlots,
    booked_slots: bookedSlots,
    available_slots: totalSlots - bookedSlots,
    recent_bookings,
  };

  return res.status(200).json({
    success: true,
    data: stats
  });
}));

// GET /api/admin/export/bookings - Export bookings as CSV (admin only; researcher_admin sees own only)
router.get('/export/bookings', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;

  // The SECOND of the two declarations in this file, in a separate handler,
  // and it is named for what it protects rather than for what it filters:
  // every row of this CSV carries a participant's name and email. Fixing "the"
  // owner filter in admin.ts audits half of it - which is why neither is
  // called `filterOwnerId` any more.
  const participantIdentityOwnerId = user.role === 'superadmin' ? null : user.id;

  const result = await pool.query(
    `SELECT
      o.title AS opportunity_title,
      o.type AS opportunity_type,
      s.start_time AS session_start,
      s.end_time AS session_end,
      u.name AS participant_name,
      u.email AS participant_email,
      b.status AS booking_status,
      b.created_at AS booked_at
     FROM bookings b
     JOIN sessions s ON b.session_id = s.id
     JOIN opportunities o ON s.opportunity_id = o.id
     JOIN users u ON b.user_id = u.id
     WHERE ($1::uuid IS NULL OR o.owner_user_id = $1)
     ORDER BY s.start_time DESC, b.created_at DESC`,
    [participantIdentityOwnerId]
  );

  const headers = [
    'Opportunity', 'Type', 'Session start', 'Session end',
    'Participant name', 'Participant email', 'Status', 'Booked at',
  ];
  const rows = (result.rows || []).map((row: Record<string, unknown>) => [
    escapeCsvField(String(row.opportunity_title ?? '')),
    escapeCsvField(String(row.opportunity_type ?? '')),
    row.session_start ? new Date(row.session_start as Date).toISOString() : '',
    row.session_end ? new Date(row.session_end as Date).toISOString() : '',
    escapeCsvField(String(row.participant_name ?? '')),
    escapeCsvField(String(row.participant_email ?? '')),
    escapeCsvField(String(row.booking_status ?? '')),
    row.booked_at ? new Date(row.booked_at as Date).toISOString() : '',
  ]);

  const csvContent = [headers.join(','), ...rows.map((r: string[]) => r.join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="bookings-export-${new Date().toISOString().split('T')[0]}.csv"`);
  res.send(csvContent);
}));

// ============================================================================
// ADMIN MANAGEMENT ROUTES (Superadmin only)
// ============================================================================

// POST /api/admin/request - Request admin access (any authenticated user)
router.post('/request', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  
  // Check if user already has admin or superadmin role
  if (user.role === 'researcher_admin' || user.role === 'superadmin') {
    return res.status(400).json({ error: 'You already have admin access' });
  }
  
  // Check if there's already a pending request
  const existingRequest = await pool.query(
    'SELECT id, status FROM admin_requests WHERE user_id = $1 AND status = $2',
    [user.id, 'pending']
  );
  
  if (existingRequest.rows.length > 0) {
    return res.status(400).json({ error: 'You already have a pending admin request' });
  }
  
  // Create new admin request
  const result = await pool.query(
    `INSERT INTO admin_requests (user_id, requested_role, status)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, requested_at, requested_role, status, created_at, updated_at`,
    [user.id, 'researcher_admin', 'pending']
  );
  
  logger.info('Admin access requested', { userId: user.id, email: user.email });
  
  return res.status(201).json({
    success: true,
    request: result.rows[0],
    message: 'Admin access request submitted successfully'
  });
}));

// GET /api/admin/requests - Get all admin requests (superadmin only)
router.get('/requests', requireSuperadmin, asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.query;
  
  let query = `
    SELECT 
      ar.id, ar.user_id, ar.requested_at, ar.requested_role, ar.status, 
      ar.reviewed_by, ar.reviewed_at, ar.notes, ar.created_at, ar.updated_at,
      u.email, u.name, u.role as current_role
    FROM admin_requests ar
    JOIN users u ON ar.user_id = u.id
  `;
  const params: string[] = [];
  
  if (status && typeof status === 'string') {
    query += ' WHERE ar.status = $1';
    params.push(status);
  }
  
  query += ' ORDER BY ar.requested_at DESC';
  
  const result = await pool.query(query, params);
  
  return res.status(200).json({
    success: true,
    requests: result.rows
  });
}));

// POST /api/admin/requests/:id/approve - Approve admin request (superadmin only)
router.post('/requests/:id/approve', requireSuperadmin, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const superadminId = req.user!.id;
  
  // Get the request
  const requestResult = await pool.query(
    'SELECT * FROM admin_requests WHERE id = $1',
    [id]
  );
  
  if (requestResult.rows.length === 0) {
    return res.status(404).json({ error: 'Admin request not found' });
  }
  
  const request = requestResult.rows[0];
  
  if (request.status !== 'pending') {
    return res.status(400).json({ error: 'This request has already been processed' });
  }
  
  // Start transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Update the request status
    await client.query(
      `UPDATE admin_requests 
       SET status = $1, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      ['approved', superadminId, id]
    );
    
    // Update the user's role
    await client.query(
      'UPDATE users SET role = $1 WHERE id = $2',
      [request.requested_role, request.user_id]
    );
    
    await client.query('COMMIT');
    
    logger.info('Admin request approved', { 
      requestId: id, 
      userId: request.user_id, 
      approvedBy: superadminId,
      newRole: request.requested_role
    });
    
    return res.status(200).json({
      success: true,
      message: 'Admin request approved successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

// POST /api/admin/requests/:id/deny - Deny admin request (superadmin only)
router.post('/requests/:id/deny', requireSuperadmin, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { notes } = req.body;
  const superadminId = req.user!.id;
  
  // Get the request
  const requestResult = await pool.query(
    'SELECT * FROM admin_requests WHERE id = $1',
    [id]
  );
  
  if (requestResult.rows.length === 0) {
    return res.status(404).json({ error: 'Admin request not found' });
  }
  
  const request = requestResult.rows[0];
  
  if (request.status !== 'pending') {
    return res.status(400).json({ error: 'This request has already been processed' });
  }
  
  // Update the request status
  await pool.query(
    `UPDATE admin_requests 
     SET status = $1, reviewed_by = $2, reviewed_at = NOW(), notes = $3, updated_at = NOW()
     WHERE id = $4`,
    ['denied', superadminId, notes || null, id]
  );
  
  logger.info('Admin request denied', { 
    requestId: id, 
    userId: request.user_id, 
    deniedBy: superadminId 
  });
  
  return res.status(200).json({
    success: true,
    message: 'Admin request denied'
  });
}));

// GET /api/admin/admins - Get all admins (superadmin only)
router.get('/admins', requireSuperadmin, asyncHandler(async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT id, name, email, business_unit, role_title, role, created_at
     FROM users 
     WHERE role IN ('researcher_admin', 'superadmin')
     ORDER BY 
       CASE role 
         WHEN 'superadmin' THEN 1 
         WHEN 'researcher_admin' THEN 2 
       END,
       created_at DESC`
  );
  
  return res.status(200).json({
    success: true,
    admins: result.rows
  });
}));

// DELETE /api/admin/admins - Revoke admin access (superadmin only)
router.delete('/admins', requireSuperadmin, asyncHandler(async (req: Request, res: Response) => {
  const adminId = req.query.id as string;
  const superadminId = req.user!.id;
  
  if (!adminId) {
    return res.status(400).json({ error: 'Admin ID is required' });
  }
  
  // Check if the target user exists and is an admin
  const userResult = await pool.query(
    'SELECT id, email, role FROM users WHERE id = $1',
    [adminId]
  );
  
  if (userResult.rows.length === 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const targetUser = userResult.rows[0];
  
  // Prevent revoking superadmin access
  if (targetUser.role === 'superadmin') {
    return res.status(403).json({ error: 'Cannot revoke superadmin access' });
  }
  
  // Prevent self-revocation
  if (targetUser.id === superadminId) {
    return res.status(403).json({ error: 'Cannot revoke your own admin access' });
  }
  
  if (targetUser.role !== 'researcher_admin') {
    return res.status(400).json({ error: 'User does not have admin access' });
  }
  
  // Revoke admin access
  await pool.query(
    'UPDATE users SET role = $1 WHERE id = $2',
    ['employee', adminId]
  );
  
  logger.info('Admin access revoked', { 
    adminId, 
    email: targetUser.email, 
    revokedBy: superadminId 
  });
  
  return res.status(200).json({
    success: true,
    message: 'Admin access revoked successfully'
  });
}));

/**
 * GET /api/admin/diagnostics/db-tls - is the database link actually verified?
 *
 * `DB_TLS_VERIFY` went live in 7.36.3, and until now the only evidence that it
 * was doing anything was a line on the pod's stdout. That made the check
 * impossible for anyone without cluster access - and a flag that shipped inert
 * would have looked exactly like one that worked. This reports what each pool
 * actually resolved, so the question can be answered from a browser.
 *
 * SUPERADMIN ONLY, and not on /api/health. Whether a database link verifies its
 * certificate is a security posture detail: on an unauthenticated endpoint it
 * would tell a stranger that a man-in-the-middle on that link is worth
 * attempting. The people who need the answer are the ones who can already read
 * the configuration.
 *
 * Modes only. `description` carries the database host and the CA bundle path,
 * and neither is needed to answer the question.
 */
router.get('/diagnostics/db-tls', requireSuperadmin, asyncHandler(async (_req: Request, res: Response) => {
  const pools = getAppliedDbTlsModes();

  return res.json({
    pools,
    // Over the pools that have RESOLVED, which is not necessarily all of them.
    allVerified: Object.keys(pools).length > 0 && Object.values(pools).every((mode) => mode === 'verified'),
    // Spelled out in the response, not only in a comment: the FirstHand runtime
    // pool is built lazily, so it is absent from this list until something has
    // used it. A short list is an incomplete answer, not a clean one, and a
    // human reading this JSON in a browser has no other way to know that.
    //
    // "resolved", NOT "connected". applyDbTls records the mode when the pool's
    // config is built - for `backend` that is at module load, before the Pool
    // exists and long before it has spoken to the database. Saying "connected"
    // invited the one wrong inference this endpoint can cause: that `verified`
    // is proof of a completed handshake. It is proof of what was APPLIED. The
    // handshake is proved by a query succeeding on the same pool, which is what
    // /api/health does - see PRODUCTION_HARDENING.md.
    note: 'A pool appears once its TLS configuration has resolved, which happens when the pool is built - not when it first connects. The mode is what was applied to the pool, not proof of a completed handshake. A pool missing here has not been built yet, which is not the same as unverified.'
  });
}));

export default router;

