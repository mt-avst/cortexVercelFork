import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';
import { SessionUser } from '../../shared/types';
import { createErrorResponse } from '../utils/errors';

/**
 * Encrypt sensitive token data
 * Uses the same encryption method as backend userCalendar service
 */
function encryptToken(text: string): string {
  const isDemoMode = !process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  
  // If no encryption key set and in demo mode, use simple encoding
  if (isDemoMode && !process.env.ENCRYPTION_KEY) {
    return Buffer.from(`demo:${text}`).toString('base64');
  }

  // Production mode: Full encryption
  const encryptionKey = process.env.ENCRYPTION_KEY || 'demo-key';
  if (encryptionKey.length < 32) {
    console.warn('⚠️ ENCRYPTION_KEY should be at least 32 characters for production');
  }
  
  // Simple XOR encryption (same as backend)
  const key = encryptionKey.padEnd(32, '0').substring(0, 32);
  let encrypted = '';
  for (let i = 0; i < text.length; i++) {
    encrypted += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return Buffer.from(encrypted).toString('base64');
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

    const { code, state, error } = req.query;

    // Handle OAuth errors
    if (error) {
      console.error('Google OAuth error:', error);
      const frontendUrl = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://adapta-labs-p62q.vercel.app';
      return res.redirect(`${frontendUrl}?error=google_auth_failed&details=${encodeURIComponent(String(error))}`);
    }

    if (!code) {
      return res.status(400).json(createErrorResponse('Authorization code missing'));
    }

    const isDemoMode = !process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET;

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
      console.log('Google callback: Demo mode - creating mock user');
      
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
      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!;
      const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET!;
      const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 
                          `${process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'https://adapta-labs-p62q.vercel.app'}/api/auth/google-callback`;

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
        console.error('Failed to exchange code for tokens:', errorText);
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
        console.error('Failed to fetch user info:', errorText);
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
        'https://www.googleapis.com/auth/calendar openid profile email'
      ]);

      console.log('Auto-connected calendar for Google user', { email: userInfo.email });

      // Create session user object
      const sessionUser: SessionUser = {
        id: userId,
        name: userInfo.name,
        email: userInfo.email,
        business_unit: 'Engineering', // Default, can be updated from Google profile if available
        role_title: userRole === 'researcher_admin' ? 'Research Manager' : 'Software Engineer',
        role: userRole as 'employee' | 'researcher_admin',
      };

      // Clear any existing session cookies first (including admin cookies)
      // This ensures no stale cookies interfere
      const cookieArray: string[] = [];
      // Clear cookie with domain (try multiple variations to ensure cleanup)
      cookieArray.push(`adaptalabs_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.vercel.app; expires=Thu, 01 Jan 1970 00:00:00 GMT`);
      cookieArray.push(`adaptalabs_session=; HttpOnly; Secure; SameSite=None; Path=/; Domain=.vercel.app; expires=Thu, 01 Jan 1970 00:00:00 GMT`);
      // Clear cookie without domain
      cookieArray.push(`adaptalabs_session=; HttpOnly; Secure; SameSite=Lax; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`);
      cookieArray.push(`adaptalabs_session=; HttpOnly; Secure; SameSite=None; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`);

      // Set new session cookie with proper encoding
      // CRITICAL: JSON must be URL encoded for cookie value
      const sessionCookie = encodeURIComponent(JSON.stringify(sessionUser));
      // Set cookie WITHOUT domain attribute - works for the exact domain
      // Using SameSite=None with Secure is required for cross-origin redirects from Google
      // Set without domain to ensure it works for the exact domain
      // Max-Age=86400 = 24 hours (same as session max age)
      cookieArray.push(`adaptalabs_session=${sessionCookie}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=86400`);
      
      // Log cookie setting for debugging (remove in production)
      console.log('Setting session cookie:', {
        cookieLength: sessionCookie.length,
        userId: sessionUser.id,
        email: sessionUser.email,
        cookieCount: cookieArray.length
      });
      
      res.setHeader('Set-Cookie', cookieArray);

      // Redirect to frontend
      const frontendUrl = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://adapta-labs-p62q.vercel.app';
      if (sessionUser.role === 'researcher_admin') {
        res.redirect(`${frontendUrl}/admin`);
      } else {
        res.redirect(frontendUrl);
      }
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('Google OAuth callback error:', {
      error: err.message,
      stack: err.stack,
    });
    
    const frontendUrl = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://adapta-labs-p62q.vercel.app';
    res.redirect(`${frontendUrl}?error=google_auth_failed&details=${encodeURIComponent(err.message || 'Unknown error')}`);
  }
}

