import { doubleCsrf } from 'csrf-csrf';
import { Request } from 'express';
import { csrfCookieName } from '../utils/hostCookie';

declare module 'express-session' {
  interface SessionData {
    csrfSeeded?: boolean;
  }
}

export const CSRF_ERROR_CODE = 'INVALID_CSRF_TOKEN';
export const CSRF_HEADER = 'x-csrf-token';

// Routes that authenticate by other means and receive no browser cookies
// (cron triggers: CRON_SECRET bearer), plus logout - it only destroys the
// session (nuisance-level CSRF risk) and the SPA fires a silent tokenless
// logout on fresh visits from AuthContext.
const EXEMPT_PATH_PREFIXES = [
  '/api/cron/',
  '/api/auth/logout',
  '/auth/logout',
];

interface CsrfProtectionOptions {
  secret: string;
  secureCookies: boolean;
}

/**
 * Double-submit-cookie CSRF protection (csrf-csrf), replacing the deprecated
 * csurf package. Tokens are issued by GET /api/csrf-token and must be echoed
 * back in the x-csrf-token header on mutating requests. The token is bound to
 * the express-session id, so the token route must touch the session
 * (session.csrfSeeded = true) to make anonymous sessions persist.
 */
export function buildCsrfProtection(options: CsrfProtectionOptions) {
  const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
    getSecret: () => options.secret,
    getSessionIdentifier: (req: Request) => req.session?.id ?? '',
    // __Host- prefixed when cookies are secure (production) so a sibling
    // *.adaptavist.net host cannot toss a duplicate CSRF cookie (#97); bare
    // otherwise, because a __Host- name requires Secure and supertest's jar
    // drops Secure cookies over http, which would break the double-submit test.
    cookieName: csrfCookieName(options.secureCookies),
    cookieOptions: {
      httpOnly: true,
      path: '/',
      sameSite: options.secureCookies ? 'strict' : 'lax',
      secure: options.secureCookies,
    },
    getCsrfTokenFromRequest: (req: Request) => {
      const header = req.headers[CSRF_HEADER];
      return Array.isArray(header) ? header[0] : header;
    },
    skipCsrfProtection: (req: Request) =>
      EXEMPT_PATH_PREFIXES.some(
        (prefix) => req.path === prefix || req.path.startsWith(prefix)
      ),
    errorConfig: {
      statusCode: 403,
      message: 'Invalid CSRF token',
      code: CSRF_ERROR_CODE,
    },
  });

  return { doubleCsrfProtection, generateCsrfToken };
}
