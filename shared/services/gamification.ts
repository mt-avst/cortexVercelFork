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

export interface LeaderboardEntry {
  user_id: string;
  name: string;
  total_points: number;
  monthly_points: number;
  level: number;
  rank: number;
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
 */
export async function getLeaderboard(pool: Pool, limit: number = 10): Promise<LeaderboardEntry[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT
        up.user_id,
        u.name,
        up.total_points,
        up.monthly_points,
        up.level,
        ROW_NUMBER() OVER (ORDER BY up.total_points DESC) as rank
      FROM user_profiles up
      JOIN users u ON up.user_id = u.id
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
 */
export async function getMonthlyLeaderboard(pool: Pool, limit: number = 10): Promise<LeaderboardEntry[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT
        up.user_id,
        u.name,
        up.total_points,
        up.monthly_points,
        up.level,
        ROW_NUMBER() OVER (ORDER BY up.monthly_points DESC) as rank
      FROM user_profiles up
      JOIN users u ON up.user_id = u.id
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
 * Get AdaptaBits transaction history for user
 */
export async function getPointsHistory(pool: Pool, userId: string, limit: number = 20): Promise<PointsTransaction[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT * FROM points_transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [userId, limit]);

    return result.rows;
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
