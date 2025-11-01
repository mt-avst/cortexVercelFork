import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createErrorResponse } from '../utils/errors';

/**
 * POST /api/auth/logout
 * Logout endpoint - clears session cookie
 * 
 * In Vercel serverless functions, we clear the session cookie.
 * The frontend will handle redirecting the user.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

    // Clear the session cookie
    res.setHeader('Set-Cookie', 'adaptalabs_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax; Secure');

    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('Logout error:', error);
    return res.status(500).json(createErrorResponse('Logout failed'));
  }
}


