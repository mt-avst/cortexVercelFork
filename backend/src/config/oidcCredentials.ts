type OidcEnv = Record<string, string | undefined>;

function describeSecretPresence(value: string | undefined, label: string): string {
  if (value === undefined) return `${label}: MISSING`;
  return value.length > 0 ? `${label}: present (${value.length} chars)` : `${label}: MISSING (blank)`;
}

/**
 * Human-readable, secret-free description of which env var actually supplied
 * OIDC client_id, mirroring the precedence in routes/auth.ts (OIDC_CLIENT_ID -
 * the documented self-host override - always wins over the chart-injected
 * clientID). Intended to be logged unconditionally at startup so a bad or
 * stale credential shows up as an explicit source name in the log instead of
 * a silent 400 on every login attempt. Never returns the client_secret value.
 */
export function describeOidcCredentialSource(env: OidcEnv): string {
  if (env.OIDC_CLIENT_ID) {
    return `client_id from OIDC_CLIENT_ID (self-host override), ${describeSecretPresence(env.OIDC_CLIENT_SECRET, 'client_secret')}`;
  }
  if (env.clientID) {
    return `client_id from clientID (Kubera auth.okta_app), ${describeSecretPresence(env.clientSecret, 'client_secret')}`;
  }
  return 'NONE FOUND - neither OIDC_CLIENT_ID nor clientID is set, OIDC client_id is undefined (login will fail)';
}

/**
 * True when OIDC_CLIENT_ID and clientID are both set but disagree - the exact
 * combination that caused Okta login to 400 for a week on 2026-07-14: a stale
 * hand-added OIDC_CLIENT_ID in the Kubera secret store silently outranked the
 * correctly-provisioned clientID from the auth.okta_app chart, and nothing
 * logged which credential source was actually in play.
 */
export function hasConflictingOidcClientId(env: OidcEnv): boolean {
  return !!env.OIDC_CLIENT_ID && !!env.clientID && env.OIDC_CLIENT_ID !== env.clientID;
}

/**
 * Loud warning text for the conflict case above, or null when there is
 * nothing to warn about. client_id is a public OAuth identifier, not a
 * secret, so both values are named directly - that's the whole point: this
 * is the diagnostic that would have turned the week-long outage into a
 * one-line log read. client_secret values are never included.
 */
export function describeOidcClientIdConflictWarning(env: OidcEnv): string | null {
  if (!hasConflictingOidcClientId(env)) return null;
  return (
    `OIDC_CLIENT_ID ("${env.OIDC_CLIENT_ID}") and clientID ("${env.clientID}") are BOTH set and DIFFER. ` +
    `OIDC_CLIENT_ID wins per the documented self-host override (see docs/IT_OPS_DEPLOYMENT.md), so the ` +
    `provisioned Kubera credential (clientID) is being IGNORED. If OIDC_CLIENT_ID was not deliberately set ` +
    `for a self-hosted deployment, it is almost certainly a stale manual override left in the secret store ` +
    `and login will fail against the wrong Okta app.`
  );
}
