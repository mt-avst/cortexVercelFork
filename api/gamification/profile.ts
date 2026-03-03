import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';
import { requireAuth } from '../utils/auth';
import { createErrorResponse, createSafeErrorResponse, getErrorMessage } from '../utils/errors';
import { parseIntSafe, serializeDate, serializeRow } from '../utils/helpers';
import { logger } from '../utils/logger';

/**
 * GET /api/gamification/profile
 * Get user's AdaptaBits profile
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    // Get authenticated user from cookie
    const user = requireAuth(req);
    const userId = user.id;
    
    // Check if database is configured before attempting connection
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
      logger.error('DATABASE_URL or POSTGRES_URL environment variable is not set');
      return res.status(503).json(createErrorResponse(
        'Database connection not configured. Please set DATABASE_URL environment variable.'
      ));
    }
    
    const pool = getPool();

    // Get or create user profile
    let profileResult = await pool.query(`
      SELECT * FROM user_profiles WHERE user_id = $1
    `, [userId]);

    let profile: Record<string, unknown>;
    if (profileResult.rows.length === 0) {
      // Create new profile
      const createResult = await pool.query(`
        INSERT INTO user_profiles (user_id) 
        VALUES ($1) 
        RETURNING *
      `, [userId]);
      profile = createResult.rows[0] as Record<string, unknown>;
    } else {
      profile = profileResult.rows[0] as Record<string, unknown>;
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
    } catch (queryError: unknown) {
      // If completion_status column doesn't exist yet, fall back to empty counts
      const error = queryError as { message?: string; code?: string };
      logger.warn('Error querying completion counts (completion_status column may not exist)', {
        error: error.message || String(queryError),
        code: error.code,
      });
      completionCounts = { rows: [] };
    }

    // Initialize counts
    let sessions_completed = 0;
    let surveys_completed = 0;
    let polls_completed = 0;
    let questions_completed = 0;

    // Map counts by type
    completionCounts.rows.forEach((row: Record<string, unknown>) => {
      const count = parseInt(String(row.count || '0'), 10);
      const type = String(row.type || '');
      switch (type) {
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
      total_points: parseIntSafe(profile.total_points, 0),
      monthly_points: parseIntSafe(profile.monthly_points, 0),
      level: parseIntSafe(profile.level, 1),
      sessions_completed: parseIntSafe(profile.sessions_completed, 0),
      surveys_completed: parseIntSafe(profile.surveys_completed, 0),
      polls_completed: parseIntSafe(profile.polls_completed, 0),
      questions_completed: parseIntSafe(profile.questions_completed, 0),
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
        // Don't fail if update fails, just continue with existing values
      }
    }

    // Serialize dates using helper
    const response = serializeRow(profileData, [
      'last_activity_date',
      'created_at',
      'updated_at'
    ]);

    // Ensure dates are never null (provide defaults)
    if (!response.created_at) {
      response.created_at = new Date().toISOString();
    }
    if (!response.updated_at) {
      response.updated_at = new Date().toISOString();
    }

    return res.status(200).json(response);

  } catch (error: unknown) {
    // Handle auth errors
    if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
      return res.status(401).json(createErrorResponse(
        typeof error === 'object' && 'error' in error 
          ? String(error.error) 
          : 'Not authenticated'
      ));
    }

    // Log the full error for debugging
    logger.error('Error fetching user profile', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: req.headers.cookie ? 'present' : 'missing',
    });

    const errorMessage = getErrorMessage(error);
    
    // Provide more specific error messages
    let userFriendlyMessage = 'Failed to fetch profile';
    if (errorMessage.includes('DATABASE_URL') || errorMessage.includes('POSTGRES_URL')) {
      userFriendlyMessage = 'Database connection not configured';
    } else if (errorMessage.includes('connection') || errorMessage.includes('connect')) {
      userFriendlyMessage = 'Unable to connect to the database';
    } else if (errorMessage) {
      userFriendlyMessage = errorMessage;
    }
    
    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: userFriendlyMessage })
    );
  }
}

