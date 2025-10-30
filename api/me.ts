import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from './utils/auth';
import { createErrorResponse } from './utils/errors';

/**
 * GET /api/me
 * Get current user from session cookie
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    const user = requireAuth(req);
    return res.status(200).json(user);
  } catch (error: unknown) {
    // Handle auth errors
    if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
      return res.status(401).json(createErrorResponse(
        typeof error === 'object' && 'error' in error 
          ? String(error.error) 
          : 'Not authenticated'
      ));
    }
    
    return res.status(401).json(createErrorResponse('Invalid session'));
  }
}

