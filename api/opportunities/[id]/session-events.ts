import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../../db';
import { createErrorResponse, createSafeErrorResponse } from '../../utils/errors';
import { parseSessionCookie } from '../../utils/auth';
import { logger } from '../../utils/logger';

function getOpportunityId(req: VercelRequest): string | undefined {
  const raw = req.query.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (id) return id;
  const match = req.url?.match(/\/opportunities\/([^/?]+)/);
  return match?.[1];
}

/**
 * GET /api/opportunities/[id]/session-events
 * List FirstHand session events for an opportunity.
 * Auth: authenticated users (admin only).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  const user = parseSessionCookie(req);
  if (!user) {
    return res.status(401).json(createErrorResponse('Authentication required'));
  }
  if (user.role !== 'researcher_admin' && user.role !== 'superadmin') {
    return res.status(403).json(createErrorResponse('Admin access required'));
  }

  const opportunityId = getOpportunityId(req);
  if (!opportunityId) {
    return res.status(400).json(createErrorResponse('Valid opportunity ID is required'));
  }

  const firsthandBaseUrl = process.env.FIRSTHAND_BASE_URL?.trim() || '';

  try {
    const result = await query(
      `SELECT
         e.id,
         e.opportunity_id,
         e.participant_user_id,
         e.firsthand_session_id,
         e.event_type,
         e.occurred_at,
         e.received_at,
         u.name  AS participant_name,
         u.email AS participant_email
       FROM opportunity_session_events e
       LEFT JOIN users u ON u.id = e.participant_user_id
       WHERE e.opportunity_id = $1
       ORDER BY e.occurred_at DESC`,
      [opportunityId]
    );

    const events = (result.rows as Array<Record<string, unknown>>).map((row) => ({
      id: row.id,
      opportunity_id: row.opportunity_id,
      participant_user_id: row.participant_user_id,
      firsthand_session_id: row.firsthand_session_id,
      event_type: row.event_type,
      occurred_at: row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : row.occurred_at,
      received_at: row.received_at instanceof Date
        ? row.received_at.toISOString()
        : row.received_at,
      participant_name: row.participant_name ?? null,
      participant_email: row.participant_email ?? null,
      firsthand_review_url: firsthandBaseUrl
        ? `${firsthandBaseUrl}/review/session/${row.firsthand_session_id}`
        : null,
    }));

    return res.status(200).json(events);
  } catch (err) {
    logger.error('Failed to fetch session events', {
      opportunityId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json(
      createSafeErrorResponse(err, { userMessage: 'Failed to load session events' })
    );
  }
}
