import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createErrorResponse } from '../utils/errors';
import crypto from 'crypto';

/**
 * GET /api/auth/google-login
 * Initiate Google OAuth flow
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

    const isDemoMode = !process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    
    if (isDemoMode) {
      // Demo mode: Simulate OAuth flow by redirecting to callback with demo code
      console.log('Google login: Demo mode - simulating OAuth flow');
      const state = crypto.randomBytes(32).toString('hex');
      const callbackUrl = `${process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://adapta-labs-p62q.vercel.app'}/api/auth/google-callback?code=demo-code&state=${state}`;
      return res.redirect(callbackUrl);
    }

    // Production mode: Use real Google OAuth
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 
                        `${process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'https://adapta-labs-p62q.vercel.app'}/api/auth/google-callback`;
    
    // Request both authentication and calendar scopes
    const scopes = [
      'openid',
      'profile',
      'email',
      'https://www.googleapis.com/auth/calendar',
    ].join(' ');

    const state = crypto.randomBytes(32).toString('hex');
    // Note: In a production app, you'd store state in Redis or a database
    // For now, we'll rely on Google's state validation

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
    console.error('Google login initiation failed:', err);
    res.status(500).json(createErrorResponse('Google login initiation failed'));
  }
}

