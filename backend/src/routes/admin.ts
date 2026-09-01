import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin, requireSuperadmin, withLiveRole } from '../middleware/authenticate';
import { isAdminRole } from '../types';
import { getAppliedDbTlsModes } from '../config/dbTls';
import { pool } from '../config/index';
import { asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
// cto/AdaptaLabs#65. The route-local `escapeCsvField` this replaces quoted but
// did NOT neutralise spreadsheet formulas, while the survey export next door
// already did - so the shared helper is imported rather than a third private
// copy kept. See utils/csv-cell.ts for why that mattered here specifically.
import { csvCell } from '../utils/csv-cell';
import { streamCsvExport } from '../utils/csv-stream';
import {
  validateQuery,
  adminRequestsQuerySchema,
  adminRevokeAdminQuerySchema,
} from '../validation/schemas';

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

/**
 * GET /api/admin/dashboard - dashboard statistics, scoped to what the caller
 * may see (M7: recent_bookings, superadmin global stats).
 *
 * `withLiveRole`, NOT `requireAdmin`, and not bare `requireAuth` (#38).
 *
 * Not `requireAdmin`, because this is the "am I an admin" surface every
 * signed-in user loads: the 403 below is part of the contract and the gate has
 * to stay in the handler.
 *
 * Not bare `requireAuth`, because that hands the handler the role stamped into
 * the session at LOGIN and this handler makes THREE decisions from it. The gate
 * is the least of them. A superadmin demoted to researcher_admin is still an
 * admin, so the gate admits them - correctly - and the two scope constants below
 * then read a stale `superadmin` and resolve to `null`, which is no filter at
 * all. They kept receiving global counts and every other researcher's
 * participant names and emails for up to SESSION_MAX_AGE_MS (24h). No gate could
 * catch that, which is why the fix is the role read rather than another gate.
 */
router.get('/dashboard', requireAuth, withLiveRole, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;

  // Check admin role - live as of this request, courtesy of `withLiveRole`.
  if (!isAdminRole(user.role)) {
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

/**
 * GET /api/admin/export/bookings - the bookings CSV, STREAMED. #65.
 *
 * Was an unbounded four-table join mapped into an array of strings, joined and
 * `res.send` in one go - peak memory the whole pg result set plus the whole
 * CSV, per concurrent caller. #65 measured the QUERY at 472ms over 200,000
 * rows, so the statement timeout was never the ceiling; the materialisation
 * was. Now it walks the same ordering in batches and writes each to the socket.
 *
 * THE CURSOR IS AN OBJECT, NOT A WIRE FORMAT - it lives for one response and
 * nobody outside this handler ever sees it, so there is no parser to keep in
 * step and no `?before=` contract. What that does NOT buy, and a first version
 * of this comment wrongly claimed it did, is freedom from rendering: the
 * timestamps are carried as Postgres's own `::text` rendering and bound back
 * with `::timestamptz`, NOT as the JS Dates node-pg parses. A JS Date holds
 * MILLISECONDS and a TIMESTAMPTZ holds MICROSECONDS, so round-tripping the
 * parsed Date truncates the cursor below every µs-bearing row and the next
 * batch's predicate matches nothing - the walk ends after one batch, which is
 * the silent truncation this whole change exists to prevent. Caught by
 * csv-exports-keyset-postgres.test.ts on its FIRST CI run (500 rows of a
 * seeded 600), before any release carried it. `::text` keeps the full
 * precision and the offset, so it casts back to the same instant regardless
 * of session TimeZone. Same µs-vs-ms trap as the F1 optimistic-concurrency
 * precondition.
 *
 * `b.id` IS IN THE KEY AND IS NOT A FORMALITY. The original ordering was
 * `s.start_time DESC, b.created_at DESC`, and NEITHER is unique - two people
 * booking the same session in the same request share both to the microsecond.
 * A batch boundary landing between two such rows drops one for ever under that
 * key alone, and nothing anywhere reports it. The uuid makes the key unique,
 * so the comparison below addresses exactly one position.
 */
router.get('/export/bookings', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;

  // The SECOND of the two declarations in this file, in a separate handler,
  // and it is named for what it protects rather than for what it filters:
  // every row of this CSV carries a participant's name and email. Fixing "the"
  // owner filter in admin.ts audits half of it - which is why neither is
  // called `filterOwnerId` any more.
  const participantIdentityOwnerId = user.role === 'superadmin' ? null : user.id;

  const headers = [
    'Opportunity', 'Type', 'Session start', 'Session end',
    'Participant name', 'Participant email', 'Status', 'Booked at',
  ];

  // Strings, not Dates - see the µs-vs-ms note in the docblock above.
  type BookingsCursor = { startTime: string; createdAt: string; id: string };

  await streamCsvExport<BookingsCursor>({
    res,
    filename: `bookings-export-${new Date().toISOString().split('T')[0]}.csv`,
    headerRow: headers.join(','),
    context: { route: 'GET /api/admin/export/bookings', userId: user.id },
    readBatch: async (cursor, limit) => {
      // ONE STATEMENT FOR THE FIRST BATCH AND EVERY LATER ONE. The
      // `$2::timestamptz IS NULL OR ...` keeps them on the same SQL, so a
      // change to the ordering, the owner scope or the projection cannot reach
      // one and miss the other. A row comparison against NULL is NULL and
      // `TRUE OR NULL` is TRUE, so the first batch is unaffected whatever
      // Postgres decides about evaluation order.
      //
      // The ORDER BY matches the comparison exactly, column for column and
      // direction for direction. An order that disagrees with its keyset
      // predicate is not pagination, it is a lottery.
      const result = await pool.query(
        `SELECT
          o.title AS opportunity_title,
          o.type AS opportunity_type,
          s.start_time AS session_start,
          s.end_time AS session_end,
          u.name AS participant_name,
          u.email AS participant_email,
          b.status AS booking_status,
          b.created_at AS booked_at,
          b.id AS booking_id,
          s.start_time::text AS cursor_start_time,
          b.created_at::text AS cursor_created_at
         FROM bookings b
         JOIN sessions s ON b.session_id = s.id
         JOIN opportunities o ON s.opportunity_id = o.id
         JOIN users u ON b.user_id = u.id
         WHERE ($1::uuid IS NULL OR o.owner_user_id = $1)
           AND ($2::timestamptz IS NULL
                OR (s.start_time, b.created_at, b.id) < ($2::timestamptz, $3::timestamptz, $4::uuid))
         ORDER BY s.start_time DESC, b.created_at DESC, b.id DESC
         LIMIT $5`,
        [
          participantIdentityOwnerId,
          cursor?.startTime ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          limit
        ]
      );

      const rows = (result.rows || []).map((row: Record<string, unknown>) => [
        // `true` on the four cells a person wrote. An opportunity title is
        // researcher-authored and a participant name comes from the identity
        // provider; both reach a spreadsheet opened by an admin.
        csvCell(String(row.opportunity_title ?? ''), true),
        // The type is one of a fixed set we define, so it is left numeric-safe
        // and unprefixed - as are the two timestamps and the status.
        csvCell(String(row.opportunity_type ?? ''), false),
        csvCell(row.session_start ? new Date(row.session_start as Date).toISOString() : '', false),
        csvCell(row.session_end ? new Date(row.session_end as Date).toISOString() : '', false),
        csvCell(String(row.participant_name ?? ''), true),
        csvCell(String(row.participant_email ?? ''), true),
        csvCell(String(row.booking_status ?? ''), false),
        csvCell(row.booked_at ? new Date(row.booked_at as Date).toISOString() : '', false),
      ].join(','));

      const last = result.rows[result.rows.length - 1];

      return {
        rows,
        // A SHORT BATCH IS THE END, and saying so here rather than letting the
        // writer infer it means a batch landing exactly on the boundary costs
        // one more query and not a wrong answer.
        nextCursor:
          result.rows.length === limit && last
            ? {
                startTime: String(last.cursor_start_time),
                createdAt: String(last.cursor_created_at),
                id: String(last.booking_id)
              }
            : undefined
      };
    }
  });
}));

// ============================================================================
// ADMIN MANAGEMENT ROUTES (Superadmin only)
// ============================================================================

/**
 * POST /api/admin/request - Request admin access (any authenticated user).
 *
 * `withLiveRole` for the same reason as the dashboard (#38), in its milder
 * form: read off the session, the check below told a REVOKED admin that they
 * already had admin access and refused to let them ask for it back - for up to
 * SESSION_MAX_AGE_MS. No escalation, but a user-visible dead end, and the same
 * stale read.
 */
router.post('/request', requireAuth, withLiveRole, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;

  // Check if user already has admin or superadmin role - live, not as of login.
  if (isAdminRole(user.role)) {
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
//
// `validateQuery` (#43): an array-valued `status` walked past the typeof
// check below and SILENTLY DROPPED the WHERE filter. Superadmin-only and the
// filter is cosmetic, so no scope widening - but a behaviour nobody chose.
router.get('/requests', requireSuperadmin, validateQuery(adminRequestsQuerySchema), asyncHandler(async (req: Request, res: Response) => {
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
//
// `validateQuery` (#43): `?id=a&id=b` sent a string array into the uuid
// parameter below, a 500. The cast on the next line is true only because the
// validator has already run.
router.delete('/admins', requireSuperadmin, validateQuery(adminRevokeAdminQuerySchema), asyncHandler(async (req: Request, res: Response) => {
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
  
  // Prevent revoking superadmin access.
  //
  // DELIBERATE, RECORDED DECISION (#14): superadmin revocation is kept
  // out-of-band. A superadmin can revoke another superadmin here only via a
  // direct DB change, which forces a second, audited channel for the highest
  // privilege and removes the "revoke the last superadmin, or yourself, over
  // the API" foot-gun entirely. The in-API path stays restricted to
  // researcher_admin. If a guarded in-API superadmin revocation is ever wanted
  // (cannot-be-last, cannot-be-self), it belongs behind those explicit guards -
  // not by loosening this refusal.
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
  
  // Now truthful (#14): the DB role is the source of truth and requireAdmin
  // re-reads it per request, so the revoked admin is locked out on their very
  // next call rather than after up to SESSION_MAX_AGE_MS.
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

