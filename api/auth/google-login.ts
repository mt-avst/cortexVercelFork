import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createErrorResponse } from '../utils/errors';
import { isGoogleOAuthDemoMode } from '../../shared/utils/demoMode';
import { getGoogleOAuthConfig, getApiConfig } from '../utils/env';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { signData } from '../utils/auth';
import { authRateLimit } from '../utils/rateLimit';

/**
 * Generate a signed OAuth state parameter.
 * The state includes a timestamp for expiry and is HMAC signed.
 * This allows stateless validation without needing Redis/database.
 */
function generateSignedState(): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = Date.now();
  const data = `${nonce}.${timestamp}`;
  return signData(data);
}

/**
 * GET /api/auth/google-login
 * Initiate Google OAuth flow
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

    const isDemoMode = isGoogleOAuthDemoMode();
    
    if (isDemoMode) {
      // Demo mode: Simulate OAuth flow by redirecting to callback with demo code
      const state = generateSignedState();
      const config = getApiConfig();
      const callbackUrl = `${config.FRONTEND_URL || config.CORS_ORIGIN || 'https://adapta-labs-p62q.vercel.app'}/api/auth/google-callback?code=demo-code&state=${encodeURIComponent(state)}`;
      return res.redirect(callbackUrl);
    }

    // Production mode: Use real Google OAuth
    const oauthConfig = getGoogleOAuthConfig();
    if (!oauthConfig.clientId) {
      throw new Error('GOOGLE_OAUTH_CLIENT_ID is required in production mode');
    }
    
    // Trim whitespace/newlines from client ID (common issue with env vars)
    const clientId = oauthConfig.clientId.trim();
    const config = getApiConfig();
    const redirectUri = (oauthConfig.redirectUri || 
                        `${config.CORS_ORIGIN || config.FRONTEND_URL || 'https://adapta-labs-p62q.vercel.app'}/api/auth/google-callback`).trim();
    
    // Request authentication and readonly calendar scope (for conflict checking only)
    // Users add events to their calendars via email links, not programmatically
    const scopes = [
      'openid',
      'profile',
      'email',
      'https://www.googleapis.com/auth/calendar.readonly',
    ].join(' ');

    // Generate signed state for CSRF protection
    const state = generateSignedState();

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
                    `client_id=${encodeURIComponent(clientId)}&` +
                    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
                    `response_type=code&` +
                    `scope=${encodeURIComponent(scopes)}&` +
                    `access_type=offline&` +
                    `prompt=consent&` +
                    `state=${encodeURIComponent(state)}`;

    res.redirect(authUrl);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Google login initiation failed', {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json(createErrorResponse('Google login initiation failed'));
  }
}

