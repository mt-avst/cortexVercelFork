import { Router, Request, Response, IRouter } from 'express';
import { requireAuth } from '../middleware/authenticate';
import { asyncHandler } from '../utils/errorHandler';
import { pool } from '../config';
import { userCalendarService } from '../services/userCalendar';
import { CalendarEvent } from '../../../shared/types';
import { logger } from '../utils/logger';
import {
  validateQuery,
  oauthCallbackQuerySchema,
  userCalendarEventsQuerySchema,
} from '../validation/schemas';

const router: IRouter = Router();

// NOTE: /auth/connect route removed - calendar is now automatically connected during login
// If manual connection is needed in the future, this route can be restored

/**
 * GET /api/calendar/auth/callback
 * Handle Google OAuth callback
 * Stores encrypted tokens in database and redirects to frontend
 */
// `validateQuery` (#43): an array `state` compared with `!==` against the
// session's stored state is always unequal, and an array `code` is truthy
// past the missing-code check and lands in the token exchange.
router.get('/auth/callback', requireAuth, validateQuery(oauthCallbackQuerySchema), asyncHandler(async (req: Request, res: Response) => {
  const dbClient = await pool.connect();
  
  try {
    const code = req.query.code as string;
    const state = req.query.state as string;
    interface SessionWithGoogleState {
      googleOAuthState?: string;
    }
    const sessionState = (req.session as SessionWithGoogleState).googleOAuthState;
    
    // In demo mode, code might not be present - handle gracefully
    if (!code && userCalendarService.isInDemoMode()) {
      logger.debug('Demo mode: Handling callback without code');
      // For demo mode, we'll just mark as connected with mock tokens
    } else if (!code) {
      return res.status(400).json({ error: 'Authorization code missing' });
    }

    // Verify state (optional in demo mode)
    if (state && sessionState && state !== sessionState) {
      return res.status(400).json({ error: 'Invalid state parameter' });
    }

    const userId = req.session.user!.id;
    
    // Get tokens (mock in demo mode, real in production)
    const { accessToken, refreshToken, expiryDate } = await userCalendarService.getTokens(
      code || 'demo-code'
    );
    
    // Encrypt tokens before storing
    const encryptedAccessToken = userCalendarService.encrypt(accessToken);
    const encryptedRefreshToken = refreshToken 
      ? userCalendarService.encrypt(refreshToken) 
      : null;
    
    // Store tokens in database
    await dbClient.query(`
      INSERT INTO user_calendar_tokens (
        user_id, access_token, refresh_token, expires_at, 
        token_type, scope, connected_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (user_id) 
      DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_at = EXCLUDED.expires_at,
        last_refreshed_at = NOW()
    `, [
      userId,
      encryptedAccessToken,
      encryptedRefreshToken,
      expiryDate,
      'Bearer',
      'https://www.googleapis.com/auth/calendar.readonly',
    ]);

    // Clear state from session
    delete (req.session as any).googleOAuthState;

    // Redirect to frontend success page
    const frontendUrl = process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/opportunities?calendar=connected`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error handling OAuth callback', { error });
    const frontendUrl = process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/opportunities?calendar=error&message=${encodeURIComponent(errorMessage)}`);
  } finally {
    dbClient.release();
  }
}));

/**
 * GET /api/calendar/my-events
 * Get user's calendar events for a date range
 * Returns events that might conflict with session bookings
 */
// `validateQuery` (#43): the two casts below are true only because it has run.
router.get('/my-events', requireAuth, validateQuery(userCalendarEventsQuerySchema), asyncHandler(async (req: Request, res: Response) => {
  const dbClient = await pool.connect();
  
  try {
    const userId = req.session.user!.id;
    const startTime = req.query.start_time as string;
    const endTime = req.query.end_time as string;

    if (!startTime || !endTime) {
      return res.status(400).json({ 
        error: 'start_time and end_time query parameters are required' 
      });
    }

    // Validate date format
    const start = new Date(startTime);
    const end = new Date(endTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ 
        error: 'Invalid date format. Use ISO 8601 format.' 
      });
    }

    if (start >= end) {
      return res.status(400).json({ 
        error: 'start_time must be before end_time' 
      });
    }

    // Get user's stored tokens
    const tokenResult = await dbClient.query(
      'SELECT access_token, refresh_token, expires_at FROM user_calendar_tokens WHERE user_id = $1',
      [userId]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Calendar not connected',
        connected: false 
      });
    }

    const { access_token, refresh_token, expires_at } = tokenResult.rows[0];
    
    // Check if token needs refresh
    let accessToken = userCalendarService.decrypt(access_token);
    const expiresAt = expires_at ? new Date(expires_at) : null;
    
    // Refresh token if expired and refresh_token exists
    if (expiresAt && expiresAt < new Date() && refresh_token) {
      try {
        const refreshToken = userCalendarService.decrypt(refresh_token);
        const { accessToken: newAccessToken, expiryDate } = 
          await userCalendarService.refreshAccessToken(refreshToken);
        
        accessToken = newAccessToken;
        
        // Update database with new token
        const encryptedAccessToken = userCalendarService.encrypt(newAccessToken);
        await dbClient.query(
          'UPDATE user_calendar_tokens SET access_token = $1, expires_at = $2, last_refreshed_at = NOW() WHERE user_id = $3',
          [encryptedAccessToken, expiryDate, userId]
        );
      } catch (refreshError: any) {
        logger.error('Error refreshing token', { error: refreshError });
        // Continue with old token - might still work
      }
    }

    // Fetch calendar events (returns mock in demo mode, real in production)
    // Pass userId to generate user-specific conflicts (Demo User 1 gets specific conflicts)
    const events = await userCalendarService.getUserCalendarEvents(
      accessToken,
      startTime,
      endTime,
      userId
    );

    res.json(events);
  } catch (error: unknown) {
    logger.error('Error fetching user calendar events', { error });
    
    const errorMessage = error instanceof Error ? error.message : '';
    if (errorMessage.includes('401') || errorMessage.includes('unauthorized')) {
      // Token invalid, user needs to reconnect
      return res.status(401).json({ 
        error: 'Calendar connection expired. Please reconnect.',
        connected: false 
      });
    }
    
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  } finally {
    dbClient.release();
  }
}));

/**
 * GET /api/calendar/connection-status
 * Check if user's calendar is connected
 */
router.get('/connection-status', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const dbClient = await pool.connect();
  
  try {
    const userId = req.session.user!.id;
    const result = await dbClient.query(
      'SELECT connected_at FROM user_calendar_tokens WHERE user_id = $1',
      [userId]
    );

    res.json({ 
      connected: result.rows.length > 0,
      connectedAt: result.rows[0]?.connected_at || null,
    });
  } catch (error: unknown) {
    logger.error('Error checking connection status', { error });
    res.status(500).json({ error: 'Failed to check connection status' });
  } finally {
    dbClient.release();
  }
}));

/**
 * DELETE /api/calendar/disconnect
 * Disconnect user's calendar and remove tokens
 */
router.delete('/disconnect', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const dbClient = await pool.connect();
  
  try {
    const userId = req.session.user!.id;
    await dbClient.query(
      'DELETE FROM user_calendar_tokens WHERE user_id = $1',
      [userId]
    );

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('Error disconnecting calendar', { error });
    res.status(500).json({ error: 'Failed to disconnect calendar' });
  } finally {
    dbClient.release();
  }
}));

export default router;

