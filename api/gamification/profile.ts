import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';

/**
 * GET /api/gamification/profile
 * Get user's AdaptaBits profile
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get authenticated user from cookie
    const cookies = req.headers.cookie || '';
    const cookiePairs = cookies.split(';').map(c => c.trim());
    let sessionData: string | null = null;

    // Find session cookie (check from end to get most recent)
    for (let i = cookiePairs.length - 1; i >= 0; i--) {
      const pair = cookiePairs[i];
      if (pair.startsWith('adaptalabs_session=')) {
        sessionData = pair.substring('adaptalabs_session='.length);
        break;
      }
    }

    if (!sessionData) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Parse user from cookie
    let user: any;
    try {
      let decodedData: string;
      try {
        decodedData = decodeURIComponent(sessionData);
        if (decodedData === sessionData && sessionData.startsWith('{')) {
          decodedData = sessionData;
        }
      } catch {
        decodedData = sessionData;
      }
      user = JSON.parse(decodedData);
    } catch (error) {
      console.error('Error parsing session:', error);
      return res.status(401).json({ error: 'Invalid session' });
    }

    if (!user.id) {
      return res.status(401).json({ error: 'Invalid session - missing user ID' });
    }

    const userId = user.id;
    const pool = getPool();

    // Get or create user profile
    let profileResult = await pool.query(`
      SELECT * FROM user_profiles WHERE user_id = $1
    `, [userId]);

    let profile: any;
    if (profileResult.rows.length === 0) {
      // Create new profile
      const createResult = await pool.query(`
        INSERT INTO user_profiles (user_id) 
        VALUES ($1) 
        RETURNING *
      `, [userId]);
      profile = createResult.rows[0];
    } else {
      profile = profileResult.rows[0];
    }

    // Get completion counts by opportunity type
    // Only count approved completions (these are the ones that award AdaptaBits)
    let completionCounts;
    try {
      completionCounts = await pool.query(`
        SELECT 
          o.type,
          COUNT(*) as count
        FROM bookings b
        JOIN sessions s ON b.session_id = s.id
        JOIN opportunities o ON s.opportunity_id = o.id
        WHERE b.user_id = $1 AND b.completion_status = 'approved'
        GROUP BY o.type
      `, [userId]);
    } catch (queryError: any) {
      // If completion_status column doesn't exist yet, fall back to empty counts
      console.warn('Error querying completion counts (completion_status column may not exist):', queryError.message);
      completionCounts = { rows: [] };
    }

    // Initialize counts
    let sessions_completed = 0;
    let surveys_completed = 0;
    let polls_completed = 0;
    let questions_completed = 0;

    // Map counts by type
    completionCounts.rows.forEach((row: any) => {
      const count = parseInt(row.count);
      switch (row.type) {
        case 'test':
        case 'interview':
          sessions_completed += count;
          break;
        case 'survey':
          surveys_completed += count;
          break;
        case 'poll':
          polls_completed += count;
          break;
        case 'question':
          questions_completed += count;
          break;
      }
    });

    // Ensure profile has all required fields with defaults
    const profileData = {
      id: profile.id,
      user_id: profile.user_id || userId,
      total_points: parseInt(profile.total_points) || 0,
      monthly_points: parseInt(profile.monthly_points) || 0,
      level: parseInt(profile.level) || 1,
      sessions_completed: parseInt(profile.sessions_completed) || 0,
      surveys_completed: parseInt(profile.surveys_completed) || 0,
      polls_completed: parseInt(profile.polls_completed) || 0,
      questions_completed: parseInt(profile.questions_completed) || 0,
      last_activity_date: profile.last_activity_date || null,
      created_at: profile.created_at || new Date(),
      updated_at: profile.updated_at || new Date(),
    };

    // Update profile with completion counts if they don't match
    if (profileData.sessions_completed !== sessions_completed ||
        profileData.surveys_completed !== surveys_completed ||
        profileData.polls_completed !== polls_completed ||
        profileData.questions_completed !== questions_completed) {
      try {
        await pool.query(`
          UPDATE user_profiles
          SET sessions_completed = $1,
              surveys_completed = $2,
              polls_completed = $3,
              questions_completed = $4,
              updated_at = NOW()
          WHERE user_id = $5
        `, [sessions_completed, surveys_completed, polls_completed, questions_completed, userId]);
        
        profileData.sessions_completed = sessions_completed;
        profileData.surveys_completed = surveys_completed;
        profileData.polls_completed = polls_completed;
        profileData.questions_completed = questions_completed;
      } catch (updateError) {
        console.error('Error updating profile completion counts:', updateError);
        // Don't fail if update fails, just log it
      }
    }

    // Serialize dates - handle both Date objects and strings
    const serializeDate = (date: any): string | null => {
      if (!date) return null;
      if (date instanceof Date) {
        return date.toISOString();
      }
      if (typeof date === 'string') {
        return date;
      }
      try {
        return new Date(date).toISOString();
      } catch {
        return null;
      }
    };

    const response = {
      id: profileData.id,
      user_id: profileData.user_id,
      total_points: profileData.total_points,
      monthly_points: profileData.monthly_points,
      level: profileData.level,
      sessions_completed: profileData.sessions_completed,
      surveys_completed: profileData.surveys_completed,
      polls_completed: profileData.polls_completed,
      questions_completed: profileData.questions_completed,
      last_activity_date: serializeDate(profileData.last_activity_date),
      created_at: serializeDate(profileData.created_at) || new Date().toISOString(),
      updated_at: serializeDate(profileData.updated_at) || new Date().toISOString(),
    };

    return res.status(200).json(response);

  } catch (error: any) {
    console.error('Error fetching user profile:', error);
    console.error('Error stack:', error.stack);
    return res.status(500).json({
      error: 'Failed to fetch profile',
      details: error.message || 'Unknown error',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
}

