import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { createErrorResponse, createSafeErrorResponse } from '../utils/errors';
import { parseSessionCookie } from '../utils/auth';
import { logger } from '../utils/logger';

/**
 * GET /api/me/session-events
 * Return the current user's own FirstHand session events joined to opportunity titles.
 * Auth: any authenticated user.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  const user = parseSessionCookie(req);
  if (!user) {
    return res.status(401).json(createErrorResponse('Authentication required'));
  }

  try {
    const result = await query(
      `SELECT
         e.id,
         e.opportunity_id,
         o.title AS opportunity_title,
         e.firsthand_session_id,
         e.event_type,
         e.occurred_at,
         e.received_at
       FROM opportunity_session_events e
       JOIN opportunities o ON e.opportunity_id = o.id
       WHERE e.participant_user_id = $1
       ORDER BY e.occurred_at DESC
       LIMIT 50`,
      [user.id]
    );

    const events = (result.rows as Array<Record<string, unknown>>).map((row) => ({
      id: row.id,
      opportunity_id: row.opportunity_id,
      opportunity_title: row.opportunity_title,
      firsthand_session_id: row.firsthand_session_id,
      event_type: row.event_type,
      occurred_at: row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : row.occurred_at,
      received_at: row.received_at instanceof Date
        ? row.received_at.toISOString()
        : row.received_at,
    }));

    return res.status(200).json(events);
  } catch (err) {
    logger.error('Failed to fetch my session events', {
      userId: user.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json(
      createSafeErrorResponse(err, { userMessage: 'Failed to load session history' })
    );
  }
}
