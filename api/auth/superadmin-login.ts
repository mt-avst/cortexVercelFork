import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createErrorResponse } from '../utils/errors';
import { getApiConfig } from '../utils/env';
import { logger } from '../utils/logger';

/**
 * GET /api/auth/superadmin-login
 * Demo Superadmin login
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

  const demoSuperadmin = {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'Demo Superadmin',
    email: 'superadmin@test.com',
    business_unit: 'Platform',
    role_title: 'Platform Administrator',
    role: 'superadmin', // CRITICAL: Must be 'superadmin' for full access
  };

  // Set session cookie with proper encoding
  // CRITICAL: JSON must be URL encoded for cookie value
  // Vercel serverless functions require a single Set-Cookie header string, not an array
  // Setting a new cookie with the same name will replace any existing cookie
  const sessionCookie = encodeURIComponent(JSON.stringify(demoSuperadmin));
  // Max-Age=86400 = 24 hours (same as session max age in google-callback)
  // Using SameSite=None with Secure is required for cross-origin redirects
  res.setHeader('Set-Cookie', `adaptalabs_session=${sessionCookie}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=86400`);
  
    // Redirect to admin dashboard
    // Ensure URL is properly formatted (trim whitespace, remove trailing slashes)
    const config = getApiConfig();
    let frontendUrl = (config.FRONTEND_URL || config.CORS_ORIGIN || 'https://adapta-labs-p62q.vercel.app').trim();
    frontendUrl = frontendUrl.replace(/\/$/, '');
    res.redirect(`${frontendUrl}/admin`);
  } catch (error: unknown) {
    logger.error('Error in superadmin login handler', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json(createErrorResponse('Internal server error'));
  }
}

