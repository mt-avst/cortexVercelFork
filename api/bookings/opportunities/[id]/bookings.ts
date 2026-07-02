import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../../../db';
import { requireAdmin, assertOwnerOrSuperadmin, handleAuthError } from '../../../utils/auth';
import { createErrorResponse, createSafeErrorResponse } from '../../../utils/errors';
import { logger } from '../../../utils/logger';

/**
 * GET /api/bookings/opportunities/[id]/bookings
 * Get bookings (with participant details) for an opportunity.
 *
 * Requires admin auth; only the opportunity owner (or a superadmin) may view.
 * Response: bare array of bookings, each the raw `bookings` row plus:
 *   session_start_time, session_end_time (ISO strings),
 *   participant_name, participant_email, business_unit, role_title,
 *   cancelled_at (ISO string or undefined), created_at/updated_at (ISO strings).
 *
 * Note: the Express reference (backend/src/routes/bookings.ts, GET
 * /api/opportunities/:id/bookings) selects `s.start_time, s.end_time`
 * without aliasing them, then its serialization step reads
 * `booking.session_start_time`/`session_end_time` — those are always
 * undefined, so calling `.toISOString()` on them throws and the endpoint
 * always 500s in Express. This port aliases the columns correctly so the
 * endpoint actually returns data. It also uses `assertOwnerOrSuperadmin`
 * (superadmin bypass) rather than Express's owner-only check, for
 * consistency with every other admin endpoint in this codebase.
 */
interface BookingRow {
  session_start_time: Date;
  session_end_time: Date;
  cancelled_at?: Date | null;
  created_at: Date;
  updated_at: Date;
  [key: string]: unknown;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    let user;
    try {
      user = requireAdmin(req);
    } catch (authErr) {
      if (handleAuthError(res, authErr)) return;
      throw authErr;
    }

    // Resolve opportunity ID from query params (Vercel dynamic routes) or URL path
    let opportunityId = req.query.id as string;
    if (!opportunityId && req.url) {
      const urlMatch = req.url.match(/\/opportunities\/([^/?]+)\/bookings/);
      if (urlMatch) {
        opportunityId = urlMatch[1];
      }
    }

    if (!opportunityId) {
      return res.status(400).json(createErrorResponse('Opportunity ID is required'));
    }

    const opportunityCheck = await query(
      'SELECT owner_user_id FROM opportunities WHERE id = $1',
      [opportunityId]
    );

    if (opportunityCheck.rows.length === 0) {
      return res.status(404).json(createErrorResponse('Opportunity not found'));
    }

    try {
      const ownerId = (opportunityCheck.rows[0] as { owner_user_id: string }).owner_user_id;
      assertOwnerOrSuperadmin(user, ownerId);
    } catch (authErr) {
      if (handleAuthError(res, authErr)) return;
      throw authErr;
    }

    const result = await query(
      `SELECT b.*, s.start_time as session_start_time, s.end_time as session_end_time,
              u.name as participant_name, u.email as participant_email,
              u.business_unit, u.role_title
       FROM bookings b
       JOIN sessions s ON b.session_id = s.id
       JOIN users u ON b.user_id = u.id
       WHERE s.opportunity_id = $1
       ORDER BY s.start_time ASC, u.name ASC`,
      [opportunityId]
    );

    const bookings = (result.rows as BookingRow[]).map((booking) => ({
      ...booking,
      session_start_time: new Date(booking.session_start_time).toISOString(),
      session_end_time: new Date(booking.session_end_time).toISOString(),
      cancelled_at: booking.cancelled_at ? new Date(booking.cancelled_at).toISOString() : undefined,
      created_at: new Date(booking.created_at).toISOString(),
      updated_at: new Date(booking.updated_at).toISOString(),
    }));

    return res.status(200).json(bookings);
  } catch (error: unknown) {
    logger.error('Error fetching opportunity bookings', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Failed to fetch opportunity bookings' })
    );
  }
}
