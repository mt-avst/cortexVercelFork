import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createErrorResponse } from '../utils/errors';

/**
 * GET /api/auth/demo-user-2-login
 * Second demo user login for testing multi-user scenarios
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

  const demoUser2 = {
    id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    name: 'Demo User 2',
    email: 'demo2@example.com',
    business_unit: 'Product',
    role_title: 'Product Manager',
    role: 'employee', // CRITICAL: Must be 'employee', NOT 'researcher_admin'
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
  const sessionCookie = encodeURIComponent(JSON.stringify(demoUser2));
  // Set cookie WITHOUT domain attribute - works for the exact domain
  // Using SameSite=None with Secure is required for cross-origin in some cases
  // But SameSite=Lax should work for same-site redirects
  // Set without domain to ensure it works for the exact domain
  cookieArray.push(`adaptalabs_session=${sessionCookie}; HttpOnly; Secure; SameSite=None; Path=/`);
  res.setHeader('Set-Cookie', cookieArray);
  
    // Redirect to frontend
    const frontendUrl = process.env.FRONTEND_URL || 'https://adapta-labs-p62q.vercel.app';
    res.redirect(frontendUrl);
  } catch (error: unknown) {
    console.error('Error in demo user 2 login handler:', error);
    return res.status(500).json(createErrorResponse('Internal server error'));
  }
}

