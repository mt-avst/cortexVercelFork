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
    const limit = parseInt(req.query.limit as string) || 10;
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
    const limit = parseInt(req.query.limit as string) || 10;
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
