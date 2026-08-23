import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/authenticate';
import { logger } from '../utils/logger';
import { 
  getUserProfile, 
  getUserAchievements, 
  getLeaderboard, 
  getMonthlyLeaderboard, 
  getPointsHistory,
  UserProfile,
  UserAchievement,
  LeaderboardEntry,
  PointsTransaction
} from '../services/gamification';

const router: Router = Router();

/**
 * THE CEILING ON A LEADERBOARD PAGE, and it is a literal on purpose.
 *
 * Both leaderboard routes are UNAUTHENTICATED - no `requireAuth`, by the
 * "PUBLISHED" disposition in the trust model above `GET /studies` in
 * routes/firsthand.ts - and both took `limit` straight from the query string
 * with nothing but a `|| 10` fallback. So `?limit=1000000` was one request
 * from anyone on the network, ordering the whole `user_profiles` table joined
 * to `users` and serialising every participant's NAME and participation
 * volume. cto/AdaptaLabs#17.
 *
 * A NEGATIVE WAS THE SHARPER HALF. `parseInt('-5')` is `-5`, which is truthy,
 * so the `|| 10` fallback never fired and `LIMIT -5` reached Postgres, which
 * refuses it - an unauthenticated 500 on two public routes.
 *
 * Written as a NUMBER HERE and asserted as the same number in the test rather
 * than derived from this constant. A test that reads `MAX_LEADERBOARD_LIMIT`
 * to build its expectation cannot see `MAX_LEADERBOARD_LIMIT` change.
 *
 * WHAT THIS DOES NOT DECIDE: whether participant-facing consent or T&Cs cover
 * publishing a participant's name and points at all. That question is #17's
 * other half, it is NOT answerable from this repository - nothing in
 * default-consent-text.ts, consent-templates.ts or shared/firsthand/ mentions
 * the leaderboard, a participant's name, or points - and a sentence here
 * asserting either answer would be an invention. Open for Nick.
 */
export const MAX_LEADERBOARD_LIMIT = 100;
const DEFAULT_LEADERBOARD_LIMIT = 10;

/**
 * One parser for both routes. Separate `parseInt` calls are how the two drift.
 *
 * Clamps rather than refuses: these are public read routes where a silly
 * `limit` is far more likely to be a careless client than an attack, and a
 * 400 on a page that renders fine at the ceiling helps nobody. The REFUSE
 * rather than TRUNCATE rule this repo applies elsewhere is about withholding
 * DATA a caller asked for and is entitled to; here the caller is asking for
 * more rows than the route publishes, and the ceiling is the answer.
 */
export function leaderboardLimit(raw: unknown): number {
  // A REPEATED QUERY PARAMETER IS AN ARRAY, and `String(['5', '9999'])` is
  // `'5,9999'`, which `parseInt` happily reads as 5. So `?limit=5&limit=9999`
  // silently answered with the first value by a coincidence of comma-joining
  // rather than by any rule. Not a leak - the result is still clamped - but a
  // behaviour nobody chose, so it is refused rather than documented. Found by
  // this function's own test, not by reading it.
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return DEFAULT_LEADERBOARD_LIMIT;
  }

  const parsed = parseInt(String(raw), 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_LEADERBOARD_LIMIT;
  }

  return Math.min(parsed, MAX_LEADERBOARD_LIMIT);
}

// GET /api/gamification/profile - Get user's AdaptaBits profile
router.get('/profile', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const profile = await getUserProfile(userId);
    
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    res.json(profile);
  } catch (error) {
    logger.error('Error fetching user profile', { error });
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// GET /api/gamification/achievements - Get user's achievements
router.get('/achievements', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const achievements = await getUserAchievements(userId);
    
    res.json(achievements);
  } catch (error) {
    logger.error('Error fetching user achievements', { error });
    res.status(500).json({ error: 'Failed to fetch achievements' });
  }
});

// GET /api/gamification/leaderboard - Get global leaderboard
router.get('/leaderboard', async (req: Request, res: Response) => {
  try {
    const limit = leaderboardLimit(req.query.limit);
    const leaderboard = await getLeaderboard(limit);
    
    res.json(leaderboard);
  } catch (error) {
    logger.error('Error fetching leaderboard', { error });
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// GET /api/gamification/leaderboard/monthly - Get monthly leaderboard
router.get('/leaderboard/monthly', async (req: Request, res: Response) => {
  try {
    const limit = leaderboardLimit(req.query.limit);
    const leaderboard = await getMonthlyLeaderboard(limit);
    
    res.json(leaderboard);
  } catch (error) {
    logger.error('Error fetching monthly leaderboard', { error });
    res.status(500).json({ error: 'Failed to fetch monthly leaderboard' });
  }
});

// GET /api/gamification/points-history - Get user's AdaptaBits history
router.get('/points-history', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const limit = parseInt(req.query.limit as string) || 20;
    const history = await getPointsHistory(userId, limit);
    
    res.json(history);
  } catch (error) {
    logger.error('Error fetching points history', { error });
    res.status(500).json({ error: 'Failed to fetch points history' });
  }
});

export default router;
