import rateLimit, { type RateLimitRequestHandler, type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { RATE_LIMITS } from '../../../shared/constants';

/**
 * The development-only demo login routes defined in routes/auth.ts, as paths
 * RELATIVE to the router's mount point.
 *
 * Relative is the whole point. This limiter is mounted at both '/auth' and
 * '/api/auth', and inside middleware mounted with a path Express reports
 * `req.path` relative to that mount - so a request to '/api/auth/demo-login'
 * arrives here as '/demo-login'. The previous predicate compared against the
 * absolute '/auth/demo-login' and therefore never matched, which made the skip
 * dead code and left the demo logins rate limited in development.
 */
export const DEMO_AUTH_ROUTE_PATHS: readonly string[] = [
  '/demo-login',
  '/admin-login',
  '/superadmin-login',
  '/demo-user-2-login',
];

/**
 * Demo logins exist only when NODE_ENV is development (routes/auth.ts gates the
 * whole block), so exempting them cannot loosen anything in production.
 */
export const shouldSkipAuthRateLimit = (req: Pick<Request, 'path'>): boolean => {
  if (process.env.NODE_ENV !== 'development') return false;
  return DEMO_AUTH_ROUTE_PATHS.includes(req.path);
};

/**
 * Rate limiter for the auth routes. `overrides` exists so tests can shrink the
 * window and ceiling without re-declaring the behaviour under test.
 */
export const createAuthLimiter = (overrides: Partial<Options> = {}): RateLimitRequestHandler =>
  rateLimit({
    windowMs: RATE_LIMITS.WINDOW_MS,
    max: process.env.NODE_ENV === 'development' ? RATE_LIMITS.MAX_REQUESTS : RATE_LIMITS.MAX_AUTH_REQUESTS,
    message: 'Too many authentication attempts, please try again later.',
    skip: shouldSkipAuthRateLimit,
    ...overrides,
  });
