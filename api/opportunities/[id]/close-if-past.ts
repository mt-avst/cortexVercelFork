import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../../db';
import { requireAdmin, assertOwnerOrSuperadmin, handleAuthError } from '../../utils/auth';
import { createErrorResponse, createSafeErrorResponse } from '../../utils/errors';
import { logger } from '../../utils/logger';

/**
 * POST /api/opportunities/[id]/close-if-past
 * Utility endpoint: closes the opportunity if it has at least one session
 * and every session under it has already ended (end_time < NOW()) and the
 * opportunity is currently 'published'. No-op otherwise.
 *
 * Requires admin auth (owner or superadmin).
 * Response: { message: 'Opportunity auto-close check completed' }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
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
      const urlMatch = req.url.match(/\/opportunities\/([^/?]+)\/close-if-past/);
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

    // Auto-close the opportunity if all of its sessions are past and it's still published
    // (mirrors autoCloseOpportunityIfNeeded in backend/src/routes/sessions.ts)
    const result = await query(
      `SELECT COUNT(*) as total_sessions,
              COUNT(CASE WHEN end_time < NOW() THEN 1 END) as past_sessions,
              o.status as status
       FROM sessions s
       JOIN opportunities o ON s.opportunity_id = o.id
       WHERE s.opportunity_id = $1
       GROUP BY o.status`,
      [opportunityId]
    );

    if (result.rows.length > 0) {
      const row = result.rows[0] as { total_sessions: string; past_sessions: string; status: string };
      const totalSessions = parseInt(row.total_sessions, 10);
      const pastSessions = parseInt(row.past_sessions, 10);
      if (totalSessions > 0 && pastSessions === totalSessions && row.status === 'published') {
        await query('UPDATE opportunities SET status = $1 WHERE id = $2', ['closed', opportunityId]);
      }
    }

    return res.status(200).json({ message: 'Opportunity auto-close check completed' });
  } catch (error: unknown) {
    logger.error('Error in close-if-past handler', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Internal server error' })
    );
  }
}
