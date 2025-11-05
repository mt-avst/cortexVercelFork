import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { createErrorResponse, getErrorMessage } from '../utils/errors';
import { parseSessionCookie } from '../utils/auth';
import { logger } from '../utils/logger';

/**
 * GET /api/calendar/connection-status
 * Check if user's calendar is connected
 * Returns: { connected: boolean, connectedAt: string | null }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

    const user = parseSessionCookie(req);
    if (!user) {
      return res.status(401).json(createErrorResponse('Authentication required'));
    }

    const userId = user.id;

    // Check if user has calendar tokens
    const result = await query(
      'SELECT connected_at FROM user_calendar_tokens WHERE user_id = $1',
      [userId]
    ).catch((error) => {
      logger.error('Database query error in connection-status', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      // Return empty result on error - don't fail the request
      return { rows: [] };
    });

    return res.status(200).json({
      connected: result.rows.length > 0,
      connectedAt: result.rows[0]?.connected_at ? new Date(result.rows[0].connected_at).toISOString() : null,
    });
  } catch (error: unknown) {
    logger.error('Error checking connection status', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // Return a safe default instead of 500 to allow frontend to continue
    return res.status(200).json({
      connected: false,
      connectedAt: null,
    });
  }
}

