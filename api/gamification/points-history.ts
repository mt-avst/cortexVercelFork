import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';
import { getPointsHistory } from '../../shared/services/gamification';
import { handleAuthError, requireAuth } from '../utils/auth';
import { createErrorResponse, createSafeErrorResponse } from '../utils/errors';
import { parseIntSafe, serializeRow } from '../utils/helpers';
import { logger } from '../utils/logger';

/**
 * GET /api/gamification/points-history?limit=20
 * Get the authenticated user's AdaptaBits transaction history.
 *
 * Query params:
 * - limit?: number (default 20) - max transactions to return, most recent first
 *
 * Response: PointsTransaction[] where each item is:
 * {
 *   id: string;
 *   user_id: string;
 *   points: number;
 *   reason: string;
 *   opportunity_id: string | null;
 *   session_id: string | null;
 *   created_at: string (ISO date);
 * }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    const user = requireAuth(req);
    const pool = getPool();
    const limit = parseIntSafe(req.query.limit, 20);

    const history = await getPointsHistory(pool, user.id, limit);

    const response = history.map((row) => serializeRow(row, ['created_at']));

    return res.status(200).json(response);
  } catch (error: unknown) {
    if (handleAuthError(res, error)) return;

    logger.error('Error fetching points history', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Failed to fetch points history' })
    );
  }
}
