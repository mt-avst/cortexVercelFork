import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../../db';
import { getMonthlyLeaderboard } from '../../../shared/services/gamification';
import { createErrorResponse, createSafeErrorResponse, getErrorMessage } from '../../utils/errors';
import { parseIntSafe } from '../../utils/helpers';
import { logger } from '../../utils/logger';

/**
 * GET /api/gamification/leaderboard/monthly?limit=20
 * Get the monthly leaderboard (top users by monthly AdaptaBits).
 *
 * Query params:
 * - limit?: number (default 20)
 *
 * Response: LeaderboardEntry[] where each item is:
 * { user_id, name, total_points, monthly_points, level, rank }
 *
 * Note: this endpoint returns only real data. It used to pad short lists with
 * fabricated "dummy" leaderboard entries; that behavior has been removed since it
 * could present fake users as real data in production. If there are no real
 * entries, this returns an empty array.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    const limit = parseIntSafe(req.query.limit, 20);
    const pool = getPool();

    const result = await getMonthlyLeaderboard(pool, limit);

    const leaderboard = result.map((row) => ({
      user_id: row.user_id,
      name: row.name,
      total_points: parseIntSafe(row.total_points, 0),
      monthly_points: parseIntSafe(row.monthly_points, 0),
      level: parseIntSafe(row.level, 1),
      rank: parseIntSafe(row.rank, 0),
    }));

    return res.status(200).json(leaderboard);
  } catch (error: unknown) {
    logger.error('Error fetching monthly leaderboard', {
      errorMessage: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Failed to fetch monthly leaderboard' })
    );
  }
}
