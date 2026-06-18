import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from './db';
import { requireAdmin, assertOwnerOrSuperadmin, handleAuthError } from './utils/auth';
import { createErrorResponse, createSafeErrorResponse } from './utils/errors';
import { logger } from './utils/logger';

/**
 * POST /api/sessions
 * Creates sessions for an opportunity
 * 
 * Request body:
 * {
 *   opportunity_id: string,
 *   sessions: Array<{
 *     start_time: string,
 *     end_time: string,
 *     capacity?: number,
 *     location_or_meet_link_optional?: string
 *   }>
 * }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    // Creating sessions requires an authenticated admin who owns the opportunity.
    let user;
    try {
      user = requireAdmin(req);
    } catch (authErr) {
      if (handleAuthError(res, authErr)) return;
      throw authErr;
    }

    const { opportunity_id, sessions } = req.body;

    if (!opportunity_id) {
      logger.error('Missing opportunity_id in request body');
      return res.status(400).json(createErrorResponse('opportunity_id is required'));
    }

    if (!Array.isArray(sessions) || sessions.length === 0) {
      logger.error('Invalid sessions array', { sessionsType: typeof sessions });
      return res.status(400).json(createErrorResponse('sessions array is required and must not be empty'));
    }

    // Validate opportunity exists and the caller owns it (or is superadmin)
    const oppCheck = await query(
      `SELECT id, owner_user_id FROM opportunities WHERE id = $1`,
      [opportunity_id]
    );

    if (oppCheck.rows.length === 0) {
      logger.error('Opportunity not found', { opportunity_id });
      return res.status(404).json(createErrorResponse('Opportunity not found'));
    }

    try {
      const ownerId = (oppCheck.rows[0] as { owner_user_id: string }).owner_user_id;
      assertOwnerOrSuperadmin(user, ownerId);
    } catch (authErr) {
      if (handleAuthError(res, authErr)) return;
      throw authErr;
    }

    // Validate session data
    for (const session of sessions) {
      if (!session.start_time || !session.end_time) {
        return res.status(400).json(createErrorResponse('start_time and end_time are required for each session'));
      }
    }
    
    // Insert sessions into database
    const createdSessions = [];
    for (const session of sessions) {
      try {
        const result = await query(
          `INSERT INTO sessions (
            opportunity_id,
            start_time,
            end_time,
            capacity,
            booked_count,
            location_or_meet_link_optional
          ) VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *`,
          [
            opportunity_id,
            session.start_time,
            session.end_time,
            session.capacity || 1,
            0, // booked_count starts at 0
            session.location_or_meet_link_optional || null,
          ]
        );
        
        const created = result.rows[0] as any;
        createdSessions.push({
          ...created,
          start_time: created.start_time.toISOString(),
          end_time: created.end_time.toISOString(),
          created_at: created.created_at.toISOString(),
          updated_at: created.updated_at.toISOString(),
          remaining: created.capacity - created.booked_count,
        });
      } catch (dbError: unknown) {
        logger.error('Database error inserting session', {
          errorMessage: dbError instanceof Error ? dbError.message : String(dbError),
          opportunity_id,
        });
        throw dbError;
      }
    }
    
    return res.status(201).json(createdSessions);
  } catch (error: unknown) {
    logger.error('Error creating sessions', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Internal server error' })
    );
  }
}


