import type { OpportunityType } from '../types';

/**
 * Structural type matching the subset of `pg.Pool` used by this module.
 *
 * We deliberately don't `import type { Pool } from 'pg'` here: `@types/pg` is only
 * installed under `backend/node_modules` in this workspace, not at the repo root, so
 * a direct import fails to resolve when this file is type-checked as part of the
 * `shared` directory (e.g. via `backend/tsconfig.json`'s include of everything under
 * `shared`). Any real `pg.Pool` instance (from `backend/src/config` or `api/db.ts`)
 * structurally satisfies this interface, so callers can pass their pool straight
 * through with no cast.
 */
export interface Pool {
  connect(): Promise<{
    query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }>;
    release(): void;
  }>;
}

export interface UserProfile {
  id: string;
  user_id: string;
  total_points: number;
  monthly_points: number;
  level: number;
  sessions_completed: number;
  surveys_completed: number;
  polls_completed: number;
  questions_completed: number;
  last_activity_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  points_required: number;
  category: 'participation' | 'milestone' | 'special';
  badge_color: string;
  created_at: string;
}

export interface UserAchievement {
  id: string;
  user_id: string;
  achievement_id: string;
  earned_at: string;
  achievement: Achievement;
}

export interface PointsTransaction {
  id: string;
  user_id: string;
  points: number;
  reason: string;
  opportunity_id: string | null;
  session_id: string | null;
  created_at: string;
}

/**
 * A ROW OF THE PUBLIC LEADERBOARD, and it carries NO `user_id` on purpose.
 *
 * cto/AdaptaLabs#17. Both leaderboard routes are unauthenticated by product
 * decision - the PUBLISHED disposition in routes/firsthand.ts - so every field
 * here is published to anyone on the network. Name and points ARE the display.
 * The id was not: it is the join key that lets an anonymous caller line a row
 * up against anything else they already hold, and nothing in the product ever
 * read it except a React key in components/Leaderboard.tsx, which now keys on
 * `rank`.
 *
 * REMOVED FROM THE SELECT LISTS AND NOT JUST FROM THIS TYPE. `getLeaderboard`
 * returns `result.rows` - plain objects straight from `pg` - so dropping the
 * field here and leaving `up.user_id` in the SQL would still have serialised it
 * onto the wire while `tsc` reported the payload clean. The type is a claim
 * about the query; only the query is the payload.
 */
export interface LeaderboardEntry {
  name: string;
  total_points: number;
  monthly_points: number;
  level: number;
  rank: number;
}

/**
 * A PAGE of the caller's own points history, and `has_more` is why it is a page
 * rather than an array.
 *
 * cto/AdaptaLabs#23. `getPointsHistory` had no offset, no cursor and no
 * `has_more`, so a caller with more transactions than their `limit` got a short
 * array that was INDISTINGUISHABLE from the end of their history. These are
 * their own rows - data they own and are entitled to - which is the case the
 * repo's refuse-rather-than-truncate rule exists for.
 *
 * `next_before` CLOSES THE OTHER HALF (cto/AdaptaLabs#47). `has_more` made the
 * older rows VISIBLE and left them unreachable - a caller could be told history
 * continued and still have no way to ask for it. Pagination that lies is worse
 * than pagination that stops, and pagination that points at a door it will not
 * open is only slightly better.
 *
 * IT IS PRODUCED BY THE SERVER AND ECHOED BACK VERBATIM, and that is not
 * decoration. `created_at` is `TIMESTAMPTZ`, which Postgres stores to the
 * MICROSECOND, and `pg` parses it into a JavaScript `Date`, which holds
 * MILLISECONDS. A caller building its own cursor out of the `created_at` it sees
 * in `transactions` would therefore round 12:00:00.123456 down to 12:00:00.123
 * and skip every row in between on the next page - the precise defect keyset
 * pagination is chosen to avoid. `next_before` carries the microseconds because
 * the query renders it with `to_char` rather than through the Date round trip.
 *
 * `null` when there is nothing after this page, so `has_more === false` and
 * `next_before === null` cannot disagree.
 */
export interface PointsHistoryPage {
  transactions: PointsTransaction[];
  has_more: boolean;
  next_before: string | null;
}

/**
 * A POSITION IN THE LEDGER, as `(created_at, id)`.
 *
 * THE `id` TIEBREAK IS THE WHOLE POINT and not a formality: `created_at` is not
 * unique, and two transactions awarded by the same statement share a timestamp
 * to the microsecond. A page boundary landing between them drops one for ever
 * with `created_at` alone, and nothing anywhere reports it.
 *
 * KEYSET RATHER THAN `OFFSET`, because this is an append-only time-ordered
 * ledger and `OFFSET` is wrong for it twice over: it re-scans everything it
 * skips, so deep pages get linearly slower, and it SKIPS OR REPEATS rows when a
 * transaction lands between two requests - which on this table it will, since
 * points are awarded while a user reads their own history.
 *
 * `created_at` is the exact text the server emitted in `next_before`, parsed
 * back by Postgres with `::timestamptz`. The route validates its shape before it
 * ever reaches SQL.
 */
export interface PointsHistoryCursor {
  created_at: string;
  id: string;
}

/**
 * THE PARSER LIVES BESIDE THE PRODUCER, not at the route.
 *
 * `next_before` is built four hundred lines below by `getPointsHistory`, and the
 * only invariant that matters is that THIS FUNCTION ACCEPTS WHAT THAT ONE EMITS.
 * Put the two in different modules and the format has two owners, which is how a
 * timestamp format drifts by one digit and every second page comes back empty.
 * `backend/src/routes/gamification.ts` wraps it for the query-string shapes
 * express can hand over - an absent parameter, or an array from a repeat - and
 * that wrapper is where the 400 is decided.
 *
 * SIX FRACTIONAL DIGITS, optional. `created_at` is `TIMESTAMPTZ`, Postgres keeps
 * MICROSECONDS, and the round trip through `pg` into a JavaScript `Date` loses
 * three of them - so a cursor rebuilt from a transaction's own `created_at`
 * rounds down and skips every row in the gap. That is the exact failure keyset
 * pagination is chosen to avoid, so the format has to carry what the column
 * holds. A whole-second cursor is still a legitimate position and is accepted.
 *
 * `null` for anything else, because both halves reach SQL as a cast -
 * `::timestamptz` and `::uuid` - where an unparseable value is SQLSTATE 22007 or
 * 22P02 rather than an empty page.
 */
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const CURSOR_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function parsePointsHistoryCursor(raw: string): PointsHistoryCursor | null {
  // The timestamp half carries no comma, so the FIRST comma is the separator.
  // Splitting on all of them would take `a,b,c` apart into three pieces and read
  // the middle one as a uuid, which is a misreading rather than a refusal.
  const separator = raw.indexOf(',');
  if (separator === -1) return null;

  const created_at = raw.slice(0, separator);
  const id = raw.slice(separator + 1);

  if (!CURSOR_TIMESTAMP.test(created_at) || !CURSOR_UUID.test(id)) return null;

  return { created_at, id };
}

// AdaptaBits configuration
const POINTS_CONFIG = {
  test_session: 10,
  interview_session: 10,
  survey_session: 8,
  poll_session: 5,
  question_session: 3,
  unmoderated_session: 10,
  level_multiplier: 1.1, // 10% bonus per level
};

// AdaptaBits values for different opportunity types
const POINT_VALUES: Record<OpportunityType, number> = {
  test: 10,
  interview: 10,
  survey: 8,
  poll: 5,
  question: 3,
  unmoderated: 10,
};

// Level thresholds (AdaptaBits required for each level)
const LEVEL_THRESHOLDS = [
  0,    // Level 1
  50,   // Level 2
  120,  // Level 3
  200,  // Level 4
  300,  // Level 5
  450,  // Level 6
  650,  // Level 7
  900,  // Level 8
  1200, // Level 9
  1600, // Level 10
];

/**
 * Get or create user profile
 */
export async function getUserProfile(pool: Pool, userId: string): Promise<UserProfile | null> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT * FROM user_profiles WHERE user_id = $1
    `, [userId]);

    if (result.rows.length === 0) {
      // Create new profile
      const createResult = await client.query(`
        INSERT INTO user_profiles (user_id)
        VALUES ($1)
        RETURNING *
      `, [userId]);
      return createResult.rows[0];
    }

    return result.rows[0];
  } finally {
    client.release();
  }
}

/**
 * Award AdaptaBits to user for completing a session
 */
export async function awardPoints(
  pool: Pool,
  userId: string,
  opportunityType: OpportunityType,
  opportunityId: string,
  sessionId: string
): Promise<{ points: number; newLevel: number; levelUp: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get current profile
    const profile = await getUserProfile(pool, userId);
    if (!profile) {
      throw new Error('User profile not found');
    }

    // Calculate base AdaptaBits
    let basePoints = 0;
    switch (opportunityType) {
      case 'test':
      case 'interview':
        basePoints = POINTS_CONFIG.test_session;
        break;
      case 'survey':
        basePoints = POINTS_CONFIG.survey_session;
        break;
      case 'poll':
        basePoints = POINTS_CONFIG.poll_session;
        break;
      case 'question':
        basePoints = POINTS_CONFIG.question_session;
        break;
      case 'unmoderated':
        basePoints = POINTS_CONFIG.unmoderated_session;
        break;
    }

    // Apply level multiplier
    const finalPoints = Math.floor(basePoints * Math.pow(POINTS_CONFIG.level_multiplier, profile.level - 1));

    // Update profile
    const newTotalPoints = profile.total_points + finalPoints;
    const newMonthlyPoints = profile.monthly_points + finalPoints;
    const newLevel = calculateLevel(newTotalPoints);
    const levelUp = newLevel > profile.level;

    // Update counters based on opportunity type
    let updateQuery = `
      UPDATE user_profiles SET
        total_points = $2,
        monthly_points = $3,
        level = $4,
        last_activity_date = NOW(),
        updated_at = NOW()
    `;
    const updateParams: any[] = [userId, newTotalPoints, newMonthlyPoints, newLevel];

    switch (opportunityType) {
      case 'test':
      case 'interview':
      case 'unmoderated':
        updateQuery += `, sessions_completed = sessions_completed + 1`;
        break;
      case 'survey':
        updateQuery += `, surveys_completed = surveys_completed + 1`;
        break;
      case 'poll':
        updateQuery += `, polls_completed = polls_completed + 1`;
        break;
      case 'question':
        updateQuery += `, questions_completed = questions_completed + 1`;
        break;
    }

    updateQuery += ` WHERE user_id = $1`;

    await client.query(updateQuery, updateParams);

    // Record transaction
    await client.query(`
      INSERT INTO points_transactions (user_id, points, reason, opportunity_id, session_id)
      VALUES ($1, $2, $3, $4, $5)
    `, [userId, finalPoints, `Completed ${opportunityType} session`, opportunityId, sessionId]);

    // Check for new achievements
    await checkAndAwardAchievements(pool, userId, newTotalPoints);

    await client.query('COMMIT');

    return {
      points: finalPoints,
      newLevel,
      levelUp
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Calculate user level based on total AdaptaBits
 */
function calculateLevel(totalPoints: number): number {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (totalPoints >= LEVEL_THRESHOLDS[i]) {
      return i + 1;
    }
  }
  return 1;
}

/**
 * Check and award achievements
 */
async function checkAndAwardAchievements(
  pool: Pool,
  userId: string,
  totalPoints: number
): Promise<void> {
  const client = await pool.connect();
  try {
    const profile = await getUserProfile(pool, userId);
    if (!profile) return;

    // Get all achievements
    const achievementsResult = await client.query(`
      SELECT * FROM achievements ORDER BY points_required ASC
    `);

    // Get user's existing achievements
    const userAchievementsResult = await client.query(`
      SELECT achievement_id FROM user_achievements WHERE user_id = $1
    `, [userId]);

    const existingAchievementIds = new Set(userAchievementsResult.rows.map(row => row.achievement_id));

    // Check each achievement
    for (const achievement of achievementsResult.rows) {
      if (existingAchievementIds.has(achievement.id)) continue;

      let shouldAward = false;

      switch (achievement.name) {
        case 'First Steps':
          shouldAward = profile.sessions_completed + profile.surveys_completed +
                       profile.polls_completed + profile.questions_completed >= 1;
          break;
        case 'Test Taker':
          shouldAward = profile.sessions_completed >= 5;
          break;
        case 'Survey Master':
          shouldAward = profile.surveys_completed >= 3;
          break;
        case 'Poll Participant':
          shouldAward = profile.polls_completed >= 2;
          break;
        case 'Question Answerer':
          shouldAward = profile.questions_completed >= 5;
          break;
        case 'Research Enthusiast':
          shouldAward = profile.sessions_completed + profile.surveys_completed +
                       profile.polls_completed + profile.questions_completed >= 10;
          break;
        case 'AdaptaLabs Legend':
          shouldAward = totalPoints >= 500;
          break;
        case 'Team Player': {
          const hasTest = profile.sessions_completed > 0;
          const hasSurvey = profile.surveys_completed > 0;
          const hasPoll = profile.polls_completed > 0;
          const hasQuestion = profile.questions_completed > 0;
          const typeCount = [hasTest, hasSurvey, hasPoll, hasQuestion].filter(Boolean).length;
          shouldAward = typeCount >= 3;
          break;
        }
      }

      if (shouldAward) {
        await client.query(`
          INSERT INTO user_achievements (user_id, achievement_id)
          VALUES ($1, $2)
          ON CONFLICT (user_id, achievement_id) DO NOTHING
        `, [userId, achievement.id]);
      }
    }
  } finally {
    client.release();
  }
}

/**
 * Get user achievements
 */
export async function getUserAchievements(pool: Pool, userId: string): Promise<UserAchievement[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT ua.*, a.name, a.description, a.icon, a.points_required, a.category, a.badge_color, a.created_at as achievement_created_at
      FROM user_achievements ua
      JOIN achievements a ON ua.achievement_id = a.id
      WHERE ua.user_id = $1
      ORDER BY ua.earned_at DESC
    `, [userId]);

    return result.rows.map(row => ({
      id: row.id,
      user_id: row.user_id,
      achievement_id: row.achievement_id,
      earned_at: row.earned_at,
      achievement: {
        id: row.achievement_id,
        name: row.name,
        description: row.description,
        icon: row.icon,
        points_required: row.points_required,
        category: row.category,
        badge_color: row.badge_color,
        created_at: row.achievement_created_at
      }
    }));
  } finally {
    client.release();
  }
}

/**
 * Get leaderboard (top users by total AdaptaBits)
 *
 * NO `up.user_id` IN THE SELECT LIST, and that is the payload boundary rather
 * than a tidy-up - see `LeaderboardEntry`. cto/AdaptaLabs#17.
 *
 * A PUBLIC BOARD IS EARNED, NOT JOINED BY ARRIVING. `WHERE up.total_points > 0`
 * is a privacy filter, not a presentation one. `getUserProfile` INSERTs a row
 * on a GET, and this route is UNAUTHENTICATED and selects `u.name` - so
 * without the filter, merely opening /gamification published the visitor's
 * real name to any anonymous caller. Measured on the real database: one GET
 * took the board from one row to two, the second a 0-point newcomer who had
 * done nothing but load a page.
 *
 * FILTER ON THE METRIC THIS BOARD RANKS BY. The monthly sibling filters
 * `monthly_points` instead, which is not a copy-paste slip: a participant with
 * lifetime points and nothing this month belongs here and not there.
 */
export async function getLeaderboard(pool: Pool, limit: number = 10): Promise<LeaderboardEntry[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT
        u.name,
        up.total_points,
        up.monthly_points,
        up.level,
        ROW_NUMBER() OVER (ORDER BY up.total_points DESC) as rank
      FROM user_profiles up
      JOIN users u ON up.user_id = u.id
      WHERE up.total_points > 0
      ORDER BY up.total_points DESC
      LIMIT $1
    `, [limit]);

    return result.rows;
  } finally {
    client.release();
  }
}

/**
 * Get monthly leaderboard (top users by monthly AdaptaBits)
 *
 * NO `up.user_id` IN THE SELECT LIST. The pair is twenty-six lines apart and
 * near-identical, which is the shape where a fix applied to one reads as a fix
 * applied to both - #17 capped the limit on both and this file's own history
 * shows the trap. cto/AdaptaLabs#17.
 *
 * SAME TRAP, SECOND TIME. The zero-point privacy filter was applied to both
 * for the same reason, and on `monthly_points` here rather than on
 * `total_points`. This is the arm that matters in practice: after a monthly
 * reset everyone sits at 0, ordering among ties is unspecified, and a brand-new
 * profile can surface in the visible top 20. Both are pinned by SEPARATE arms
 * in gamification-postgres.test.ts, including one asserting a lifetime-scorer
 * with no monthly points is absent HERE and present on the all-time board - a
 * shared arm would have hidden exactly that.
 */
export async function getMonthlyLeaderboard(pool: Pool, limit: number = 10): Promise<LeaderboardEntry[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT
        u.name,
        up.total_points,
        up.monthly_points,
        up.level,
        ROW_NUMBER() OVER (ORDER BY up.monthly_points DESC) as rank
      FROM user_profiles up
      JOIN users u ON up.user_id = u.id
      WHERE up.monthly_points > 0
      ORDER BY up.monthly_points DESC
      LIMIT $1
    `, [limit]);

    return result.rows;
  } finally {
    client.release();
  }
}

/**
 * Reset monthly AdaptaBits (should be called monthly)
 */
export async function resetMonthlyPoints(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      UPDATE user_profiles SET monthly_points = 0
    `);
  } finally {
    client.release();
  }
}

/**
 * Get AdaptaBits transaction history for user, as a PAGE.
 *
 * cto/AdaptaLabs#23. `limit` still means "at most this many rows returned";
 * `has_more` says whether the caller's history continues past them.
 *
 * ASKS FOR ONE MORE ROW THAN IT RETURNS, on the same line
 * `MAX_CSV_PARTICIPANTS + 1` is drawn on. Without the `+ 1` a full page and the
 * exact end of history are the same response, so `has_more` could only ever be
 * derived from `rows.length === limit` - which is WRONG for the caller whose
 * history is exactly `limit` long, and wrong in the direction that invents rows
 * that do not exist. The probe row is sliced off and never reaches the caller.
 *
 * A COUNT(*) WOULD ALSO WORK and is a second query over the same index for a
 * boolean. One row is cheaper and cannot disagree with the page it describes.
 *
 * `before` MAKES THOSE OLDER ROWS REACHABLE (cto/AdaptaLabs#47), which `has_more`
 * only promised. It is a keyset position, not an offset - see PointsHistoryCursor
 * for why that choice is forced rather than preferred.
 *
 * THE `WHERE` IS ONE QUERY, NOT TWO. `$3::timestamptz IS NULL OR ...` keeps the
 * unpaged and paged reads on the same statement, so a change to the ordering,
 * the scoping predicate or the probe row cannot reach one and miss the other -
 * which is how #17's cap reached one leaderboard and not its twin. A row
 * comparison with a NULL cursor evaluates to NULL, and `TRUE OR NULL` is TRUE,
 * so the first page is unaffected whatever Postgres decides about evaluation
 * order.
 *
 * `ORDER BY created_at DESC, id DESC` MATCHES THE COMPARISON EXACTLY. An order
 * that does not agree with the keyset predicate is not pagination, it is a
 * lottery: rows can be skipped or repeated at every boundary. The pre-existing
 * `ORDER BY created_at DESC` alone was already non-deterministic across equal
 * timestamps, which no page boundary could see until there was one.
 *
 * `AT TIME ZONE 'UTC'` IS NOT DECORATION - DO NOT DELETE IT. `to_char` renders a
 * TIMESTAMPTZ in the SESSION's `TimeZone`, so without the conversion the cursor
 * would be a wall-clock reading in whatever zone the connection happened to
 * carry, labelled `Z` regardless, and fed back into a `$3::timestamptz` that
 * reads an offsetless value as being in that same session zone. The round trip
 * then closes only by coincidence, when the session is UTC - which it is in CI
 * and in every container this repository starts, so nothing would notice.
 * Measured on a session pinned to Pacific/Kiritimati with the conversion
 * removed: paging repeated page one until the test's own 50-page bound threw.
 * `AT TIME ZONE 'UTC'` converts to a plain `timestamp` first, so `to_char` has
 * no zone left to consult and the rendering is identical everywhere. Pinned by
 * `renders the same cursor under a non-UTC session TimeZone` and by the canary
 * entry `points-history-cursor-is-rendered-in-utc`.
 */
export async function getPointsHistory(
  pool: Pool,
  userId: string,
  limit: number = 20,
  before?: PointsHistoryCursor | null
): Promise<PointsHistoryPage> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT *,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM points_transactions
      WHERE user_id = $1
        AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `, [userId, limit + 1, before?.created_at ?? null, before?.id ?? null]);

    const page = result.rows.slice(0, limit);
    const has_more = result.rows.length > limit;
    const last = page[page.length - 1];

    return {
      // `cursor_at` is a rendering of a column the caller already has; it is
      // stripped so the wire shape stays `PointsTransaction` and the cursor has
      // exactly one representation, `next_before`.
      transactions: page.map(({ cursor_at: _cursor_at, ...transaction }) => transaction as PointsTransaction),
      has_more,
      // Only when there IS a next page. A cursor handed out at the end of
      // history invites a request that can only come back empty, and a client
      // looping until `next_before` is null would never stop.
      next_before: has_more && last ? `${last.cursor_at},${last.id}` : null
    };
  } finally {
    client.release();
  }
}

/**
 * Awards AdaptaBits to a user after admin approval of a completed session.
 * This function should only be called after an admin has approved a session completion.
 * @param pool The database pool to use.
 * @param userId The ID of the user.
 * @param opportunityType The type of opportunity completed.
 * @param opportunityId The ID of the opportunity.
 * @param sessionId The ID of the session.
 * @param approvedBy The ID of the admin who approved the completion.
 * @returns An object containing AdaptaBits awarded, new level, and level up status.
 */
export async function awardPointsAfterApproval(
  pool: Pool,
  userId: string,
  opportunityType: OpportunityType,
  opportunityId: string,
  sessionId: string,
  approvedBy: string
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify that the booking exists and is approved
    const bookingResult = await client.query(`
      SELECT b.*, s.start_time, s.end_time, o.title as opportunity_title
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      WHERE b.user_id = $1 AND b.session_id = $2 AND b.completion_status = 'approved'
    `, [userId, sessionId]);

    if (bookingResult.rows.length === 0) {
      throw new Error('No approved booking found for this session');
    }

    // Check if AdaptaBits have already been awarded for this session
    const existingTransaction = await client.query(`
      SELECT id FROM points_transactions
      WHERE user_id = $1 AND session_id = $2 AND reason LIKE '%Approved completion%'
    `, [userId, sessionId]);

    if (existingTransaction.rows.length > 0) {
      throw new Error('AdaptaBits already awarded for this approved session');
    }

    // Get or create user profile
    const userProfileResult = await client.query<UserProfile>(
      'SELECT * FROM user_profiles WHERE user_id = $1 FOR UPDATE',
      [userId]
    );

    let userProfile: UserProfile;
    if (userProfileResult.rows.length === 0) {
      const insertResult = await client.query<UserProfile>(
        `INSERT INTO user_profiles (user_id) VALUES ($1)
         RETURNING id, user_id, total_points, monthly_points, level,
                   sessions_completed, surveys_completed, polls_completed,
                   questions_completed, last_activity_date, created_at, updated_at`,
        [userId]
      );
      userProfile = insertResult.rows[0];
    } else {
      userProfile = userProfileResult.rows[0];
    }

    // Calculate AdaptaBits for this activity
    let pointsAwarded = POINT_VALUES[opportunityType] ?? 0;
    if (pointsAwarded === 0) {
      console.warn(`No AdaptaBits defined for opportunity type: ${opportunityType}`);
      await client.query('ROLLBACK');
      return { points: 0, newLevel: userProfile.level, levelUp: false };
    }

    // Apply level multiplier (e.g., 10% bonus per level)
    const levelBonus = (userProfile.level - 1) * 0.1; // Level 1 has 0 bonus
    pointsAwarded = Math.round(pointsAwarded * (1 + levelBonus));

    // Update user profile
    const newTotalPoints = userProfile.total_points + pointsAwarded;
    const newMonthlyPoints = userProfile.monthly_points + pointsAwarded;
    const newLevel = calculateLevel(newTotalPoints);

    // Increment activity counter based on opportunity type
    let activityCounterColumn: keyof UserProfile;
    switch (opportunityType) {
      case 'test':
      case 'interview':
      case 'unmoderated':
        activityCounterColumn = 'sessions_completed';
        break;
      case 'survey': activityCounterColumn = 'surveys_completed'; break;
      case 'poll': activityCounterColumn = 'polls_completed'; break;
      case 'question': activityCounterColumn = 'questions_completed'; break;
      default: activityCounterColumn = 'sessions_completed'; // Fallback
    }

    const updateProfileResult = await client.query<UserProfile>(
      `UPDATE user_profiles
       SET total_points = $1,
           monthly_points = $2,
           level = $3,
           ${activityCounterColumn} = ${activityCounterColumn} + 1,
           last_activity_date = NOW()
       WHERE user_id = $4
       RETURNING *`,
      [newTotalPoints, newMonthlyPoints, newLevel, userId]
    );
    const updatedProfile = updateProfileResult.rows[0];

    // Record AdaptaBits transaction
    await client.query(
      `INSERT INTO points_transactions (user_id, points, reason, opportunity_id, session_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, pointsAwarded, `Approved completion of ${opportunityType} opportunity`, opportunityId, sessionId]
    );

    // Check for and award achievements
    const allAchievementsResult = await client.query<Achievement>('SELECT * FROM achievements');
    const allAchievements = allAchievementsResult.rows;

    for (const achievement of allAchievements) {
      // Check if user already has this achievement
      const userHasAchievement = await client.query(
        'SELECT 1 FROM user_achievements WHERE user_id = $1 AND achievement_id = $2',
        [userId, achievement.id]
      );

      if (userHasAchievement.rows.length === 0) {
        let shouldAward = false;

        // Logic for different achievement categories
        if (achievement.category === 'participation' && achievement.name === 'First Steps') {
          if (updatedProfile.sessions_completed + updatedProfile.surveys_completed + updatedProfile.polls_completed + updatedProfile.questions_completed >= 1) {
            shouldAward = true;
          }
        } else if (achievement.category === 'milestone') {
          if (achievement.name === 'Test Taker' && updatedProfile.sessions_completed >= 5) {
            shouldAward = true;
          } else if (achievement.name === 'Survey Master' && updatedProfile.surveys_completed >= 3) {
            shouldAward = true;
          } else if (achievement.name === 'Poll Participant' && updatedProfile.polls_completed >= 2) {
            shouldAward = true;
          } else if (achievement.name === 'Question Answerer' && updatedProfile.questions_completed >= 5) {
            shouldAward = true;
          } else if (achievement.name === 'Research Enthusiast' && newTotalPoints >= achievement.points_required) {
            shouldAward = true;
          }
        } else if (achievement.category === 'special') {
          if (achievement.name === 'AdaptaLabs Legend' && newTotalPoints >= achievement.points_required) {
            shouldAward = true;
          }
        }

        if (shouldAward) {
          await client.query(
            'INSERT INTO user_achievements (user_id, achievement_id) VALUES ($1, $2)',
            [userId, achievement.id]
          );
          console.info('User earned achievement', { userId, achievementName: achievement.name });
        }
      }
    }

    await client.query('COMMIT');

    return {
      points: pointsAwarded,
      newLevel: updatedProfile.level,
      levelUp: newLevel > userProfile.level,
      totalPoints: updatedProfile.total_points,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error awarding points after approval:', error);
    throw new Error('Failed to award points after approval');
  } finally {
    client.release();
  }
}
