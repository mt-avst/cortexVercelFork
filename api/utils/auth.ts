import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { SessionUser } from '../../shared/types';
import { createErrorResponse } from './errors';
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
 * Auth error thrown by the require* helpers below.
 * Handlers should catch it via handleAuthError() to return a consistent response.
 */
export interface AuthError {
  status: number;
  error: string;
  code?: string;
}

function authError(status: number, error: string, code?: string): AuthError {
  return { status, error, code };
}

/** Type guard for the AuthError shape thrown by require* helpers. */
export function isAuthError(error: unknown): error is AuthError {
  return (
    !!error &&
    typeof error === 'object' &&
    'status' in error &&
    'error' in error &&
    typeof (error as AuthError).status === 'number'
  );
}

/**
 * If `error` is an AuthError, send the matching response and return true.
 * Lets handlers do: `if (handleAuthError(res, error)) return;` before generic 500 handling.
 */
export function handleAuthError(res: VercelResponse, error: unknown): boolean {
  if (isAuthError(error)) {
    res.status(error.status).json(createErrorResponse(error.error, undefined, error.code));
    return true;
  }
  return false;
}

/**
 * Require authentication - returns the user or throws an AuthError (401).
 * Use this helper in endpoints that require authentication.
 */
export function requireAuth(req: VercelRequest): SessionUser {
  const user = parseSessionCookie(req);

  if (!user) {
    throw authError(401, 'Authentication required');
  }

  return user;
}

/**
 * Require an authenticated researcher_admin or superadmin.
 * Throws AuthError 401 if not authenticated, 403 (ADMIN_REQUIRED) if not an admin.
 */
export function requireAdmin(req: VercelRequest): SessionUser {
  const user = requireAuth(req);

  if (user.role !== 'researcher_admin' && user.role !== 'superadmin') {
    throw authError(403, 'Admin access required', 'ADMIN_REQUIRED');
  }

  return user;
}

/**
 * Require an authenticated superadmin.
 * Throws AuthError 401 if not authenticated, 403 (SUPERADMIN_REQUIRED) otherwise.
 */
export function requireSuperadmin(req: VercelRequest): SessionUser {
  const user = requireAuth(req);

  if (user.role !== 'superadmin') {
    throw authError(403, 'Superadmin access required', 'SUPERADMIN_REQUIRED');
  }

  return user;
}

/**
 * Assert the user owns the resource, or is a superadmin (who may act on any owner's resource).
 * Throws AuthError 403 (OWNER_ONLY) otherwise.
 */
export function assertOwnerOrSuperadmin(user: SessionUser, ownerUserId: string): void {
  if (ownerUserId !== user.id && user.role !== 'superadmin') {
    throw authError(403, 'Only the owner can perform this action', 'OWNER_ONLY');
  }
}

/**
 * True when running in a production deployment (Vercel or Node).
 */
export function isProductionEnv(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
}

/**
 * Whether demo/test login backdoors (demo, admin, superadmin demo logins, demo seed)
 * are permitted. Always allowed outside production; in production only when
 * ALLOW_DEMO_LOGIN=true is explicitly set (mirrors the frontend VITE_SHOW_DEMO_LOGIN gate).
 */
export function isDemoLoginAllowed(): boolean {
  if (!isProductionEnv()) return true;
  return process.env.ALLOW_DEMO_LOGIN === 'true';
}

/**
 * Authorize a privileged setup/bootstrap action (run-migrations, set-superadmin).
 * Passes if the caller is a superadmin, OR a SETUP_SECRET is configured and the
 * provided secret matches it (timing-safe). The secret may come from the
 * `secret` query param or request body. Throws AuthError otherwise.
 *
 * The secret path exists for first-run bootstrap (e.g. fresh DB with no superadmin yet).
 */
export function requireSetupAuthorization(req: VercelRequest): void {
  const user = parseSessionCookie(req);
  if (user?.role === 'superadmin') return;

  const configured = process.env.SETUP_SECRET;
  const provided =
    (req.query?.secret as string | undefined) ??
    (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).secret : undefined);

  if (configured && typeof provided === 'string' && provided.length === configured.length) {
    const matches = crypto.timingSafeEqual(
      Buffer.from(provided),
      Buffer.from(configured)
    );
    if (matches) return;
  }

  throw authError(403, 'Superadmin or valid setup secret required', 'SETUP_AUTH_REQUIRED');
}





