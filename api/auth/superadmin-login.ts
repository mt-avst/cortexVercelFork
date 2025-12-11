import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createErrorResponse } from '../utils/errors';
import { getApiConfig } from '../utils/env';
import { logger } from '../utils/logger';
import { setSessionCookie } from '../utils/auth';
import { SessionUser } from '../../shared/types';

/**
 * GET /api/auth/superadmin-login
 * Demo Superadmin login
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

    const demoSuperadmin: SessionUser = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'Demo Superadmin',
      email: 'superadmin@test.com',
      business_unit: 'Platform',
      role_title: 'Platform Administrator',
      role: 'superadmin',
    };

    // Set signed session cookie (HMAC-SHA256 signed to prevent tampering)
    setSessionCookie(res, demoSuperadmin);
  
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

