import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';
import { handleAuthError, requireAdmin } from '../utils/auth';
import { createErrorResponse, createSafeErrorResponse, getErrorMessage } from '../utils/errors';
import { serializeRow } from '../utils/helpers';
import { logger } from '../utils/logger';

/**
 * GET /api/bookings/pending-approvals
 * Get sessions with a completed (but not yet approved/rejected) booking, for admin review.
 *
 * Requires researcher_admin or superadmin (any admin may view/approve any opportunity's
 * pending approvals — this mirrors the Express reference, which does not restrict to the
 * opportunity owner here, unlike some other admin booking endpoints).
 *
 * Response: bare array, each item:
 * {
 *   booking_id: string;
 *   user_id: string;
 *   session_id: string;
 *   completed_at: string (ISO date);
 *   admin_notes: string | null;
 *   user_name: string;
 *   user_email: string;
 *   start_time: string (ISO date);
 *   end_time: string (ISO date);
 *   opportunity_title: string;
 *   opportunity_type: string;
 *   owner_user_id: string;
 * }
 *
 * Mirrors backend/src/routes/bookings.ts GET /api/bookings/pending-approvals
 * (WHERE b.completion_status = 'completed', ORDER BY b.completed_at ASC).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    try {
      requireAdmin(req);
    } catch (authErr) {
      if (handleAuthError(res, authErr)) return;
      throw authErr;
    }

    const pool = getPool();

    const result = await pool.query(`
      SELECT
        b.id as booking_id,
        b.user_id,
        b.session_id,
        b.completed_at,
        b.admin_notes,
        u.name as user_name,
        u.email as user_email,
        s.start_time,
        s.end_time,
        o.title as opportunity_title,
        o.type as opportunity_type,
        o.owner_user_id
      FROM bookings b
      JOIN users u ON b.user_id = u.id
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      WHERE b.completion_status = 'completed'
      ORDER BY b.completed_at ASC
    `);

    const response = result.rows.map((row: Record<string, unknown>) =>
      serializeRow(row, ['completed_at', 'start_time', 'end_time'])
    );

    return res.status(200).json(response);
  } catch (error: unknown) {
    logger.error('Error fetching pending approvals', {
      errorMessage: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Failed to fetch pending approvals' })
    );
  }
}
