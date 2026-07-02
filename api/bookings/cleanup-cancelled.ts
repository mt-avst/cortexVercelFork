import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { requireAuth, handleAuthError } from '../utils/auth';
import { createErrorResponse, createSafeErrorResponse } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * POST /api/bookings/cleanup-cancelled
 *
 * Debug/maintenance endpoint: lists the authenticated caller's own cancelled
 * bookings. Requires authentication only (not admin) — mirrors
 * backend/src/routes/bookings.ts, which also does NOT delete anything (the
 * delete statement there is commented out); this is a reporting endpoint,
 * not a destructive purge.
 *
 * Response: { message: string; cancelled_bookings: Array<{
 *   id: string; session_id: string; opportunity_title: string;
 *   cancelled_at?: string; created_at: string;
 * }> }
 */
interface CancelledBookingRow {
  id: string;
  session_id: string;
  opportunity_title: string;
  cancelled_at?: Date | null;
  created_at: Date;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    let user;
    try {
      user = requireAuth(req);
    } catch (authErr) {
      if (handleAuthError(res, authErr)) return;
      throw authErr;
    }

    const result = await query(
      `SELECT b.id, b.session_id, b.cancelled_at, b.created_at, o.title as opportunity_title
       FROM bookings b
       JOIN sessions s ON b.session_id = s.id
       JOIN opportunities o ON s.opportunity_id = o.id
       WHERE b.user_id = $1 AND b.status = 'cancelled'`,
      [user.id]
    );

    const cancelledBookings = (result.rows as CancelledBookingRow[]).map((booking) => ({
      id: booking.id,
      session_id: booking.session_id,
      opportunity_title: booking.opportunity_title,
      cancelled_at: booking.cancelled_at ? new Date(booking.cancelled_at).toISOString() : undefined,
      created_at: new Date(booking.created_at).toISOString(),
    }));

    return res.status(200).json({
      message: `Found ${cancelledBookings.length} cancelled bookings`,
      cancelled_bookings: cancelledBookings,
    });
  } catch (error: unknown) {
    logger.error('Error cleaning up cancelled bookings', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Failed to clean up cancelled bookings' })
    );
  }
}
