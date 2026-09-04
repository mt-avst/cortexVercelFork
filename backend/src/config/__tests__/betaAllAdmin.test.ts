import {
  betaAllAdminEnabled,
  betaAllAdminDomains,
  betaLiftApplies,
  resolveEffectiveRole,
} from '../betaAllAdmin';

/**
 * The temporary internal-beta admin switch. These pins are the mutation anchors:
 * off by default, on only for the exact string 'true', bounded to an email-domain
 * allow-list (default adaptavist.com), lifts ONLY `employee` and ONLY to
 * `researcher_admin`, and can never produce `superadmin`.
 */
describe('CORTEX_BETA_ALL_ADMIN switch', () => {
  const KEY = 'CORTEX_BETA_ALL_ADMIN';
  const DOMAINS = 'CORTEX_BETA_ALL_ADMIN_DOMAINS';
  const originalKey = process.env[KEY];
  const originalDomains = process.env[DOMAINS];

  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  afterEach(() => {
    restore(KEY, originalKey);
    restore(DOMAINS, originalDomains);
  });

  describe('betaAllAdminEnabled', () => {
    it('is off when the env var is unset', () => {
      delete process.env[KEY];
      expect(betaAllAdminEnabled()).toBe(false);
    });

    it('is on only for the exact string "true"', () => {
      process.env[KEY] = 'true';
      expect(betaAllAdminEnabled()).toBe(true);
    });

    it.each(['false', 'TRUE', 'True', '1', 'yes', 'on', ''])(
      'stays off for the truthy-looking value %p',
      (value) => {
        process.env[KEY] = value;
        expect(betaAllAdminEnabled()).toBe(false);
      }
    );
  });

  describe('betaAllAdminDomains', () => {
    it('defaults to adaptavist.com when unset', () => {
      delete process.env[DOMAINS];
      expect(betaAllAdminDomains()).toEqual(['adaptavist.com']);
    });

    it('defaults when blank/whitespace', () => {
      process.env[DOMAINS] = '   ';
      expect(betaAllAdminDomains()).toEqual(['adaptavist.com']);
    });

    it('parses a comma/whitespace list, lower-cased and trimmed', () => {
      process.env[DOMAINS] = 'Adaptavist.com, Example.org  foo.io';
      expect(betaAllAdminDomains()).toEqual(['adaptavist.com', 'example.org', 'foo.io']);
    });
  });

  describe('resolveEffectiveRole', () => {
    it('is the identity for every role when the switch is off', () => {
      delete process.env[KEY];
      expect(resolveEffectiveRole('employee', 'x@adaptavist.com')).toBe('employee');
      expect(resolveEffectiveRole('researcher_admin', 'x@adaptavist.com')).toBe('researcher_admin');
      expect(resolveEffectiveRole('superadmin', 'x@adaptavist.com')).toBe('superadmin');
    });

    it('lifts an allow-listed employee to researcher_admin when on (default domain)', () => {
      process.env[KEY] = 'true';
      delete process.env[DOMAINS];
      expect(resolveEffectiveRole('employee', 'beta@adaptavist.com')).toBe('researcher_admin');
      // Case-insensitive on both sides.
      expect(resolveEffectiveRole('employee', 'Beta@Adaptavist.COM')).toBe('researcher_admin');
    });

    it('does NOT lift an employee outside the allow-list, even when on', () => {
      process.env[KEY] = 'true';
      delete process.env[DOMAINS];
      expect(resolveEffectiveRole('employee', 'stranger@gmail.com')).toBe('employee');
    });

    it('does NOT lift when the email is missing or malformed', () => {
      process.env[KEY] = 'true';
      expect(resolveEffectiveRole('employee', undefined)).toBe('employee');
      expect(resolveEffectiveRole('employee', null)).toBe('employee');
      expect(resolveEffectiveRole('employee', '')).toBe('employee');
      expect(resolveEffectiveRole('employee', 'no-at-sign')).toBe('employee');
      expect(resolveEffectiveRole('employee', 'trailing@')).toBe('employee');
    });

    it('does NOT lift a crafted local-part that embeds an allow-listed domain', () => {
      process.env[KEY] = 'true';
      delete process.env[DOMAINS];
      // A naive `lastIndexOf('@')` split would read the domain as
      // `adaptavist.com` here; there must be exactly one '@'.
      expect(resolveEffectiveRole('employee', 'x@evil.com@adaptavist.com')).toBe('employee');
      expect(resolveEffectiveRole('employee', '@adaptavist.com')).toBe('employee');
    });

    it('honours a custom domain list (and drops the default)', () => {
      process.env[KEY] = 'true';
      process.env[DOMAINS] = 'example.org';
      expect(resolveEffectiveRole('employee', 'a@example.org')).toBe('researcher_admin');
      expect(resolveEffectiveRole('employee', 'a@adaptavist.com')).toBe('employee');
    });

    it('leaves the two admin roles untouched when on', () => {
      process.env[KEY] = 'true';
      expect(resolveEffectiveRole('researcher_admin', 'a@adaptavist.com')).toBe('researcher_admin');
      expect(resolveEffectiveRole('superadmin', 'a@adaptavist.com')).toBe('superadmin');
    });

    it('NEVER produces superadmin, for any flag/email/input', () => {
      for (const flag of ['true', 'false']) {
        process.env[KEY] = flag;
        for (const email of ['a@adaptavist.com', 'a@gmail.com', undefined]) {
          expect(resolveEffectiveRole('employee', email)).not.toBe('superadmin');
          expect(resolveEffectiveRole('researcher_admin', email)).not.toBe('superadmin');
        }
      }
    });
  });

  describe('betaLiftApplies', () => {
    it('is false when the switch is off, whatever the domain', () => {
      delete process.env[KEY];
      expect(betaLiftApplies('beta@adaptavist.com')).toBe(false);
    });

    it('is true only for an allow-listed domain when on', () => {
      process.env[KEY] = 'true';
      delete process.env[DOMAINS];
      expect(betaLiftApplies('beta@adaptavist.com')).toBe(true);
      expect(betaLiftApplies('stranger@gmail.com')).toBe(false);
      expect(betaLiftApplies(undefined)).toBe(false);
    });

    it('is false for a crafted local-part that embeds an allow-listed domain', () => {
      process.env[KEY] = 'true';
      delete process.env[DOMAINS];
      expect(betaLiftApplies('x@evil.com@adaptavist.com')).toBe(false);
    });
  });
});
