import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * The TLS wiring at the call sites that are NOT the application pool.
 *
 * dbTls.ts has thorough unit tests and pool.test.ts pins the application pool,
 * but a security gate mutated each of the sites below back to
 * `rejectUnauthorized: false` and the whole backend suite stayed green - the
 * helper was tested, the wiring was not. The initContainer is the
 * highest-consequence site in the change and had no coverage at all.
 *
 * These spawn the real entry points against an RDS-SHAPED HOST THAT DOES NOT
 * RESOLVE. That is what makes it safe to drive reset-production-db.ts, which
 * deletes bookings and opportunities: the TLS decision is logged before the
 * Pool is constructed, and the connection then fails at DNS, so no query is
 * ever issued. Each also gets an env with no DATABASE_URL inherited.
 */

const backendRoot = path.resolve(__dirname, '../../..');
const TSX = path.join(backendRoot, 'node_modules', '.bin', 'tsx');

// Shaped like RDS so the helper takes the remote branch; a subdomain that does
// not exist, so the connection dies at DNS before any SQL.
const UNRESOLVABLE_RDS =
  'postgres://u:pw@cortex-does-not-exist.abc123.eu-west-1.rds.amazonaws.com:5432/app';

// A single-label host, which is what the local branch keys on - but deliberately
// NOT the compose service name.
//
// The first version of this used docker-compose.yml's DATABASE_URL verbatim,
// which was a route to data loss: one of the sites below is
// reset-production-db.ts, and inside the compose network `postgres` resolves
// with those exact credentials. The assertion here is satisfied BEFORE the
// connection is attempted, so it would have passed whether or not the deletes
// ran - the host failing to resolve was a property of one machine, not of the
// test. Nothing here may be reachable even if the name does resolve.
const UNREACHABLE_LOCAL = 'postgresql://u:pw@no-such-database-host:1/nothing';

if (!fs.existsSync(TSX)) {
  throw new Error(`tsx not found at ${TSX} - run \`npm ci\` in backend/`);
}

interface Site {
  name: string;
  command: string;
  args: string[];
  label: string;
}

const SITES: Site[] = [
  {
    name: 'firsthand-migrate.mjs (the deploy initContainer)',
    command: process.execPath,
    args: [path.join(backendRoot, 'scripts', 'firsthand-migrate.mjs')],
    label: 'firsthand-migrate',
  },
  {
    name: 'reset-production-db.ts',
    command: TSX,
    args: [path.join(backendRoot, 'src', 'db', 'reset-production-db.ts')],
    label: 'reset-production-db',
  },
  {
    name: 'add-missing-study-types.ts',
    command: TSX,
    args: [path.join(backendRoot, 'src', 'db', 'add-missing-study-types.ts')],
    label: 'add-missing-study-types',
  },
];

function run(site: Site, env: Record<string, string | undefined>) {
  const result = spawnSync(site.command, site.args, {
    cwd: backendRoot,
    env: { PATH: process.env.PATH, DATABASE_URL: UNRESOLVABLE_RDS, ...env } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const failure = result.error ? `\nspawn error: ${result.error.message}` : '';
  return { status: result.status, out: `${result.stdout || ''}${result.stderr || ''}${failure}` };
}

/**
 * A guard on this file rather than on the code, because the risk lives here.
 *
 * The first version used docker-compose.yml's DATABASE_URL verbatim while
 * driving reset-production-db.ts, which deletes bookings, sessions and
 * opportunities. No behavioural assertion can catch that - the log line under
 * test is emitted before the connection is attempted, so the suite passes
 * whether or not the deletes run. The only thing that can catch it is a check
 * that the connection strings used here are not ones that could reach a real
 * database.
 */
describe('the connection strings this file uses cannot reach a real database', () => {
  const composeUrls = ['docker-compose.yml', 'docker-compose.dev.yml', 'docker-compose.prod.yml']
    .map((file) => path.resolve(backendRoot, '..', file))
    .filter((file) => fs.existsSync(file))
    .flatMap((file) => fs.readFileSync(file, 'utf8').match(/postgres(?:ql)?:\/\/\S+/g) || [])
    .map((url) => url.trim());

  it('found the compose files, so this guard is not vacuous', () => {
    expect(composeUrls.length).toBeGreaterThan(0);
  });

  it.each([UNRESOLVABLE_RDS, UNREACHABLE_LOCAL])('%s is not a compose database', (url) => {
    expect(composeUrls).not.toContain(url);
    // Nor the same host and credentials with a different database name.
    const host = new URL(url).host;
    for (const composeUrl of composeUrls) {
      expect(new URL(composeUrl).host).not.toBe(host);
    }
  });
});

describe.each(SITES)('$name applies the shared TLS decision', (site) => {
  it('encrypts by default and says the certificate is unverified', () => {
    const { out } = run(site, {});
    expect(out).toMatch(new RegExp(`\\[db-tls:${site.label}\\]`));
    expect(out).toMatch(/UNVERIFIED TLS/);
    // It got as far as trying to connect, and no further.
    expect(out).toMatch(/ENOTFOUND|getaddrinfo|EAI_AGAIN/);
  }, 60_000);

  it('verifies against the bundled CA once DB_TLS_VERIFY is set', () => {
    const { out } = run(site, { DB_TLS_VERIFY: '1' });
    expect(out).toMatch(new RegExp(`\\[db-tls:${site.label}\\] verified TLS`));
    expect(out).toMatch(/rds-global-bundle\.pem/);
    expect(out).not.toMatch(/UNVERIFIED/);
  }, 60_000);

  it('treats a local database as local rather than forcing TLS on it', () => {
    const { out } = run(site, { DATABASE_URL: UNREACHABLE_LOCAL });
    expect(out).toMatch(new RegExp(`\\[db-tls:${site.label}\\] local host`));
  }, 60_000);
});
