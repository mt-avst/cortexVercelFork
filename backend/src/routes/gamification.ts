import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/authenticate';
import { logger } from '../utils/logger';
// The four TYPES this file used to import - UserProfile, UserAchievement,
// LeaderboardEntry and PointsTransaction - were unused, and held four
// `@typescript-eslint/no-unused-vars` bulk suppressions between them. Removed
// with the suppressions rather than left, since re-adding `PointsHistoryPage`
// beside them was the tempting thing to do while touching this file and would
// have made the list longer without making it true. The handlers infer their
// response types from the service.
import {
  getUserProfile,
  getUserAchievements,
  getLeaderboard,
  getMonthlyLeaderboard,
  getPointsHistory
} from '../services/gamification';
import { parsePointsHistoryCursor } from '../../../shared/services/gamification';
import type { PointsHistoryCursor } from '../services/gamification';

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
 * 100 IS KEPT DELIBERATELY rather than tightened alongside the id removal. The
 * largest page the product asks for is 20 (`components/Leaderboard.tsx`), so
 * anything from 20 upwards is the same product; 100 already matches
 * `MAX_POINTS_HISTORY_LIMIT`, and a second, different number here would be two
 * policies to keep in step for no reduction in what is published now that the
 * join key is gone.
 *
 * THE OTHER HALF OF #17 IS NOW DECIDED, and this is the record of it. The
 * question was whether publishing a participant's NAME and participation volume
 * to anonymous callers is consented at all - unanswerable from this repository,
 * since nothing in default-consent-text.ts, consent-templates.ts or
 * shared/firsthand/ mentions the leaderboard, a name or points. It was answered
 * OUTSIDE the repository, by the product owner:
 *
 *   The leaderboard is an INTENTIONALLY PUBLIC, consented feature. No auth.
 *   `user_id` is NOT part of it. Name and points are the display; the id is the
 *   join key that lets an anonymous caller line a row up against anything else
 *   they hold, and it bought the product nothing but a React key. Stripped in
 *   the SELECT lists of `getLeaderboard` and `getMonthlyLeaderboard`, because
 *   the type is a claim about the query and only the query is the payload.
 *
 * Kept in step with the PUBLISHED row of the trust model above `GET /studies`
 * in routes/firsthand.ts, which is where a reader arriving at the dispositions
 * lands. If one of the two changes, change both.
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
 * `parseLimit` READS and nothing else - it returns a usable positive integer
 * or `null`. The ceiling POLICY lives in each caller, because the two families
 * answer an over-large `limit` differently, and the REFUSE rather than TRUNCATE
 * rule this repo applies elsewhere is about withholding DATA a caller asked for
 * and IS ENTITLED TO:
 *
 *   - The LEADERBOARDS clamp. The caller is asking for more rows than the route
 *     publishes, so the ceiling is genuinely the answer, and a 400 on a page
 *     that renders fine at the ceiling helps nobody. A leaderboard has no
 *     "rest" to reach: rank 101 is not withheld, it is not on the board.
 *   - `/points-history` REFUSES above the ceiling with a 400, AND reports
 *     `has_more` at or below it. The rows are the caller's OWN transactions -
 *     they are entitled to all of them - so a clamped short response would be
 *     indistinguishable from the end of history. The 400 makes the ceiling
 *     visible; `has_more` makes the truncation visible for every page under it,
 *     including the default 20. See `pointsHistoryLimit`, cto/AdaptaLabs#24 and
 *     #23. The ceiling is now a PAGE SIZE rather than a wall: `?before=` reaches
 *     the rest of the history a page at a time (cto/AdaptaLabs#47), which is why
 *     100 stays where it is instead of growing.
 *
 * THE THIRD DISPOSITION IS NOT IN THIS FILE, and the set only makes sense read
 * together: `GET /api/opportunities` answers 413 above its ceiling and offers
 * no smaller request to retry with, because nobody asks it for a number at all
 * - the question is "every published opportunity" (`MAX_OPPORTUNITIES_RETURNED`,
 * routes/opportunities.ts, cto/AdaptaLabs#22). Clamp where the ceiling IS the
 * answer; refuse where a short page would lie; report `has_more` where the
 * caller owns the rows and a page is legitimate.
 */
function parseLimit(raw: unknown): number | null {
  // A REPEATED QUERY PARAMETER IS AN ARRAY, and `String(['5', '9999'])` is
  // `'5,9999'`, which `parseInt` happily reads as 5. So `?limit=5&limit=9999`
  // silently answered with the first value by a coincidence of comma-joining
  // rather than by any rule. Not a leak - the result is still bounded - but a
  // behaviour nobody chose, so it is refused rather than documented. Found by
  // this function's own test, not by reading it.
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return null;
  }

  const parsed = parseInt(String(raw), 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

/**
 * The public leaderboard pair. Both UNAUTHENTICATED and PUBLISHED by product
 * decision - see the note above, and the trust model in routes/firsthand.ts.
 * CLAMPS to the ceiling; an absent or unusable `limit` falls back to the
 * default rather than being refused.
 */
export function leaderboardLimit(raw: unknown): number {
  const parsed = parseLimit(raw);
  return parsed === null ? DEFAULT_LEADERBOARD_LIMIT : Math.min(parsed, MAX_LEADERBOARD_LIMIT);
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

// Returns the bounded limit, or `null` when the caller EXPLICITLY asked for
// more than the ceiling - which the route turns into a 400 so the wall is
// visible instead of a silent clamp (cto/AdaptaLabs#24). An absent, negative or
// unparseable `limit` still falls back to the default: that is a malformed
// request, not a truncated page, and #17 already settled it must not 500.
export function pointsHistoryLimit(raw: unknown): number | null {
  const parsed = parseLimit(raw);
  if (parsed === null) return DEFAULT_POINTS_HISTORY_LIMIT;
  if (parsed > MAX_POINTS_HISTORY_LIMIT) return null;
  return parsed;
}

/**
 * THE QUERY-STRING SHAPES OF A `?before=` CURSOR. cto/AdaptaLabs#47.
 *
 * The FORMAT is not decided here - `parsePointsHistoryCursor` in
 * shared/services/gamification.ts owns it, beside the `next_before` that emits
 * it, so the parser and the producer cannot drift apart in separate modules.
 * What is decided here is what express can hand over that a string parser has no
 * opinion about:
 *
 *   ABSENT     -> `undefined`, the first page. Not a refusal: no cursor is the
 *                 normal case and it must not become a 400.
 *   A REPEAT   -> `?before=a&before=b` arrives as an ARRAY, and it is REFUSED
 *                 rather than coerced. `parseLimit` above already settled this
 *                 disposition for this file, and `GET /api/opportunities`
 *                 settled it again for the same reason: taking the first value
 *                 or joining them answers a question nobody asked.
 *   ANYTHING
 *   UNREADABLE -> `null`, matching `pointsHistoryLimit`'s convention that null
 *                 is the refusal the route turns into a 400. It matters that
 *                 this is not silently treated as ABSENT: that would answer a
 *                 malformed cursor with a silent jump back to the top of
 *                 history, which is a wrong answer wearing a 200.
 */
export function pointsHistoryCursor(raw: unknown): PointsHistoryCursor | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return null;
  return parsePointsHistoryCursor(raw);
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
//
// PUBLISHED (cto/AdaptaLabs#17). Deliberately unauthenticated: this is a
// consented, intentionally public feature, decided by the product owner and
// recorded above `MAX_LEADERBOARD_LIMIT` and in the trust model in
// routes/firsthand.ts. What is published is a NAME, points, a level and a rank
// - NOT `user_id`, which `getLeaderboard` no longer selects. Adding a field to
// that SELECT list publishes it to anonymous callers; that is the decision this
// route embodies, not an oversight in it.
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
//
// PUBLISHED, exactly as the route above and for the same reasons - and said
// again here rather than by reference, because this pair being near-identical
// and thirteen lines apart is how #17's cap reached one and not the other.
// `monthly_points` narrows the published figure to the current month.
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
//
// PAGED, and the ONLY route in this file that answers with an envelope rather
// than a bare array (cto/AdaptaLabs#23). `{ transactions, has_more }` is a
// BREAKING wire change and was taken knowingly: the ceiling refusal below only
// covers a caller who ASKS for too much, while a caller on the default 20 with
// 50 transactions got a short array and no way to tell it was short. Measured
// blast radius at the time of the change: `frontend/src/api/gamification.ts`
// was the only consumer in the tree and its `getPointsHistory` had no callers
// at all, so the honest shape cost nothing to adopt.
//
// PAGED FOR REAL SINCE cto/AdaptaLabs#47. `has_more` said the older rows
// existed; `?before=` is how they are asked for, and `next_before` is the value
// to send. Keyset on `(created_at, id)` rather than OFFSET, because points are
// awarded WHILE a user reads their own history and OFFSET skips or repeats rows
// when a transaction lands between two requests. The reasoning is on
// `PointsHistoryCursor` in shared/services/gamification.ts.
router.get('/points-history', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const limit = pointsHistoryLimit(req.query.limit);
    // null means the caller asked for more than the ceiling. Refuse visibly
    // rather than clamp, so a short page is never mistaken for the end of
    // history (cto/AdaptaLabs#24).
    if (limit === null) {
      return res.status(400).json({ error: `limit must not exceed ${MAX_POINTS_HISTORY_LIMIT}` });
    }
    // null means a cursor arrived that this route will not put into SQL.
    // Refused here rather than at the database, where an unparseable timestamp
    // or uuid is a 500 with the cause only in the log.
    const before = pointsHistoryCursor(req.query.before);
    if (before === null) {
      return res.status(400).json({
        error: 'before must be a cursor of the form <created_at>,<id> as returned in next_before'
      });
    }
    const history = await getPointsHistory(userId, limit, before);

    res.json(history);
  } catch (error) {
    logger.error('Error fetching points history', { error });
    res.status(500).json({ error: 'Failed to fetch points history' });
  }
});

export default router;
