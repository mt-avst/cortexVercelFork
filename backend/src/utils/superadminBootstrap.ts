/**
 * Superadmin bootstrap by email.
 *
 * When switching to Okta OIDC, the first login for any user creates them as
 * 'employee'. Without an existing admin there's no in-app way to elevate the
 * first one, and on Kubera the Postgres RDS is private (no reachable
 * DATABASE_URL) so it can't be done by hand. This lets a configured allow-list
 * of emails be elevated to superadmin automatically on login.
 *
 * The email always comes from the verified Okta ID-token claim, never user
 * input, and elevation only ever raises a role - it never downgrades anyone.
 */

/**
 * Parses the comma-separated BOOTSTRAP_SUPERADMIN_EMAILS env value into a
 * normalised (trimmed, lowercased, de-duplicated) list of emails.
 */
export function parseBootstrapSuperadminEmails(raw: string | undefined): string[] {
  const seen = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const email = entry.trim().toLowerCase();
    if (email) seen.add(email);
  }
  return [...seen];
}

/**
 * Decides whether a just-authenticated user should be elevated to superadmin.
 * Returns true only when the email is in the bootstrap list and the user is not
 * already a superadmin (so we never issue a redundant or downgrading write).
 */
export function shouldElevateToSuperadmin(
  email: string,
  currentRole: string,
  bootstrapEmails: readonly string[]
): boolean {
  if (currentRole === 'superadmin') return false;
  return bootstrapEmails.includes(email.trim().toLowerCase());
}
