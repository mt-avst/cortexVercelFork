import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createErrorResponse } from '../utils/errors';
import { getApiConfig } from '../utils/env';

/**
 * GET /api/auth/admin-login
 * Admin login
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

  const demoAdmin = {
    id: '633608bc-4b0e-4d60-a498-e680ee97c252',
    name: 'Test Admin',
    email: 'admin@test.com',
    business_unit: 'Research',
    role_title: 'Research Manager',
    role: 'researcher_admin', // CRITICAL: Must be 'researcher_admin', NOT 'employee'
  };

  // Set session cookie with proper encoding
  // CRITICAL: JSON must be URL encoded for cookie value
  // Vercel serverless functions require a single Set-Cookie header string, not an array
  // Setting a new cookie with the same name will replace any existing cookie
  const sessionCookie = encodeURIComponent(JSON.stringify(demoAdmin));
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
    console.error('Error in admin login handler:', error);
    return res.status(500).json(createErrorResponse('Internal server error'));
  }
}

