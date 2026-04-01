import express, { Router } from 'express';
import { Issuer, Client } from 'openid-client';
import crypto from 'crypto';

import { pool } from '../config';
import { userCalendarService } from '../services/userCalendar';
import { logger } from '../utils/logger';
import { isGoogleOAuthDemoMode } from '../../../shared/utils/demoMode';

import { SessionUser } from '../types';

logger.debug('Auth module loaded', { oidcIssuer: process.env.OIDC_ISSUER });

const router: Router = Router();
let client: Client;

// Store for state validation (in production, use Redis or similar)
const stateStore = new Map<string, { timestamp: number; used: boolean }>();

// Clean up expired states every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of stateStore.entries()) {
    if (now - data.timestamp > 10 * 60 * 1000) { // 10 minutes
      stateStore.delete(state);
    }
  }
}, 10 * 60 * 1000);

// Initialize OIDC client
async function initializeClient() {
  try {
    logger.debug('OIDC Debug', {
      NODE_ENV: process.env.NODE_ENV,
      OIDC_ISSUER: process.env.OIDC_ISSUER,
      OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID,
      hasClientSecret: !!process.env.OIDC_CLIENT_SECRET,
      OIDC_REDIRECT_URL: process.env.OIDC_REDIRECT_URL
    });


    if (process.env.SKIP_OIDC === 'true') {
      logger.info('Skipping OIDC initialization - SKIP_OIDC is true');
      return;
    }
    
    // Skip OIDC initialization in development if issuer is not available or is a placeholder
    if (process.env.NODE_ENV === 'development' && 
        (!process.env.OIDC_ISSUER || 
         process.env.OIDC_ISSUER.includes('your-oidc-provider.com') ||
         process.env.OIDC_ISSUER.includes('demo-idp.com') ||
         process.env.OIDC_ISSUER.includes('your-idp.com'))) {
      logger.info('Skipping OIDC initialization in development mode - using placeholder issuer');
      return;
    }
    
    const issuer = await Issuer.discover(process.env.OIDC_ISSUER!);
    client = new issuer.Client({
      client_id: process.env.OIDC_CLIENT_ID!,
      client_secret: process.env.OIDC_CLIENT_SECRET!,
      redirect_uris: [process.env.OIDC_REDIRECT_URL!],
      response_types: ['code'],
    });
    logger.info('OIDC client initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize OIDC client', { error });
    // In development, we can continue without OIDC
    if (process.env.NODE_ENV !== 'development') {
      throw error;
    }
  }
}

// Initialize client on startup
initializeClient().catch((error) => {
  if (process.env.NODE_ENV === 'development') {
    logger.warn('OIDC initialization failed, continuing in development mode', { error });
  } else {
    logger.error('OIDC initialization failed', { error });
  }
});

/**
 * GET /auth/login - Initiate OIDC flow
 * 
 * Generates a cryptographically secure state parameter and redirects the user
 * to the OIDC provider for authentication. The state parameter is stored
 * temporarily to prevent CSRF attacks.
 * 
 * @param req - Express request object
 * @param res - Express response object
 * @returns Redirects to OIDC provider or returns 500 error
 */
router.get('/login', async (req, res) => {
  try {
    // Check if OIDC client is available
    if (!client) {
      if (process.env.NODE_ENV === 'development') {
        // In development, redirect to demo login
        return res.redirect('/auth/demo-login');
      } else {
        return res.status(500).json({ error: 'Authentication service unavailable' });
      }
    }
    
    // Generate cryptographically secure state parameter
    const state = crypto.randomBytes(32).toString('hex');
    
    // Store state with timestamp for validation
    stateStore.set(state, { timestamp: Date.now(), used: false });
    
    const authUrl = client.authorizationUrl({
      scope: 'openid profile email',
      state: state,
    });
    
    res.redirect(authUrl);
  } catch (error) {
    logger.error('Login initiation failed', { error });
    res.status(500).json({ error: 'Login initiation failed' });
  }
});

/**
 * GET /auth/callback - Handle OIDC callback
 * 
 * Processes the OIDC callback from the identity provider, validates the state
 * parameter, exchanges the authorization code for tokens, retrieves user info,
 * and creates or updates the user in the database. Creates a secure session
 * and redirects the user to the frontend.
 * 
 * @param req - Express request object containing OIDC callback parameters
 * @param res - Express response object
 * @returns Redirects to frontend on success or returns error response
 */
router.get('/callback', async (req, res) => {
  try {
    // Check if OIDC client is available
    if (!client) {
      if (process.env.NODE_ENV === 'development') {
        // In development, redirect to demo login
        return res.redirect('/auth/demo-login');
      } else {
        return res.status(500).json({ error: 'Authentication service unavailable' });
      }
    }
    
    const params = client.callbackParams(req);
    const state = params.state;
    
    // Validate state parameter
    if (!state || !stateStore.has(state)) {
      logger.error('Invalid or missing state parameter');
      return res.status(400).json({ error: 'Invalid state parameter' });
    }
    
    const stateData = stateStore.get(state);
    if (!stateData || stateData.used) {
      logger.error('State parameter already used or expired');
      return res.status(400).json({ error: 'State parameter already used' });
    }
    
    // Mark state as used
    stateData.used = true;
    
    const tokenSet = await client.callback(process.env.OIDC_REDIRECT_URL!, params, {
      state: state,
    });

    // Get user info from token
    const userInfo = await client.userinfo(tokenSet.access_token!);
    
    // Extract user data from claims
    const userData = {
      name: userInfo.name || userInfo.preferred_username || 'Unknown User',
      email: userInfo.email!,
      business_unit: userInfo.department || userInfo.organization || null,
      role_title: userInfo.job_title || userInfo.title || null,
    };

    // Upsert user in database
    const dbClient = await pool.connect();
    try {
      const result = await dbClient.query(`
        INSERT INTO users (name, email, business_unit, role_title)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (email) 
        DO UPDATE SET 
          name = EXCLUDED.name,
          business_unit = EXCLUDED.business_unit,
          role_title = EXCLUDED.role_title
        RETURNING id, name, email, business_unit, role_title, role
      `, [userData.name, userData.email, userData.business_unit, userData.role_title]);

      const user = result.rows[0];
      
      // Create notification preferences if first login
      await dbClient.query(`
        INSERT INTO notification_preferences (user_id)
        VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING
      `, [user.id]);

      // Auto-connect calendar if using Google OAuth (not OIDC)
      // For OIDC users, calendar connection would need to happen separately
      // For Google OAuth users, calendar tokens are obtained during OAuth flow
      // This will be implemented when switching from OIDC to Google OAuth
      // For now, demo logins handle calendar auto-connection separately

      // Create session user object
      const sessionUser: SessionUser = {
        id: user.id,
        name: user.name,
        email: user.email,
        business_unit: user.business_unit,
        role_title: user.role_title,
        role: user.role,
      };

      // Regenerate session to prevent fixation
      req.session.regenerate((err) => {
        if (err) {
          logger.error('Session regeneration failed', { error: err });
          return res.status(500).json({ error: 'Session creation failed' });
        }
        
        req.session.user = sessionUser;
        req.session.save((err) => {
          if (err) {
            logger.error('Session save failed', { error: err });
            return res.status(500).json({ error: 'Session creation failed' });
          }
          
          res.redirect(process.env.CORS_ORIGIN || 'http://localhost:3000');
        });
      });

    } finally {
      dbClient.release();
    }

  } catch (error) {
    logger.error('Callback handling failed', { error });
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// POST /auth/logout - Destroy session
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      logger.error('Logout failed', { error: err });
      return res.status(500).json({ error: 'Logout failed' });
    }
    
    res.clearCookie('adaptalabs_session');
    res.json({ success: true });
  });
});

/**
 * GET /auth/google-login - Initiate Google OAuth flow
 * 
 * Generates OAuth authorization URL and redirects user to Google for authentication.
 * In demo mode, simulates the flow and redirects directly to callback.
 */
router.get('/google-login', async (req, res) => {
  try {
    const isDemoMode = isGoogleOAuthDemoMode();
    
    if (isDemoMode) {
      // Demo mode: Simulate OAuth flow by redirecting to backend callback with demo code
      logger.debug('Google login: Demo mode - simulating OAuth flow');
      const state = crypto.randomBytes(32).toString('hex');
      // Use relative URL since we're already on the backend server
      return res.redirect(`/auth/google-callback?code=demo-code&state=${state}`);
    }

    // Production mode: Use real Google OAuth
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 
                        `${process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3001'}/auth/google-callback`;
    
    // Request authentication and readonly calendar scope (for conflict checking only)
    // Users add events to their calendars via email links, not programmatically
    const scopes = [
      'openid',
      'profile',
      'email',
      'https://www.googleapis.com/auth/calendar.readonly',
    ].join(' ');

    const state = crypto.randomBytes(32).toString('hex');
    stateStore.set(state, { timestamp: Date.now(), used: false });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
                    `client_id=${encodeURIComponent(clientId)}&` +
                    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
                    `response_type=code&` +
                    `scope=${encodeURIComponent(scopes)}&` +
                    `access_type=offline&` +
                    `prompt=consent&` +
                    `state=${encodeURIComponent(state)}`;

    res.redirect(authUrl);
  } catch (error) {
    logger.error('Google login initiation failed', { error });
    res.status(500).json({ error: 'Google login initiation failed' });
  }
});

/**
 * GET /auth/google-callback - Handle Google OAuth callback
 * 
 * Processes the Google OAuth callback, exchanges code for tokens,
 * retrieves user info, creates/updates user, and auto-connects calendar.
 */
router.get('/google-callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'Authorization code missing' });
    }

    const isDemoMode = isGoogleOAuthDemoMode();

    let userInfo: {
      id: string;
      email: string;
      name: string;
      picture?: string;
    };
    let accessToken: string;
    let refreshToken: string | null;
    let tokenExpiry: Date | null;

    if (isDemoMode || code === 'demo-code') {
      // Demo mode: Create mock user from demo code
      logger.debug('Google callback: Demo mode - creating mock user');
      
      // Use the existing demo user email to match existing demo user record
      userInfo = {
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', // Use existing demo user ID
        email: 'demo@example.com',
        name: 'Demo Google User',
        picture: undefined,
      };

      // Get mock tokens from calendar service
      const { accessToken: demoAccess, refreshToken: demoRefresh, expiryDate } = 
        await userCalendarService.getTokens(code as string);
      
      accessToken = demoAccess;
      refreshToken = demoRefresh;
      tokenExpiry = expiryDate;
    } else {
      // Production mode: Exchange code for tokens with Google
      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!;
      const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET!;
      const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 
                          `${process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3001'}/auth/google-callback`;

      // Exchange authorization code for tokens
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: code as string,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResponse.ok) {
        throw new Error('Failed to exchange code for tokens');
      }

      const tokenData = await tokenResponse.json() as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };
      accessToken = tokenData.access_token;
      refreshToken = tokenData.refresh_token || null;
      tokenExpiry = tokenData.expires_in 
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null;

      // Get user info from Google
      const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!userInfoResponse.ok) {
        throw new Error('Failed to fetch user info');
      }

      const googleUserInfo = await userInfoResponse.json() as {
        id: string;
        email: string;
        name: string;
        picture?: string;
      };
      userInfo = {
        id: googleUserInfo.id,
        email: googleUserInfo.email,
        name: googleUserInfo.name,
        picture: googleUserInfo.picture,
      };
    }

    // Create or update user in database
    const dbClient = await pool.connect();
    try {
      // Check if user exists
      const userResult = await dbClient.query(
        'SELECT id, role FROM users WHERE email = $1',
        [userInfo.email]
      );

      let userId: string;
      let userRole: string = 'employee';

      if (userResult.rows.length > 0) {
        // User exists, update if needed
        userId = userResult.rows[0].id;
        userRole = userResult.rows[0].role || 'employee';
        
        await dbClient.query(`
          UPDATE users 
          SET name = $1
          WHERE id = $2
        `, [userInfo.name, userId]);
      } else {
        // Create new user
        const insertResult = await dbClient.query(`
          INSERT INTO users (email, name, role, created_at)
          VALUES ($1, $2, $3, NOW())
          RETURNING id
        `, [userInfo.email, userInfo.name, userRole]);
        
        userId = insertResult.rows[0].id;

        // Create notification preferences
        await dbClient.query(`
          INSERT INTO notification_preferences (user_id)
          VALUES ($1)
          ON CONFLICT (user_id) DO NOTHING
        `, [userId]);
      }

      // Auto-connect calendar: Store Google OAuth tokens as calendar tokens
      const encryptedAccessToken = userCalendarService.encrypt(accessToken);
      const encryptedRefreshToken = refreshToken 
        ? userCalendarService.encrypt(refreshToken)
        : null;

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
        tokenExpiry,
        'Bearer',
        'https://www.googleapis.com/auth/calendar.readonly openid profile email'
      ]);

      logger.info('Auto-connected calendar for Google user', { email: userInfo.email });

      // Create session user object
      const sessionUser: SessionUser = {
        id: userId,
        name: userInfo.name,
        email: userInfo.email,
        business_unit: 'Engineering', // Default, can be updated from Google profile if available
        role_title: userRole === 'researcher_admin' || userRole === 'superadmin' ? 'Research Manager' : 'Software Engineer',
        role: userRole as 'employee' | 'researcher_admin' | 'superadmin',
      };

      // Regenerate session to prevent fixation (same as OIDC callback)
      req.session.regenerate((err) => {
        if (err) {
          logger.error('Session regeneration failed', { error: err });
          return res.status(500).json({ error: 'Session creation failed' });
        }
        
        req.session.user = sessionUser;
        req.session.save((err) => {
          if (err) {
            logger.error('Session save error', { error: err });
            return res.status(500).json({ error: 'Session creation failed' });
          }
          
          const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
          res.redirect(corsOrigin);
        });
      });
    } finally {
      dbClient.release();
    }
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Google OAuth callback error', {
      error,
      stack: err.stack,
      details: {
        message: err.message,
        name: err.name
      }
    });
    const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
    res.redirect(`${corsOrigin}?error=google_auth_failed&details=${encodeURIComponent(err.message || 'Unknown error')}`);
  }
});

// Demo routes for development
if (process.env.NODE_ENV === 'development') {
  /**
   * Helper function to auto-connect calendar for demo users
   * Extracts the repeated calendar token logic from demo login routes
   */
  const autoConnectDemoCalendar = async (userId: string, userLabel: string): Promise<void> => {
    try {
      const dbClient = await pool.connect();
      try {
        // Check if calendar tokens already exist
        const existingTokens = await dbClient.query(
          'SELECT id FROM user_calendar_tokens WHERE user_id = $1',
          [userId]
        );

        if (existingTokens.rows.length === 0) {
          // Generate mock calendar tokens
          const { accessToken, refreshToken, expiryDate } = await userCalendarService.getTokens('demo-code');
          
          // Encrypt tokens
          const encryptedAccessToken = userCalendarService.encrypt(accessToken);
          const encryptedRefreshToken = refreshToken
            ? userCalendarService.encrypt(refreshToken)
            : null;

          // Store mock calendar tokens
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
              expires_at = EXCLUDED.expires_at
          `, [
            userId,
            encryptedAccessToken,
            encryptedRefreshToken,
            expiryDate,
            'Bearer',
            'https://www.googleapis.com/auth/calendar.readonly'
          ]);

          logger.info(`Auto-connected calendar for ${userLabel}`);
        }
      } finally {
        dbClient.release();
      }
    } catch (error) {
      // Don't fail login if calendar connection fails
      logger.warn(`Failed to auto-connect calendar for ${userLabel} (non-blocking)`, { error });
    }
  };

  /**
   * Helper function to handle demo login session creation and redirect
   */
  const handleDemoLogin = (
    req: express.Request,
    res: express.Response,
    user: SessionUser,
    redirectPath: string = '/'
  ): void => {
    req.session.user = user;
    
    req.session.save((err) => {
      if (err) {
        logger.error('Session save error', { error: err });
        return res.status(500).json({ error: 'Session creation failed' });
      }
      const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
      res.redirect(`${corsOrigin}${redirectPath}`);
    });
  };

  // GET /auth/demo-login - Demo user login
  router.get('/demo-login', async (req, res) => {
    const demoUser: SessionUser = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'Demo User',
      email: 'demo@example.com',
      business_unit: 'Engineering',
      role_title: 'Software Engineer',
      role: 'employee',
    };
    
    await autoConnectDemoCalendar(demoUser.id, 'demo user');
    handleDemoLogin(req, res, demoUser, '/');
  });

  // GET /auth/admin-login - Demo admin login
  router.get('/admin-login', async (req, res) => {
    const demoAdmin: SessionUser = {
      id: '633608bc-4b0e-4d60-a498-e680ee97c252',
      name: 'Test Admin',
      email: 'admin@test.com',
      business_unit: 'Research',
      role_title: 'Research Manager',
      role: 'researcher_admin',
    };
    
    await autoConnectDemoCalendar(demoAdmin.id, 'demo admin');
    handleDemoLogin(req, res, demoAdmin, '/admin');
  });

  // GET /auth/superadmin-login - Demo superadmin login
  router.get('/superadmin-login', async (req, res) => {
    const demoSuperadmin: SessionUser = {
      id: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
      name: 'Demo Superadmin',
      email: 'superadmin@test.com',
      business_unit: 'Administration',
      role_title: 'System Administrator',
      role: 'superadmin',
    };
    
    await autoConnectDemoCalendar(demoSuperadmin.id, 'demo superadmin');
    handleDemoLogin(req, res, demoSuperadmin, '/admin');
  });

  // GET /auth/demo-user-2-login - Demo User 2 login
  router.get('/demo-user-2-login', async (req, res) => {
    const demoUser2: SessionUser = {
      id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
      name: 'Demo User 2',
      email: 'demo2@example.com',
      business_unit: 'Product',
      role_title: 'Product Manager',
      role: 'employee',
    };
    
    await autoConnectDemoCalendar(demoUser2.id, 'demo user 2');
    handleDemoLogin(req, res, demoUser2, '/');
  });
}

export default router;
