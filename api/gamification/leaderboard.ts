import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';

interface LeaderboardEntry {
  user_id: string;
  name: string;
  total_points: number;
  monthly_points: number;
  level: number;
  rank: number;
}

/**
 * Generate dummy leaderboard data for demonstration purposes
 */
function generateDummyLeaderboard(limit: number, type: 'total' | 'monthly'): LeaderboardEntry[] {
  const dummyUsers = [
    { name: 'Alex Chen', total: 1250, monthly: 180, level: 8 },
    { name: 'Sarah Johnson', total: 980, monthly: 150, level: 7 },
    { name: 'Marcus Rodriguez', total: 850, monthly: 120, level: 6 },
    { name: 'Emma Thompson', total: 720, monthly: 95, level: 6 },
    { name: 'David Kim', total: 650, monthly: 85, level: 5 },
    { name: 'Lisa Wang', total: 580, monthly: 75, level: 5 },
    { name: 'James Wilson', total: 520, monthly: 65, level: 4 },
    { name: 'Maria Garcia', total: 480, monthly: 55, level: 4 },
    { name: 'Tom Anderson', total: 420, monthly: 45, level: 4 },
    { name: 'Rachel Brown', total: 380, monthly: 40, level: 3 },
    { name: 'Kevin Lee', total: 340, monthly: 35, level: 3 },
    { name: 'Amy Davis', total: 300, monthly: 30, level: 3 },
    { name: 'Chris Taylor', total: 270, monthly: 25, level: 3 },
    { name: 'Jessica Miller', total: 240, monthly: 20, level: 2 },
    { name: 'Ryan Clark', total: 200, monthly: 15, level: 2 },
    { name: 'Michelle White', total: 170, monthly: 12, level: 2 },
    { name: 'Daniel Moore', total: 140, monthly: 10, level: 2 },
    { name: 'Jennifer Hall', total: 120, monthly: 8, level: 2 },
    { name: 'Robert Young', total: 100, monthly: 6, level: 1 },
    { name: 'Laura King', total: 80, monthly: 4, level: 1 }
  ];

  // Sort by the appropriate metric
  const sortedUsers = dummyUsers.sort((a, b) => {
    if (type === 'total') {
      return b.total - a.total;
    } else {
      return b.monthly - a.monthly;
    }
  });

  // Return the requested number of users with proper ranking
  return sortedUsers.slice(0, limit).map((user, index) => ({
    user_id: `dummy-${index + 1}`,
    name: user.name,
    total_points: user.total,
    monthly_points: user.monthly,
    level: user.level,
    rank: index + 1
  }));
}

/**
 * GET /api/gamification/leaderboard
 * Get global leaderboard (top users by total AdaptaBits)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const limit = parseInt(req.query.limit as string) || 20;

    const pool = getPool();

    let result;
    try {
      result = await pool.query(`
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
    } catch (queryError: any) {
      // If query fails (e.g., no tables yet), return dummy data
      console.warn('Error querying real leaderboard, returning dummy data:', queryError.message);
      const dummyData = generateDummyLeaderboard(limit, 'total');
      return res.status(200).json(dummyData);
    }

    // Serialize for response
    const realLeaderboard = result.rows.map(row => ({
      user_id: row.user_id,
      name: row.name,
      total_points: parseInt(row.total_points) || 0,
      monthly_points: parseInt(row.monthly_points) || 0,
      level: parseInt(row.level) || 1,
      rank: parseInt(row.rank) || 0,
    }));

    // If fewer than the requested limit, supplement with dummy data
    if (realLeaderboard.length < limit) {
      const dummyData = generateDummyLeaderboard(limit, 'total');
      
      // If no real users, return all dummy data
      if (realLeaderboard.length === 0) {
        return res.status(200).json(dummyData);
      }
      
      // Merge real users with dummy data, avoiding duplicates
      const mergedData = [...realLeaderboard];
      const existingUserIds = new Set(realLeaderboard.map(row => row.user_id));
      let dummyRank = realLeaderboard.length + 1;
      
      for (const dummyUser of dummyData) {
        if (mergedData.length >= limit) break;
        if (!existingUserIds.has(dummyUser.user_id)) {
          mergedData.push({
            ...dummyUser,
            rank: dummyRank++
          });
        }
      }
      
      return res.status(200).json(mergedData);
    }

    return res.status(200).json(realLeaderboard);

  } catch (error: any) {
    console.error('Error fetching leaderboard:', error);
    // If everything fails, return dummy data
    const limit = parseInt(req.query?.limit as string) || 20;
    const dummyData = generateDummyLeaderboard(limit, 'total');
    return res.status(200).json(dummyData);
  }
}

