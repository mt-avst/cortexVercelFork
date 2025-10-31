import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';
import { createErrorResponse, getErrorMessage } from '../utils/errors';
import { generateDummyLeaderboard } from './utils';

/**
 * GET /api/gamification/leaderboard
 * Get global leaderboard (top users by total AdaptaBits)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
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
    } catch (queryError: unknown) {
      // If query fails (e.g., no tables yet), return dummy data
      console.warn('Error querying real leaderboard, returning dummy data:', getErrorMessage(queryError));
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

  } catch (error: unknown) {
    console.error('Error fetching leaderboard:', error);
    // If everything fails, return dummy data
    const limit = parseInt(req.query?.limit as string) || 20;
    const dummyData = generateDummyLeaderboard(limit, 'total');
    return res.status(200).json(dummyData);
  }
}

