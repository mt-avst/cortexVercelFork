import type { CookieOptions } from 'express';

/**
 * `__Host-` naming for the app's first-party cookies (cto/AdaptaLabs#97).
 *
 * #94 closed cookie-tossing on the OAuth `state` cookie by giving it a
 * `__Host-` prefix (see utils/oauthState.ts). The session and CSRF cookies are
 * vulnerable to the SAME mechanism on the same origin: in production both are
 * host-only with no `Domain`, so any sibling `*.adaptavist.net` host can set
 * `Domain=.adaptavist.net` and plant a duplicate. `cookie` parses a duplicate
 * name first-wins, so the planted cookie shadows the victim's. For the session
 * cookie that is a denial-of-login (the victim's post-login cookie is shadowed
 * indefinitely); the classic fixation escalation is already blocked by
 * `req.session.regenerate()` on both login paths.
 *
 * A `__Host-` cookie is accepted by the browser ONLY when it is `Secure`, has
 * `Path=/`, and carries NO `Domain`. A sibling cannot express that (it needs a
 * `Domain` to reach us), so it cannot plant a duplicate - that is the whole of
 * the fix.
 *
 * WHY THE PREFIX IS CONDITIONAL HERE, where #94's is unconditional. The OAuth
 * guard sets its cookie with `res.cookie`, which emits a `Secure` cookie even
 * over `http://localhost` (a trustworthy origin - measured in #94), so it can
 * carry the prefix in every environment. These two cannot:
 *
 *   - `express-session` REFUSES to set a `Secure` cookie unless it believes the
 *     connection is secure (`req.secure`, via `trust proxy`). Over plain
 *     `http://localhost` in development it would emit no cookie at all, breaking
 *     local login. A `__Host-` name without `Secure` is invalid, so the prefix
 *     and `Secure` travel together or not at all.
 *   - the CSRF cookie is exercised by supertest, whose cookie jar SILENTLY DROPS
 *     `Secure` cookies over http; an unconditional `Secure` `__Host-` CSRF
 *     cookie would break the double-submit round-trip in tests.
 *
 * The sibling-subdomain toss is a production-origin threat only - `localhost`
 * has no sibling `*.adaptavist.net`. So the prefix is applied exactly where the
 * threat exists (the secure/production environment) and the bare name is kept
 * where the threat does not and `Secure` cannot be set. In production every
 * other attribute (`Secure`, `SameSite=Strict`, no `Domain`, `Path=/`) is
 * already satisfied by both cookies, so the name is the only thing that changes.
 *
 * The name is derived HERE, once, so the set site (index.ts session config,
 * csrf.ts) and the clear site (routes/auth.ts logout) cannot drift onto
 * different names - a drift that would silently break production logout.
 */
export const HOST_COOKIE_PREFIX = '__Host-';

export const SESSION_COOKIE_BASENAME = 'adaptalabs_session';
export const CSRF_COOKIE_BASENAME = 'adaptalabs_csrf';

/**
 * The one predicate that decides whether the secure cookie attributes (and so
 * the `__Host-` prefix) apply. Keyed off `NODE_ENV === 'production'`, exactly as
 * `cookie.secure`, `cookie.sameSite` and `cookie.domain` already are in
 * index.ts - a `__Host-` name and a non-secure cookie must never be emitted
 * together.
 */
export function isSecureCookieEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'production';
}

/** The session cookie name: `__Host-` prefixed in production, bare otherwise. */
export function sessionCookieName(nodeEnv: string | undefined): string {
  return isSecureCookieEnv(nodeEnv) ? `${HOST_COOKIE_PREFIX}${SESSION_COOKIE_BASENAME}` : SESSION_COOKIE_BASENAME;
}

/**
 * The CSRF cookie name, keyed off csrf-csrf's own `secureCookies` flag (which is
 * itself `NODE_ENV === 'production'`). `__Host-` prefixed when secure, bare
 * otherwise so the double-submit contract survives non-secure test transport.
 */
export function csrfCookieName(secureCookies: boolean): string {
  return secureCookies ? `${HOST_COOKIE_PREFIX}${CSRF_COOKIE_BASENAME}` : CSRF_COOKIE_BASENAME;
}

/**
 * Options for `res.clearCookie` on logout, matching the SET options so the
 * browser actually removes the cookie. In production the clear must itself be a
 * valid `__Host-` cookie (Secure, Path=/, no Domain) or the browser refuses it
 * and the cookie is never cleared; in development it must carry the same
 * `Domain=localhost` the set cookie uses, or the clear misses.
 */
export function sessionCookieClearOptions(nodeEnv: string | undefined): CookieOptions {
  const secure = isSecureCookieEnv(nodeEnv);
  if (secure) {
    return { path: '/', httpOnly: true, secure: true, sameSite: 'strict' };
  }
  return { path: '/', httpOnly: true, secure: false, sameSite: 'lax', domain: 'localhost' };
}
