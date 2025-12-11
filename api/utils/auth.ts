import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { SessionUser } from '../../shared/types';
import { logger } from './logger';

/**
 * Get the session secret for signing cookies.
 * Falls back to a development-only secret if not set.
 */
function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET environment variable is required in production');
    }
    // Development fallback - NOT secure, only for local dev
    return 'dev-only-secret-do-not-use-in-production-32chars';
  }
  return secret;
}

/**
 * Sign data using HMAC-SHA256.
 * Returns format: data.signature
 */
export function signData(data: string): string {
  const secret = getSessionSecret();
  const signature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64url');
  return `${data}.${signature}`;
}

/**
 * Verify and extract data from a signed string.
 * Returns null if signature is invalid.
 */
export function verifySignedData(signedData: string): string | null {
  const lastDotIndex = signedData.lastIndexOf('.');
  if (lastDotIndex === -1) {
    return null;
  }

  const data = signedData.substring(0, lastDotIndex);
  const providedSignature = signedData.substring(lastDotIndex + 1);

  const secret = getSessionSecret();
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64url');

  // Use timing-safe comparison to prevent timing attacks
  if (providedSignature.length !== expectedSignature.length) {
    return null;
  }
  
  const isValid = crypto.timingSafeEqual(
    Buffer.from(providedSignature),
    Buffer.from(expectedSignature)
  );

  return isValid ? data : null;
}

/**
 * Create a signed session cookie value from user data.
 */
export function createSessionCookie(user: SessionUser): string {
  const jsonData = JSON.stringify(user);
  const encodedData = encodeURIComponent(jsonData);
  return signData(encodedData);
}

/**
 * Set the session cookie on a response.
 * Uses HMAC signing to prevent tampering.
 */
export function setSessionCookie(res: VercelResponse, user: SessionUser): void {
  const signedCookie = createSessionCookie(user);
  // Use SameSite=Lax for better CSRF protection when possible
  // SameSite=None is only needed for cross-origin redirects (OAuth callbacks)
  const sameSite = process.env.NODE_ENV === 'production' ? 'Lax' : 'Lax';
  const secure = process.env.NODE_ENV === 'production' ? 'Secure; ' : '';
  res.setHeader(
    'Set-Cookie',
    `adaptalabs_session=${signedCookie}; HttpOnly; ${secure}SameSite=${sameSite}; Path=/; Max-Age=86400`
  );
}

/**
 * Set the session cookie for OAuth callbacks (requires SameSite=None for cross-origin redirects).
 */
export function setSessionCookieForOAuth(res: VercelResponse, user: SessionUser): void {
  const signedCookie = createSessionCookie(user);
  // OAuth callbacks require SameSite=None with Secure for cross-origin redirects
  res.setHeader(
    'Set-Cookie',
    `adaptalabs_session=${signedCookie}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=86400`
  );
}

/**
 * Parse and validate session cookie from request.
 * Verifies HMAC signature before trusting the data.
 * 
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
    logger.debug('No session cookie found', {
      hasCookies: !!cookies,
      cookieCount: cookiePairs.length,
      cookieNames: cookiePairs.map(p => p.split('=')[0]).filter(Boolean)
    });
    return null;
  }

  try {
    // Verify signed cookie (format: encodedData.signature)
    // Legacy unsigned cookies are no longer accepted for security
    if (!sessionData.includes('.')) {
      logger.warn('Unsigned session cookie rejected - please re-login');
      return null;
    }

    const verifiedData = verifySignedData(sessionData);
    if (!verifiedData) {
      logger.warn('Session cookie signature verification failed');
      return null;
    }

    let decodedData: string;
    try {
      decodedData = decodeURIComponent(verifiedData);
    } catch {
      decodedData = verifiedData;
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
    
    if (user.role !== 'employee' && user.role !== 'researcher_admin' && user.role !== 'superadmin') {
      return null;
    }

    return user as SessionUser;
  } catch (error) {
    logger.error('Error parsing session cookie', {
      error: error instanceof Error ? error.message : String(error),
    });
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





