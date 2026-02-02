import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';
import { SessionUser } from '../../shared/types';
import { createErrorResponse } from '../utils/errors';
import { isGoogleOAuthDemoMode } from '../../shared/utils/demoMode';
import { getGoogleOAuthConfig, getApiConfig } from '../utils/env';
import { logger } from '../utils/logger';
import { setSessionCookieForOAuth, verifySignedData } from '../utils/auth';
import { encrypt as encryptToken } from '../utils/encryption';
import { authRateLimit } from '../utils/rateLimit';

// State expiry time: 10 minutes (prevents replay attacks)
const STATE_EXPIRY_MS = 10 * 60 * 1000;

/**
 * Verify the OAuth state parameter.
 * Checks HMAC signature and expiry timestamp.
 */
function verifyOAuthState(state: string | undefined): { valid: boolean; error?: string } {
  if (!state || typeof state !== 'string') {
    return { valid: false, error: 'State parameter missing' };
  }

  // Verify signature
  const verifiedData = verifySignedData(state);
  if (!verifiedData) {
    return { valid: false, error: 'Invalid state signature' };
  }

  // Parse and check timestamp
  const parts = verifiedData.split('.');
  if (parts.length !== 2) {
    return { valid: false, error: 'Malformed state data' };
  }

  const timestamp = parseInt(parts[1], 10);
  if (isNaN(timestamp)) {
    return { valid: false, error: 'Invalid state timestamp' };
  }

  // Check expiry
  if (Date.now() - timestamp > STATE_EXPIRY_MS) {
    return { valid: false, error: 'State expired' };
  }

  return { valid: true };
}

/**
 * Generate mock tokens for demo mode
 */
async function getMockTokens(code: string): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiryDate: Date | null;
}> {
  // In demo mode, generate mock tokens
  const accessToken = `demo_access_token_${Date.now()}`;
  const refreshToken = `demo_refresh_token_${Date.now()}`;
  const expiryDate = new Date(Date.now() + 3600 * 1000); // 1 hour
  
  return { accessToken, refreshToken, expiryDate };
}

/**
 * GET /api/auth/google-callback
 * Handle Google OAuth callback
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

    // Rate limit: 10 login attempts per 15 minutes per IP
    if (await authRateLimit(req, res)) {
      return; // Response already sent by rate limiter
    }

    const { code, state, error } = req.query;

    // Handle OAuth errors
    if (error) {
      logger.error('Google OAuth error', {
        errorMessage: String(error),
      });
      const config = getApiConfig();
      // Ensure URL is properly formatted (trim whitespace, remove trailing slashes)
      let frontendUrl = (config.FRONTEND_URL || config.CORS_ORIGIN || 'https://adapta-labs-p62q.vercel.app').trim();
      frontendUrl = frontendUrl.replace(/\/$/, '').replace(/[\r\n\t]/g, '');
      
      const errorMessage = encodeURIComponent(String(error));
      const redirectUrl = `${frontendUrl}?error=google_auth_failed&details=${errorMessage}`;
      
      try {
        new URL(redirectUrl);
        return res.redirect(redirectUrl);
      } catch (urlError) {
        logger.error('Invalid redirect URL', {
          redirectUrl,
          errorMessage: urlError instanceof Error ? urlError.message : String(urlError),
        });
        return res.status(500).json(
          createErrorResponse(
            'Authentication failed',
            'Invalid redirect URL configuration',
            'GOOGLE_AUTH_ERROR'
          )
        );
      }
    }

    if (!code) {
      return res.status(400).json(createErrorResponse('Authorization code missing'));
    }

    // Verify OAuth state parameter (CSRF protection)
    const stateVerification = verifyOAuthState(state as string | undefined);
    if (!stateVerification.valid) {
      logger.warn('OAuth state validation failed', {
        error: stateVerification.error,
        hasState: !!state,
      });
      // In demo mode, be more lenient with state validation for testing
      const isDemoRequest = code === 'demo-code';
      if (!isDemoRequest) {
        return res.status(400).json(createErrorResponse(
          'Invalid or expired state parameter',
          stateVerification.error
        ));
      }
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
      // Demo mode: Create mock user
      
      userInfo = {
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        email: 'demo@example.com',
        name: 'Demo Google User',
        picture: undefined,
      };

      const tokens = await getMockTokens(code as string);
      accessToken = tokens.accessToken;
      refreshToken = tokens.refreshToken;
      tokenExpiry = tokens.expiryDate;
    } else {
      // Production mode: Exchange code for tokens with Google
      const oauthConfig = getGoogleOAuthConfig();
      if (!oauthConfig.clientId || !oauthConfig.clientSecret) {
        throw new Error('Google OAuth credentials are required in production mode');
      }
      
      // Trim whitespace/newlines from credentials (common issue with env vars)
      const clientId = oauthConfig.clientId.trim();
      const clientSecret = oauthConfig.clientSecret.trim();
      const config = getApiConfig();
      const redirectUri = (oauthConfig.redirectUri || 
                          `${config.CORS_ORIGIN || config.FRONTEND_URL || 'https://adapta-labs-p62q.vercel.app'}/api/auth/google-callback`).trim();

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
        const errorText = await tokenResponse.text();
        logger.error('Failed to exchange code for tokens', {
          errorMessage: errorText,
          status: tokenResponse.status,
        });
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
        const errorText = await userInfoResponse.text();
        logger.error('Failed to fetch user info', {
          errorMessage: errorText,
          status: userInfoResponse.status,
        });
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
    // Check if database is configured before attempting connection
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
      logger.error('DATABASE_URL or POSTGRES_URL environment variable is not set');
      throw new Error('Database connection not configured. Please set DATABASE_URL environment variable.');
    }
    
    const pool = getPool();
    const client = await pool.connect();
    
    try {
      // Check if user exists
      const userResult = await client.query(
        'SELECT id, role FROM users WHERE email = $1',
        [userInfo.email]
      );

      let userId: string;
      let userRole: string = 'employee';

      if (userResult.rows.length > 0) {
        // User exists, update if needed
        userId = userResult.rows[0].id;
        userRole = userResult.rows[0].role || 'employee';
        
        await client.query(`
          UPDATE users 
          SET name = $1
          WHERE id = $2
        `, [userInfo.name, userId]);
      } else {
        // Create new user
        const insertResult = await client.query(`
          INSERT INTO users (email, name, role, created_at)
          VALUES ($1, $2, $3, NOW())
          RETURNING id
        `, [userInfo.email, userInfo.name, userRole]);
        
        userId = insertResult.rows[0].id;

        // Create notification preferences
        await client.query(`
          INSERT INTO notification_preferences (user_id)
          VALUES ($1)
          ON CONFLICT (user_id) DO NOTHING
        `, [userId]);
      }

      // Auto-connect calendar: Store Google OAuth tokens as calendar tokens
      const encryptedAccessToken = encryptToken(accessToken);
      const encryptedRefreshToken = refreshToken 
        ? encryptToken(refreshToken)
        : null;

      await client.query(`
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

      // Create session user object
      const sessionUser: SessionUser = {
        id: userId,
        name: userInfo.name,
        email: userInfo.email,
        business_unit: 'Engineering', // Default, can be updated from Google profile if available
        role_title: userRole === 'researcher_admin' || userRole === 'superadmin' ? 'Research Manager' : 'Software Engineer',
        role: userRole as 'employee' | 'researcher_admin' | 'superadmin',
      };

      // Set signed session cookie (HMAC-SHA256 signed to prevent tampering)
      // Uses SameSite=None for OAuth cross-origin redirects
      setSessionCookieForOAuth(res, sessionUser);

      // Redirect to frontend
      const config = getApiConfig();
      // Ensure URL is properly formatted (trim whitespace, remove trailing slashes)
      let frontendUrl = (config.FRONTEND_URL || config.CORS_ORIGIN || 'https://adapta-labs-p62q.vercel.app').trim();
      // Remove trailing slash if present
      frontendUrl = frontendUrl.replace(/\/$/, '');
      
      if (sessionUser.role === 'researcher_admin' || sessionUser.role === 'superadmin') {
        res.redirect(`${frontendUrl}/admin`);
      } else {
        res.redirect(frontendUrl);
      }
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Google OAuth callback error', {
      errorMessage: err.message,
      stack: err.stack,
      name: err.name,
    });
    
    // Log additional context for debugging
    logger.debug('Environment check', {
      hasDatabaseUrl: !!process.env.DATABASE_URL,
      hasPostgresUrl: !!process.env.POSTGRES_URL,
      hasGoogleOAuthClientId: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
      hasGoogleOAuthClientSecret: !!process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      query: req.query,
      url: req.url,
    });
    
    try {
      const config = getApiConfig();
      // Ensure URL is properly formatted (trim whitespace, remove trailing slashes)
      let frontendUrl = (config.FRONTEND_URL || config.CORS_ORIGIN || 'https://adapta-labs-p62q.vercel.app').trim();
      // Remove trailing slash if present
      frontendUrl = frontendUrl.replace(/\/$/, '');
      // Remove any control characters (newlines, tabs, etc.)
      frontendUrl = frontendUrl.replace(/[\r\n\t]/g, '');
      
      // Sanitize error message - remove any characters that might break URL encoding
      const sanitizedErrorMessage = (err.message || 'Unknown error')
        .replace(/[\r\n\t]/g, ' ')
        .replace(/"/g, "'")
        .replace(/\[/g, '(')
        .replace(/\]/g, ')')
        .trim();
      
      const errorMessage = encodeURIComponent(sanitizedErrorMessage);
      const redirectUrl = `${frontendUrl}?error=google_auth_failed&details=${errorMessage}`;
      
      // Validate URL before redirecting
      try {
        const url = new URL(redirectUrl);
        // Ensure URL is valid and doesn't contain problematic characters
        if (!res.headersSent) {
          res.redirect(url.toString());
        } else {
          logger.error('Cannot redirect: headers already sent');
          res.status(500).json({
            error: 'Authentication failed',
            message: sanitizedErrorMessage,
            code: 'GOOGLE_AUTH_ERROR'
          });
        }
      } catch (urlError) {
        logger.error('Invalid redirect URL', {
          redirectUrl,
          errorMessage: urlError instanceof Error ? urlError.message : String(urlError),
        });
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Authentication failed',
            message: 'Invalid redirect URL configuration',
            code: 'GOOGLE_AUTH_ERROR'
          });
        }
      }
    } catch (redirectError) {
      // If redirect fails, send error response instead
      logger.error('Failed to redirect after error', {
        errorMessage: redirectError instanceof Error ? redirectError.message : String(redirectError),
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Authentication failed',
          message: err.message || 'Unknown error',
          code: 'GOOGLE_AUTH_ERROR'
        });
      }
    }
  }
}

