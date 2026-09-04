import { SessionUser } from '../types';

type Role = SessionUser['role'];

/**
 * The lift is bounded to these email domains unless CORTEX_BETA_ALL_ADMIN_DOMAINS
 * overrides them. The default is the internal domain on purpose: it keeps the
 * grant bounded in code rather than resting on an assumption about who the Okta
 * tenant lets sign in (the caveat the security review flagged).
 */
const DEFAULT_ALLOWED_DOMAINS = ['adaptavist.com'];

/**
 * TEMPORARY beta switch (cto/AdaptaLabs internal beta, 2026-09).
 *
 * When `CORTEX_BETA_ALL_ADMIN === 'true'`, a signed-in `employee` whose email
 * domain is allow-listed is treated as `researcher_admin` for the duration of a
 * request, so the internal beta cohort gets the admin experience without anyone
 * touching the users table.
 *
 * Four properties make this safe:
 *   - OFF unless the env var is exactly the string 'true'. Default is off.
 *   - BOUNDED to an email-domain allow-list (default `adaptavist.com`,
 *     overridable via CORTEX_BETA_ALL_ADMIN_DOMAINS). "Everyone who can complete
 *     Okta sign-in" is NOT the blast radius; "an allow-listed employee" is.
 *   - It NEVER grants `superadmin`. Only `employee` is lifted, and only to
 *     `researcher_admin`; the two admin roles pass through unchanged.
 *   - It mutates no data. Go-live is a single step - unset the env var (or
 *     delete this file) - with no migration and no stale rows.
 *
 * Applied at the two points that answer "what is this user's role":
 *   - `currentDbRole()` in middleware/authenticate.ts - the live read behind
 *     every admin gate, so admin ROUTES open up while `requireSuperadmin` still
 *     refuses a lifted employee (researcher_admin !== superadmin).
 *   - `GET /api/me` in routes/api.ts - the role the client reads to decide
 *     whether to render admin navigation.
 *
 * index.ts logs a loud startup warning (with the active domains) whenever this
 * is on, so it can never be silently active on the wrong environment.
 */
export function betaAllAdminEnabled(): boolean {
  return process.env.CORTEX_BETA_ALL_ADMIN === 'true';
}

/**
 * The allow-listed email domains, lower-cased. Parsed from
 * CORTEX_BETA_ALL_ADMIN_DOMAINS (comma- or whitespace-separated); falls back to
 * the internal domain when unset or empty, so the lift is never unbounded.
 */
export function betaAllAdminDomains(): string[] {
  const raw = process.env.CORTEX_BETA_ALL_ADMIN_DOMAINS;
  if (!raw || !raw.trim()) {
    return DEFAULT_ALLOWED_DOMAINS;
  }
  return raw
    .split(/[,\s]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function emailDomain(email: string | undefined | null): string | null {
  if (!email) {
    return null;
  }
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) {
    return null;
  }
  return email.slice(at + 1).toLowerCase();
}

/**
 * Whether the beta lift applies to a caller with this email: the switch is on,
 * the email has a domain, and that domain is allow-listed. A missing or
 * malformed email is never lifted.
 */
export function betaLiftApplies(email: string | undefined | null): boolean {
  if (!betaAllAdminEnabled()) {
    return false;
  }
  const domain = emailDomain(email);
  return domain !== null && betaAllAdminDomains().includes(domain);
}

/**
 * The request-effective role. Identity unless the beta lift applies AND the
 * stored role is `employee`, in which case it is lifted to `researcher_admin`.
 * Superadmin is never produced by this function.
 */
export function resolveEffectiveRole(storedRole: Role, email: string | undefined | null): Role {
  if (storedRole === 'employee' && betaLiftApplies(email)) {
    return 'researcher_admin';
  }
  return storedRole;
}
