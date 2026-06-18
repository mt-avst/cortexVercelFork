import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createErrorResponse, createSafeErrorResponse } from '../utils/errors';
import { getApiConfig } from '../utils/env';
import { logger } from '../utils/logger';
import { setSessionCookie, isDemoLoginAllowed } from '../utils/auth';
import { authRateLimit } from '../utils/rateLimit';
import { SessionUser } from '../../shared/types';

/**
 * GET /api/auth/demo-user-2-login
 * Second demo user login for testing multi-user scenarios
 * (demo/test backdoor — disabled in production unless ALLOW_DEMO_LOGIN=true)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

    // Demo/test login backdoor: never available in production unless explicitly enabled.
    if (!isDemoLoginAllowed()) {
      return res.status(404).json(createErrorResponse('Not found'));
    }

    // Rate limit: 10 login attempts per 15 minutes per IP
    if (await authRateLimit(req, res)) {
      return; // Response already sent by rate limiter
    }

    const demoUser2: SessionUser = {
      id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
      name: 'Demo User 2',
      email: 'demo2@example.com',
      business_unit: 'Product',
      role_title: 'Product Manager',
      role: 'employee',
    };

    // Set signed session cookie (HMAC-SHA256 signed to prevent tampering)
    setSessionCookie(res, demoUser2);
  
    // Redirect to frontend
    // Ensure URL is properly formatted (trim whitespace, remove trailing slashes)
    const config = getApiConfig();
    let frontendUrl = (config.FRONTEND_URL || config.CORS_ORIGIN || 'https://adapta-labs-p62q.vercel.app').trim();
    frontendUrl = frontendUrl.replace(/\/$/, '');
    res.redirect(frontendUrl);
  } catch (error: unknown) {
    logger.error('Error in demo user 2 login handler', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json(createSafeErrorResponse(error, { userMessage: 'Internal server error' }));
  }
}

