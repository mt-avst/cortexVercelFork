import { describe, expect, it } from '@jest/globals';

import {
  describeOidcClientIdConflictWarning,
  describeOidcCredentialSource,
  hasConflictingOidcClientId,
} from '../oidcCredentials';

describe('describeOidcCredentialSource', () => {
  it('identifies OIDC_CLIENT_ID as the source without revealing the secret', () => {
    const description = describeOidcCredentialSource({
      OIDC_CLIENT_ID: '0oaw330m1lzLlY4G74x7',
      OIDC_CLIENT_SECRET: 'hunter2',
    });
    expect(description).toBe(
      'client_id from OIDC_CLIENT_ID (self-host override), client_secret: present (7 chars)'
    );
    expect(description).not.toContain('hunter2');
  });

  it('reports OIDC_CLIENT_SECRET as missing when only OIDC_CLIENT_ID is set', () => {
    expect(describeOidcCredentialSource({ OIDC_CLIENT_ID: 'abc' })).toBe(
      'client_id from OIDC_CLIENT_ID (self-host override), client_secret: MISSING'
    );
  });

  it('falls back to the Kubera-injected clientID when OIDC_CLIENT_ID is not set', () => {
    const description = describeOidcCredentialSource({
      clientID: '0oay3hbmshTHtvW4I4x7',
      clientSecret: 'sekrit',
    });
    expect(description).toBe(
      'client_id from clientID (Kubera auth.okta_app), client_secret: present (6 chars)'
    );
    expect(description).not.toContain('sekrit');
  });

  it('prefers OIDC_CLIENT_ID over clientID when both are set, matching auth.ts precedence', () => {
    const description = describeOidcCredentialSource({
      OIDC_CLIENT_ID: 'override-id',
      clientID: 'chart-id',
    });
    expect(description).toContain('OIDC_CLIENT_ID (self-host override)');
    expect(description).not.toContain('from clientID');
  });

  it('warns loudly when neither source is configured', () => {
    expect(describeOidcCredentialSource({})).toBe(
      'NONE FOUND - neither OIDC_CLIENT_ID nor clientID is set, OIDC client_id is undefined (login will fail)'
    );
  });
});

describe('hasConflictingOidcClientId', () => {
  it('is true when OIDC_CLIENT_ID and clientID are both set and differ', () => {
    // Regression: this exact combination - a stale hand-added OIDC_CLIENT_ID in
    // the Kubera secret store silently outranking the correctly-provisioned
    // clientID from auth.okta_app - caused Okta login to 400 for a week with
    // no log anywhere naming which credential was actually in play.
    expect(
      hasConflictingOidcClientId({
        OIDC_CLIENT_ID: '0oaw330m1lzLlY4G74x7',
        clientID: '0oay3hbmshTHtvW4I4x7',
      })
    ).toBe(true);
  });

  it('is false when the two values are identical', () => {
    expect(
      hasConflictingOidcClientId({
        OIDC_CLIENT_ID: 'same-id',
        clientID: 'same-id',
      })
    ).toBe(false);
  });

  it('is false when only one of the two is set', () => {
    expect(hasConflictingOidcClientId({ OIDC_CLIENT_ID: 'only-one' })).toBe(false);
    expect(hasConflictingOidcClientId({ clientID: 'only-one' })).toBe(false);
  });

  it('is false when neither is set', () => {
    expect(hasConflictingOidcClientId({})).toBe(false);
  });
});

describe('describeOidcClientIdConflictWarning', () => {
  it('returns null when there is no conflict', () => {
    expect(describeOidcClientIdConflictWarning({ OIDC_CLIENT_ID: 'abc' })).toBeNull();
    expect(describeOidcClientIdConflictWarning({})).toBeNull();
    expect(
      describeOidcClientIdConflictWarning({ OIDC_CLIENT_ID: 'same', clientID: 'same' })
    ).toBeNull();
  });

  it('names both conflicting values and states which one wins', () => {
    const warning = describeOidcClientIdConflictWarning({
      OIDC_CLIENT_ID: '0oaw330m1lzLlY4G74x7',
      clientID: '0oay3hbmshTHtvW4I4x7',
    });
    expect(warning).toContain('0oaw330m1lzLlY4G74x7');
    expect(warning).toContain('0oay3hbmshTHtvW4I4x7');
    expect(warning).toContain('OIDC_CLIENT_ID');
    expect(warning).toContain('clientID');
  });

  it('never leaks client_secret values, even when secrets are present in env', () => {
    const warning = describeOidcClientIdConflictWarning({
      OIDC_CLIENT_ID: 'id-a',
      clientID: 'id-b',
      OIDC_CLIENT_SECRET: 'top-secret-value',
      clientSecret: 'another-secret-value',
    });
    expect(warning).not.toContain('top-secret-value');
    expect(warning).not.toContain('another-secret-value');
  });
});
