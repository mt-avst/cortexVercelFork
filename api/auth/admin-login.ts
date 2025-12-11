import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createErrorResponse } from '../utils/errors';
import { getApiConfig } from '../utils/env';
import { logger } from '../utils/logger';
import { setSessionCookie } from '../utils/auth';
import { authRateLimit } from '../utils/rateLimit';
import { SessionUser } from '../../shared/types';

/**
 * GET /api/auth/admin-login
 * Admin login
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

    const demoAdmin: SessionUser = {
      id: '633608bc-4b0e-4d60-a498-e680ee97c252',
      name: 'Test Admin',
      email: 'admin@test.com',
      business_unit: 'Research',
      role_title: 'Research Manager',
      role: 'researcher_admin',
    };

    // Set signed session cookie (HMAC-SHA256 signed to prevent tampering)
    setSessionCookie(res, demoAdmin);
  
    // Redirect to admin dashboard
    // Ensure URL is properly formatted (trim whitespace, remove trailing slashes)
    const config = getApiConfig();
    let frontendUrl = (config.FRONTEND_URL || config.CORS_ORIGIN || 'https://adapta-labs-p62q.vercel.app').trim();
    frontendUrl = frontendUrl.replace(/\/$/, '');
    res.redirect(`${frontendUrl}/admin`);
  } catch (error: unknown) {
    logger.error('Error in admin login handler', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json(createErrorResponse('Internal server error'));
  }
}

