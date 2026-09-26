import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';

type Env = Record<string, string | undefined>;

/**
 * PASSWORD SIGN-IN FOR THE SEEDED DEMO ACCOUNTS, on Vercel previews.
 *
 * Previews get a new hostname per branch, which the Okta app has no redirect
 * URI for, so a preview cannot use SSO. The open demo routes (/auth/demo-login
 * and friends sign anyone in with no credential) stay development-only; a
 * preview instead signs in with a seeded account's email plus the password
 * seeded from SEED_DEMO_PASSWORD at build time. No password seeded, no rows,
 * nobody gets in.
 *
 * ponytail: one shared demo password, set per Vercel environment, stands in for
 *   SSO on previews -> replace with an Okta app whose redirect URIs cover the
 *   preview domain before previews carry anything but seed data.
 */

/** The seeded accounts a demo password is issued for (db/seed.ts). */
export const DEMO_ACCOUNT_EMAILS = [
  'demo@example.com',
  'demo2@example.com',
  'admin@test.com',
  'superadmin@test.com',
] as const;

/** Long enough that a guessed password is not the weak link on a public host. */
export const MIN_DEMO_PASSWORD_LENGTH = 16;

// scrypt cost parameters (N=2^15, r=8, p=1): ~32 MiB and tens of ms per check,
// so the auth rate limiter, not the hash, is what bounds an online guess.
const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEM = 64 * 1024 * 1024;

/**
 * Whether the password sign-in exists at all. Both conditions are required:
 * ENABLE_DEMO_LOGIN is the opt-in, and VERCEL_ENV is set by the platform and is
 * 'preview' only on preview deployments - never in production, never off
 * Vercel - so no value of the opt-in reaches production.
 */
export function isCredentialedDemoLoginEnabled(env: Env = process.env): boolean {
  return env.ENABLE_DEMO_LOGIN === 'true' && env.VERCEL_ENV === 'preview';
}

export function hashDemoPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Constant-time check of a password against a stored `scrypt$...` hash. Never throws. */
export function verifyDemoPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length !== KEY_LENGTH) return false;
  try {
    const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), KEY_LENGTH, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAX_MEM,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Verified against when the email has no credential, so an unknown email costs
// the same scrypt run as a wrong password and the response time does not say
// which emails are demo accounts.
const DUMMY_HASH = hashDemoPassword(randomBytes(24).toString('base64'));

export interface DemoAccount {
  id: string;
  email: string;
  name: string;
  business_unit: string;
  role_title: string;
  role: string;
}

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Seeds (or revokes) the demo password. Called from db/seed.ts on every build.
 *
 * Set and long enough: every demo account gets a fresh hash of it. Unset or too
 * short: every demo credential is DELETED, so removing the variable and
 * redeploying locks the door rather than leaving the last password working.
 */
export async function seedDemoCredentials(
  client: Queryable,
  env: Env = process.env
): Promise<'seeded' | 'revoked'> {
  const password = env.SEED_DEMO_PASSWORD ?? '';
  if (password.length < MIN_DEMO_PASSWORD_LENGTH) {
    await client.query('DELETE FROM demo_credentials');
    if (password.length > 0) {
      console.warn(
        `⚠️  SEED_DEMO_PASSWORD is shorter than ${MIN_DEMO_PASSWORD_LENGTH} characters - ` +
          'demo credentials revoked, nobody can use password sign-in'
      );
    }
    return 'revoked';
  }

  for (const email of DEMO_ACCOUNT_EMAILS) {
    await client.query(
      `INSERT INTO demo_credentials (user_id, password_hash)
       SELECT id, $2 FROM users WHERE email = $1
       ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`,
      [email, hashDemoPassword(password)]
    );
  }
  return 'seeded';
}

/** The account for these credentials, or null. Same work whether or not the email exists. */
export async function findDemoAccount(
  client: Queryable,
  email: string,
  password: string
): Promise<DemoAccount | null> {
  const result = await client.query(
    `SELECT u.id, u.email, u.name, u.business_unit, u.role_title, u.role, c.password_hash
       FROM demo_credentials c JOIN users u ON u.id = c.user_id
      WHERE lower(u.email) = lower($1)`,
    [email.trim()]
  );
  const row = result.rows[0] as (DemoAccount & { password_hash: string }) | undefined;
  const ok = verifyDemoPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) return null;
  const { password_hash: _hash, ...account } = row;
  return account;
}
