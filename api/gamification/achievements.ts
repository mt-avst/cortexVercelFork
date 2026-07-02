import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';
import { getUserAchievements } from '../../shared/services/gamification';
import { handleAuthError, requireAuth } from '../utils/auth';
import { createErrorResponse, createSafeErrorResponse } from '../utils/errors';
import { serializeDate } from '../utils/helpers';
import { logger } from '../utils/logger';

/**
 * GET /api/gamification/achievements
 * Get the authenticated user's earned AdaptaBits achievements.
 *
 * Response: UserAchievement[] where each item is:
 * {
 *   id: string;
 *   user_id: string;
 *   achievement_id: string;
 *   earned_at: string (ISO date);
 *   achievement: {
 *     id, name, description, icon, points_required, category, badge_color,
 *     created_at (ISO date)
 *   }
 * }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    const user = requireAuth(req);
    const pool = getPool();

    const achievements = await getUserAchievements(pool, user.id);

    const response = achievements.map((ua) => ({
      ...ua,
      earned_at: serializeDate(ua.earned_at),
      achievement: {
        ...ua.achievement,
        created_at: serializeDate(ua.achievement.created_at),
      },
    }));

    return res.status(200).json(response);
  } catch (error: unknown) {
    if (handleAuthError(res, error)) return;

    logger.error('Error fetching user achievements', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Failed to fetch achievements' })
    );
  }
}
