import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';

/**
 * GET /api/gamification/leaderboard
 * Get global leaderboard (top users by total AdaptaBits)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const limit = parseInt(req.query.limit as string) || 10;

    const pool = getPool();

    const result = await pool.query(`
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

    // Serialize for response
    const leaderboard = result.rows.map(row => ({
      user_id: row.user_id,
      name: row.name,
      total_points: parseInt(row.total_points) || 0,
      monthly_points: parseInt(row.monthly_points) || 0,
      level: parseInt(row.level) || 1,
      rank: parseInt(row.rank) || 0,
    }));

    return res.status(200).json(leaderboard);

  } catch (error: any) {
    console.error('Error fetching leaderboard:', error);
    return res.status(500).json({
      error: 'Failed to fetch leaderboard',
      details: error.message,
    });
  }
}

