import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../../db';
import { createErrorResponse, createSafeErrorResponse } from '../../utils/errors';
import { parseSessionCookie } from '../../utils/auth';
import { isFirstHandConfigured, firstHandPost } from '../../utils/firsthand';
import { logger } from '../../utils/logger';

function getOpportunityId(req: VercelRequest): string | undefined {
  const raw = req.query.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (id) return id;
  const match = req.url?.match(/\/opportunities\/([^/?]+)/);
  return match?.[1];
}

/**
 * POST /api/opportunities/[id]/firsthand-handoff
 * Create a FirstHand session for this opportunity and return the session URL.
 * Auth: any authenticated user.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  const user = parseSessionCookie(req);
  if (!user) {
    return res.status(401).json(createErrorResponse('Authentication required'));
  }

  if (!isFirstHandConfigured()) {
    return res.status(503).json(createErrorResponse('FirstHand integration not configured'));
  }

  const opportunityId = getOpportunityId(req);
  if (!opportunityId) {
    return res.status(400).json(createErrorResponse('Valid opportunity ID is required'));
  }

  try {
    const result = await query(
      'SELECT firsthand_study_id, status FROM opportunities WHERE id = $1',
      [opportunityId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(createErrorResponse('Opportunity not found'));
    }

    const opp = result.rows[0] as { firsthand_study_id: string | null; status: string };

    if (opp.status !== 'published') {
      return res.status(403).json(createErrorResponse('Opportunity is not published'));
    }

    if (!opp.firsthand_study_id) {
      return res.status(400).json(createErrorResponse('Opportunity has no FirstHand study linked'));
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const backendUrl = process.env.BACKEND_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3001');
    const returnUrl = `${frontendUrl}/opportunities/${opportunityId}?completed=1`;
    const callbackUrl = `${backendUrl}/api/firsthand/callbacks`;

    const session = await firstHandPost<{ session_url: string }>('/api/sessions', {
      study_id: opp.firsthand_study_id,
      participant: {
        participant_id: user.id,
        display_name: user.name,
        email: user.email,
        external_ref: opportunityId,
      },
      callback_url: callbackUrl,
      return_url: returnUrl,
    });

    return res.status(200).json({ session_url: session.session_url });
  } catch (err) {
    logger.error('FirstHand handoff failed', {
      opportunityId,
      userId: user.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json(
      createSafeErrorResponse(err, { userMessage: 'Failed to start FirstHand session' })
    );
  }
}
