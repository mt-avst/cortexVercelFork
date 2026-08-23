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
 *
 * AND IT LEFT THE THIRD ROUTE IN THIS FILE UNCAPPED. This block said "both
 * leaderboard routes" and read as saying "this file", while the very next
 * route down, `/points-history`, kept its bare `parseInt`. See
 * `MAX_POINTS_HISTORY_LIMIT`. The test file now carries a scan of this source
 * so a FOURTH route cannot repeat it - a per-route table cannot fail for a
 * route nobody wrote a row for.
 */
export const MAX_LEADERBOARD_LIMIT = 100;
const DEFAULT_LEADERBOARD_LIMIT = 10;

/**
 * ONE PARSER FOR EVERY `limit` IN THIS FILE. Separate `parseInt` calls are how
 * routes drift, and this file has already proved it twice: the three handlers
 * sit thirteen lines apart each, near-identical, and `/points-history` - the
 * last of them - kept its own bare `parseInt` through a fix whose docblock
 * called the defect closed.
 *
 * Clamps rather than refuses: a silly `limit` is far more likely to be a
 * careless client than an attack, and a 400 on a page that renders fine at
 * the ceiling helps nobody.
 *
 * THAT REASONING IS CLEAN FOR THE LEADERBOARDS AND NOT CLEAN FOR
 * `/points-history`, and the difference is worth stating rather than
 * smoothing over. The REFUSE rather than TRUNCATE rule this repo applies
 * elsewhere is about withholding DATA a caller asked for and IS ENTITLED TO.
 * On the leaderboards the caller is asking for more rows than the route
 * publishes, so the ceiling is genuinely the answer. On `/points-history`
 * the rows are the caller's OWN transactions - they are entitled to all of
 * them, the route has NO offset, cursor or `has_more`, and before this
 * change `?limit=999999999` returned the lot. So for a user with more than
 * 100 transactions the ceiling is a silent wall, not a page boundary, and a
 * short response is indistinguishable from the end of history.
 *
 * Shipped as a clamp anyway, for reasons that are about blast radius rather
 * than principle: an unbounded read and a 500 on a routine request are live
 * defects today, pagination is a wire-contract change, and no client is
 * affected today (see the note on `MAX_POINTS_HISTORY_LIMIT`). THE PROPER
 * FIX IS A CURSOR, or a 400 above the ceiling so the wall is at least
 * visible. Recorded as an open decision rather than settled here - a
 * docblock asserting this was fine would be the circular argument a review
 * gate correctly called out in its first draft.
 */
function boundedLimit(raw: unknown, fallback: number, ceiling: number): number {
  // A REPEATED QUERY PARAMETER IS AN ARRAY, and `String(['5', '9999'])` is
  // `'5,9999'`, which `parseInt` happily reads as 5. So `?limit=5&limit=9999`
  // silently answered with the first value by a coincidence of comma-joining
  // rather than by any rule. Not a leak - the result is still clamped - but a
  // behaviour nobody chose, so it is refused rather than documented. Found by
  // this function's own test, not by reading it.
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return fallback;
  }

  const parsed = parseInt(String(raw), 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, ceiling);
}

/** The public leaderboard pair. Both UNAUTHENTICATED - see the note above. */
export function leaderboardLimit(raw: unknown): number {
  return boundedLimit(raw, DEFAULT_LEADERBOARD_LIMIT, MAX_LEADERBOARD_LIMIT);
}

/**
 * THE CEILING ON A PAGE OF THE CALLER'S OWN POINTS HISTORY.
 *
 * The third route in this file, and it was left behind when #17 capped the
 * other two - `parseInt(req.query.limit as string) || 20` straight into
 * `LIMIT $2`. #17's finding named an INSTANCE ("both leaderboard routes")
 * and the class was the file. Found by a security gate on !223, which was
 * about something else entirely.
 *
 * IT IS NOT THE LEADERBOARD LEAK, and saying so precisely matters because the
 * two halves of #17 came apart here. `getPointsHistory` binds the value as
 * `$2`, so there is no injection, and it scopes rows with
 * `WHERE user_id = $1` against the caller's own id behind `requireAuth`, so
 * no other user's data is reachable at any limit. What survived is the other
 * half: `?limit=999999999` is an unbounded read, and `?limit=-5` is a 500,
 * because `parseInt('-5')` is -5, which is TRUTHY, so `|| 20` never fired and
 * Postgres raises SQLSTATE 2201W, "LIMIT must not be negative". A NEGATIVE
 * WAS THE SHARPER HALF here too.
 *
 * SEPARATE FROM `leaderboardLimit` BECAUSE THE DEFAULT IS DIFFERENT - 20, not
 * 10. Calling `leaderboardLimit` here is the tempting one-word fix: it caps
 * the route, refuses the negative, and satisfies every ceiling assertion,
 * while halving the default page. The parser is shared; the policy numbers
 * are not.
 *
 * MEASURED BLAST RADIUS TODAY: empty. `frontend/src/api/gamification.ts`
 * always sends an explicit `?limit=`, and its own default is 20, so the
 * server default is never reached from the product - and that function has
 * no callers at all. 20 is kept because it is the published contract and the
 * frontend's default agrees with it, not because a client would break.
 *
 * 100 matches the leaderboard ceiling deliberately: this is a page of rows in
 * a UI, not an export, and nothing in the product asks for more. Written as a
 * number here and asserted as the same number in the test rather than derived
 * from this constant.
 */
export const MAX_POINTS_HISTORY_LIMIT = 100;
const DEFAULT_POINTS_HISTORY_LIMIT = 20;

export function pointsHistoryLimit(raw: unknown): number {
  return boundedLimit(raw, DEFAULT_POINTS_HISTORY_LIMIT, MAX_POINTS_HISTORY_LIMIT);
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
    const limit = pointsHistoryLimit(req.query.limit);
    const history = await getPointsHistory(userId, limit);
    
    res.json(history);
  } catch (error) {
    logger.error('Error fetching points history', { error });
    res.status(500).json({ error: 'Failed to fetch points history' });
  }
});

export default router;
