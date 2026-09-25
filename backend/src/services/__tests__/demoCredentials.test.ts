import { describe, it, expect, jest } from '@jest/globals';
import {
  DEMO_ACCOUNT_EMAILS,
  MIN_DEMO_PASSWORD_LENGTH,
  findDemoAccount,
  hashDemoPassword,
  isCredentialedDemoLoginEnabled,
  seedDemoCredentials,
  verifyDemoPassword,
} from '../demoCredentials';

/**
 * Password sign-in for the seeded demo accounts on Vercel previews. The owner's
 * rule (2026-09-25): demo credentials are seeded, and nobody gets in without
 * them. So: no password seeded -> no rows -> nobody in; production can never
 * enable it; and a wrong password, an unknown email and a malformed hash all
 * say no without throwing.
 */
describe('isCredentialedDemoLoginEnabled', () => {
  it('is on only for an opted-in Vercel preview', () => {
    expect(isCredentialedDemoLoginEnabled({ ENABLE_DEMO_LOGIN: 'true', VERCEL_ENV: 'preview' })).toBe(true);
  });

  it.each([
    [{ ENABLE_DEMO_LOGIN: 'true', VERCEL_ENV: 'production' }],
    [{ ENABLE_DEMO_LOGIN: 'true' }],
    [{ VERCEL_ENV: 'preview' }],
    [{ ENABLE_DEMO_LOGIN: '1', VERCEL_ENV: 'preview' }],
    [{ NODE_ENV: 'development' }],
  ])('is off for %j', (env) => {
    expect(isCredentialedDemoLoginEnabled(env)).toBe(false);
  });
});

describe('password hashing', () => {
  const password = 'correct horse battery staple';
  const stored = hashDemoPassword(password);

  it('verifies the right password (control)', () => {
    expect(verifyDemoPassword(password, stored)).toBe(true);
  });

  it('refuses a wrong password', () => {
    expect(verifyDemoPassword(`${password}!`, stored)).toBe(false);
  });

  it('salts: the same password hashes differently each time', () => {
    expect(hashDemoPassword(password)).not.toBe(stored);
  });

  it('refuses, without throwing, a malformed or foreign hash', () => {
    for (const bad of ['', 'plaintext', 'bcrypt$x$y', 'scrypt$1$8$1$AAAA$AAAA', 'scrypt$x$y$z$w$v']) {
      expect(verifyDemoPassword(password, bad)).toBe(false);
    }
  });

  it('never stores the password itself', () => {
    expect(stored).not.toContain(password);
  });
});

type Call = [string, unknown[] | undefined];
const recordingClient = (rows: unknown[] = []) => {
  const calls: Call[] = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    calls.push([sql, params]);
    return { rows };
  });
  return { client: { query } as never, calls };
};

describe('seedDemoCredentials', () => {
  it('revokes every demo credential when SEED_DEMO_PASSWORD is unset', async () => {
    const { client, calls } = recordingClient();
    await expect(seedDemoCredentials(client, {})).resolves.toBe('revoked');
    expect(calls.map(([sql]) => sql)).toEqual(['DELETE FROM demo_credentials']);
  });

  it(`revokes rather than seeds a password shorter than ${MIN_DEMO_PASSWORD_LENGTH} characters`, async () => {
    const { client, calls } = recordingClient();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(seedDemoCredentials(client, { SEED_DEMO_PASSWORD: 'short' })).resolves.toBe('revoked');
    expect(calls.map(([sql]) => sql)).toEqual(['DELETE FROM demo_credentials']);
    warn.mockRestore();
  });

  it('seeds a hash - never the password - for each seeded demo account', async () => {
    const { client, calls } = recordingClient();
    const password = 'a-long-enough-demo-password';
    await expect(seedDemoCredentials(client, { SEED_DEMO_PASSWORD: password })).resolves.toBe('seeded');
    expect(calls.map(([, params]) => params?.[0])).toEqual([...DEMO_ACCOUNT_EMAILS]);
    for (const [, params] of calls) {
      expect(String(params?.[1])).toMatch(/^scrypt\$/);
      expect(verifyDemoPassword(password, String(params?.[1]))).toBe(true);
    }
  });
});

describe('findDemoAccount', () => {
  const account = {
    id: '633608bc-4b0e-4d60-a498-e680ee97c252',
    email: 'admin@test.com',
    name: 'Test Admin',
    business_unit: 'Research',
    role_title: 'Research Manager',
    role: 'researcher_admin',
  };
  const password = 'a-long-enough-demo-password';

  it('returns the account, without its hash, for the right password (control)', async () => {
    const { client } = recordingClient([{ ...account, password_hash: hashDemoPassword(password) }]);
    await expect(findDemoAccount(client, 'admin@test.com', password)).resolves.toEqual(account);
  });

  it('returns null for the wrong password', async () => {
    const { client } = recordingClient([{ ...account, password_hash: hashDemoPassword(password) }]);
    await expect(findDemoAccount(client, 'admin@test.com', 'wrong-password-here')).resolves.toBeNull();
  });

  it('returns null for an email with no credential (nothing seeded)', async () => {
    const { client } = recordingClient([]);
    await expect(findDemoAccount(client, 'admin@test.com', password)).resolves.toBeNull();
  });
});
