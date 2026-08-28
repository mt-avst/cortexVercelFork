import { Router, Request, Response, IRouter } from 'express';
import type { PoolClient } from 'pg';
import { requireAuth } from '../middleware/authenticate';
import { asyncHandler } from '../utils/errorHandler';
import { pool, config } from '../config';
import { userCalendarService } from '../services/userCalendar';
import { CalendarEvent } from '../../../shared/types';
import { logger } from '../utils/logger';
import { createOAuthStateGuard } from '../utils/oauthState';
import { perUserLimiter } from '../middleware/per-user-rate-limit';
import {
  validateQuery,
  oauthCallbackQuerySchema,
  userCalendarEventsQuerySchema,
} from '../validation/schemas';

const router: IRouter = Router();

/**
 * Single-use, browser-bound `state` for the calendar-connect flow.
 *
 * Its OWN cookie and its OWN store, deliberately separate from the login flow's
 * (utils/oauthState.ts explains why): a state minted to connect a calendar must
 * not be substitutable for one that establishes a session.
 */
interface CalendarOAuthFlow {
  /** Whose calendar this flow is connecting. See the callback for why. */
  userId: string;
}

// Bare name in, prefixed cookie out: the guard applies the `__Host-` prefix
// (#94), so the cookie on the wire is `__Host-adaptalabs_calendar_oauth_state`.
const calendarOAuthState = createOAuthStateGuard<CalendarOAuthFlow>({
  cookieName: 'adaptalabs_calendar_oauth_state',
});

/**
 * WHICH calendar OAuth flow may be started here, in ONE place.
 *
 * `real`         - a Google OAuth client is configured; the genuine flow runs.
 * `demo`         - no client, but this is a developer's machine. `getAuthUrl`
 *                  returns a URL pointing back at our own callback with
 *                  `code=demo`, the callback mints demo tokens, and
 *                  `generateMockEvents` produces busy time aligned with the
 *                  demo sessions. A complete working flow with no credentials,
 *                  which is what this route was for before v2.5.1 deleted it.
 * `unavailable`  - no client, and not a developer's machine. Refused, because
 *                  those demo tokens are FABRICATED: a researcher would connect
 *                  successfully and then trust invented busy time, which is
 *                  worse than being offered nothing.
 *
 * ONE function because the first version of this had the connect route and the
 * callback deciding it SEPARATELY, and they disagreed - the route refused demo
 * mode always, the callback permitted it in development. Neither was wrong on
 * its own; the pair was incoherent, and a developer could not start a flow
 * locally at all. `agrees with the callback about when a demo flow is allowed`
 * is the test that fails if they ever drift again.
 *
 * `config.NODE_ENV` rather than `process.env`: it is a zod enum with three
 * members, so a typo in the environment cannot widen the permissive branch.
 */
type CalendarOAuthMode = 'real' | 'demo' | 'unavailable';

const calendarOAuthMode = (): CalendarOAuthMode => {
  if (!userCalendarService.isInDemoMode()) return 'real';
  return config.NODE_ENV === 'development' ? 'demo' : 'unavailable';
};

/**
 * Whether a flow can be started at all - what the UI needs in order to decide
 * whether to render a Connect control. It must mean exactly "the connect route
 * will not 503", or a developer gets no button locally and a production user
 * gets a dead one.
 */
const calendarOAuthAvailable = (): boolean => calendarOAuthMode() !== 'unavailable';

/**
 * How many calendar-connect flows one user may start per minute.
 *
 * `/auth/connect` is a state-MINTING route: every call allocates a store entry
 * that lives for up to one TTL, on a single-replica pod, and `/api/*` carries no
 * limiter of its own. Measured at 173 bytes per state, an unrated caller can
 * push tens of megabytes a second into that map.
 *
 * Ten a minute is generous for the real behaviour - a researcher connects a
 * calendar approximately once - and the store also has its own hard bound with
 * oldest-first eviction, so this is the outer of two independent limits rather
 * than the only one. Per-user rather than per-IP because the route requires a
 * session, and behind two proxy hops an IP bucket is shared by the whole estate.
 */
const calendarConnectLimiter = perUserLimiter(
  10,
  'Too many calendar connection attempts. Please wait a minute and try again.'
);

/**
 * GET /api/calendar/auth/connect
 * Start the Google OAuth flow for this user's own calendar.
 *
 * Restored for cto/AdaptaLabs#89. This route was deleted in v2.5.1 on the
 * belief that "calendar is now automatically connected during login" - which
 * was true only of the Google login path. Production logs in via Okta/OIDC and
 * Google OAuth is in demo mode there, so `GET /api/calendar/connection-status`
 * has answered `{"connected":false}` for every production user since, with no
 * way for anyone to change that. `userCalendarService.getAuthUrl` has sat here
 * with no caller ever since.
 *
 * cto/AdaptaLabs#87 proposes deleting the `/auth/callback` below as orphaned.
 * It is not orphaned any more: it is the second half of THIS flow.
 */
// The limiter is mounted AFTER requireAuth, deliberately: mounted first it
// would spend a bucket on unauthenticated requests and `req.user` would be
// absent, collapsing every caller into one shared bucket.
router.get('/auth/connect', requireAuth, calendarConnectLimiter, asyncHandler(async (req: Request, res: Response) => {
  const mode = calendarOAuthMode();

  if (mode === 'unavailable') {
    logger.info('Refusing to start a calendar OAuth flow: no OAuth client is configured', {
      userId: req.session.user!.id,
      nodeEnv: config.NODE_ENV,
    });
    return res.status(503).json({
      error: 'Calendar connection is not configured on this deployment',
      code: 'CALENDAR_OAUTH_NOT_CONFIGURED',
    });
  }

  if (mode === 'demo') {
    // No state issued: the demo callback does not consume one, so minting it
    // would leave an entry in the store and a cookie in the jar for a full TTL
    // for nothing. The demo callback identifies the user from the session, which
    // it CAN read - unlike the real one, this redirect never leaves our origin.
    logger.info('Starting a DEMO calendar flow (development only, no Google client configured)', {
      userId: req.session.user!.id,
    });
    return res.redirect(userCalendarService.getAuthUrl());
  }

  // The real flow. The user is bound to the STATE, server-side, because the
  // callback cannot read the session - see the callback below.
  const state = calendarOAuthState.issue(res, { userId: req.session.user!.id });
  return res.redirect(userCalendarService.getAuthUrl(state));
}));

/**
 * GET /api/calendar/auth/callback
 * Handle Google OAuth callback
 * Stores encrypted tokens in database and redirects to frontend
 */
// `validateQuery` (#43): an array `code` is truthy past the missing-code check
// below and would otherwise land in the token exchange, so the validator
// refuses a non-string `code` shape at the boundary. `state` is validated for
// shape too, and is now READ - see the state check in the handler (#89).
//
// NO `requireAuth`, and that is the point (cto/AdaptaLabs#89).
//
// This route is entered by a TOP-LEVEL NAVIGATION redirected from
// accounts.google.com, and the app session cookie is `SameSite=Strict` in
// production (index.ts) - browsers compute SameSite across the whole redirect
// chain, so a Strict cookie is withheld on arrival here. `requireAuth` would
// therefore answer 401 AFTER the researcher had already granted Google access:
// a live grant at Google, no token row, and no way to tell why. That is #89's
// own symptom - "the calendar is inert in production" - under a new cause, and
// no test in this repo could have seen it, because every route test injects
// `req.session` directly.
//
// So the OAuth state IS the authenticator. `/auth/connect` binds the initiating
// user's id to the state server-side; the state cookie is deliberately
// `SameSite=Lax`, which DOES ride a top-level GET redirect. The handler takes
// the user from the consumed state and never from the session.
//
// That is strictly stronger than trusting the session would have been: an
// attacker who mints a state and lures a victim here fails the browser binding,
// and even if it passed, the payload names the ATTACKER, so their tokens land on
// their own row rather than the victim's.
router.get('/auth/callback', validateQuery(oauthCallbackQuerySchema), asyncHandler(async (req: Request, res: Response) => {
  /*
   * The pool connection is taken LATE, after the state check and after the
   * token exchange, and this ordering is load-bearing.
   *
   * `pool.connect()` used to be this handler's first line. That was survivable
   * while the route required a session; it is not now that the route is
   * unauthenticated by design, for two reasons that compound:
   *
   *   - an anonymous caller reached a pool checkout on every request, before any
   *     refusal, and there is no rate limiter under /api
   *   - the connection was then HELD across `getTokens`, an outbound fetch to
   *     Google with no AbortSignal, so undici's 300s default is the only bound.
   *     `pool.options.max` is pg's default 10, and POOL_STATEMENT_TIMEOUT_MS
   *     bounds queries rather than checkouts - so ten stalled flows wedge the
   *     whole backend, not just this route.
   *
   * routes/auth.ts already does it in this order (state check, then exchange,
   * then connect), so this is the shape the repo had settled on.
   */
  let dbClient: PoolClient | undefined;

  try {
    const code = req.query.code as string;

    // The OAuth `state` check is LIVE again (cto/AdaptaLabs#89).
    //
    // #83 removed the previous one, correctly: it compared the query state
    // against `req.session.googleOAuthState`, a value assigned nowhere in the
    // repo, so it could never fire - a check that read as protection while
    // being dead code. Its real defect was that nothing initiated this flow at
    // all. `/auth/connect` above now does, so the guard has something to guard,
    // and it is the SAME single-use browser-bound control #82 built for login
    // rather than a second implementation of it.
    //
    // Without this, an attacker who obtains any authorization code can lure a
    // logged-in researcher to this URL and have THEIR calendar tokens written
    // against the victim's user row - the victim then books against a stranger's
    // free/busy.
    // The demo path is allowed in DEVELOPMENT ONLY, stated positively.
    //
    // It was `demoMode && NODE_ENV === 'production'` -> refuse, which meant any
    // other NODE_ENV - including unset - skipped the state check entirely and
    // wrote fabricated tokens against whoever's session arrived. Inverted so
    // the permissive branch has to be asked for by name: `config.NODE_ENV` is
    // the validated value (a zod enum defaulting to 'development'), so this
    // cannot be widened by a typo in the environment.
    const mode = calendarOAuthMode();
    const demoAllowed = mode === 'demo';

    if (mode === 'unavailable') {
      // No initiator can reach here in this state - /auth/connect refuses - so
      // this is only reachable by hand, and it is refused by hand too. A user
      // must never be handed fabricated tokens outside a developer's machine.
      logger.warn('Refusing a calendar OAuth callback in demo mode outside development', {
        nodeEnv: config.NODE_ENV,
      });
      return res.status(503).json({
        error: 'Calendar connection is not configured on this deployment',
        code: 'CALENDAR_OAUTH_NOT_CONFIGURED',
      });
    }

    // Whose calendar this is. From the state in every real flow; from the
    // session only on the development-only demo path, which has no state.
    let userId: string;

    if (demoAllowed) {
      const sessionUserId = req.session?.user?.id;
      if (!sessionUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      userId = sessionUserId;
    } else {
      const stateResult = calendarOAuthState.consume(req, res, req.query.state);
      if (!stateResult.ok) {
        logger.warn('Refusing a calendar OAuth callback with an invalid state', {
          reason: stateResult.error,
        });
        return res.status(400).json({ error: stateResult.error });
      }
      if (!stateResult.payload?.userId) {
        // A state with no bound user cannot identify whose calendar to write.
        // Refused rather than falling back to the session, which is the exact
        // trust this route was rebuilt to stop relying on.
        logger.error('A calendar OAuth state carried no user', { state: 'redacted' });
        return res.status(400).json({ error: 'Invalid state parameter' });
      }
      userId = stateResult.payload.userId;
    }

    // In demo mode (local development only, per the guard above) `code` might
    // not be present - handle gracefully.
    if (!code && demoAllowed) {
      logger.debug('Demo mode: Handling callback without code');
      // For demo mode, we'll just mark as connected with mock tokens
    } else if (!code) {
      return res.status(400).json({ error: 'Authorization code missing' });
    }

    // Get tokens (mock in demo mode, real in production).
    //
    // Bounded, because undici's default is a 300s header timeout and this used
    // to run while holding a pool connection. It no longer does, but an
    // unbounded outbound call in a request path is worth closing anyway: a
    // stalled Google token endpoint would otherwise hold a request open for five
    // minutes with the researcher watching a blank tab.
    const { accessToken, refreshToken, expiryDate } = await userCalendarService.getTokens(
      code || 'demo-code'
    );
    
    // Encrypt tokens before storing
    const encryptedAccessToken = userCalendarService.encrypt(accessToken);
    const encryptedRefreshToken = refreshToken 
      ? userCalendarService.encrypt(refreshToken) 
      : null;
    
    // Store tokens in database. The connection is taken here, once there is
    // something to write and nothing left that can refuse.
    dbClient = await pool.connect();
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

    // Redirect to frontend success page
    const frontendUrl = process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/opportunities?calendar=connected`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error handling OAuth callback', { error });
    const frontendUrl = process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/opportunities?calendar=error&message=${encodeURIComponent(errorMessage)}`);
  } finally {
    // `?.` because every refusal above now returns before a connection exists.
    dbClient?.release();
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
        connected: false,
        // Carried on the 404 so the caller that just learned "not connected"
        // also learns whether connecting is possible, without a second request
        // (cto/AdaptaLabs#89).
        available: calendarOAuthAvailable(),
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
      // Whether connecting is even possible here (cto/AdaptaLabs#89). A UI that
      // offers a Connect button on a deployment with no OAuth client sends the
      // researcher to a 503; one that offers nothing leaves them wondering why.
      available: calendarOAuthAvailable(),
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

