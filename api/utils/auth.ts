import type { VercelRequest } from '@vercel/node';
import { SessionUser } from '../../shared/types';

/**
 * Parse and validate session cookie from request
 * @param req - Vercel request object
 * @returns Parsed user object or null if invalid/not authenticated
 */
export function parseSessionCookie(req: VercelRequest): SessionUser | null {
  const cookies = req.headers.cookie || '';
  const cookiePairs = cookies.split(';').map(c => c.trim());
  let sessionData: string | null = null;

  // Find session cookie (check from end to get most recent)
  for (let i = cookiePairs.length - 1; i >= 0; i--) {
    const pair = cookiePairs[i];
    if (pair.startsWith('adaptalabs_session=')) {
      sessionData = pair.substring('adaptalabs_session='.length);
      break;
    }
  }

  if (!sessionData) {
    // Debug logging (remove in production)
    console.log('No session cookie found', {
      hasCookies: !!cookies,
      cookieCount: cookiePairs.length,
      cookieNames: cookiePairs.map(p => p.split('=')[0]).filter(Boolean)
    });
    return null;
  }

  try {
    // Try URL decode first (in case it was encoded), but handle if already decoded
    let decodedData: string;
    try {
      decodedData = decodeURIComponent(sessionData);
      // If decodeURIComponent didn't change it and it starts with {, assume it's already decoded
      if (decodedData === sessionData && sessionData.startsWith('{')) {
        decodedData = sessionData;
      }
    } catch {
      // If decode fails, assume it's already decoded JSON
      decodedData = sessionData;
    }

    const user = JSON.parse(decodedData);

    // Validate required fields
    if (!user.id || typeof user.id !== 'string') {
      return null;
    }

    if (!user.name || typeof user.name !== 'string') {
      return null;
    }

    if (!user.email || typeof user.email !== 'string') {
      return null;
    }

    // Validate role matches expected values
    if (!user.role || typeof user.role !== 'string') {
      return null;
    }
    
    if (user.role !== 'employee' && user.role !== 'researcher_admin') {
      return null;
    }

    return user as SessionUser;
  } catch (error) {
    // Return null on any parsing error
    return null;
  }
}

/**
 * Require authentication - returns user or throws error response
 * Use this helper in endpoints that require authentication
 */
export function requireAuth(req: VercelRequest): SessionUser {
  const user = parseSessionCookie(req);
  
  if (!user) {
    throw {
      status: 401,
      error: 'Not authenticated'
    };
  }

  return user;
}









