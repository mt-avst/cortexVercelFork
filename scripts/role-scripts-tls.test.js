'use strict';

/**
 * Run with: node --test scripts/role-scripts-tls.test.js
 *
 * The TLS gate, asserted at EVERY script that reaches the database with
 * privilege, not just the one the finding was raised against. The flaw was
 * systemic - four scripts in this directory shared the same
 * `ssl: { rejectUnauthorized: false }` and the same connection-string cleanup
 * block - so the regression test has to be systemic too. A helper applied to
 * one call site and missed on another is the obvious next failure.
 *
 * These drive the real scripts as subprocesses. That is safe for
 * reset-keep-two-users.js, which deletes data, because every case here either
 * exits at the TLS gate before a Pool is constructed, or runs under
 * capture-pool-config.js, which replaces the Pool and exits before it can
 * connect. No case reaches a query, and the host never resolves.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const TSX = path.join(repoRoot, 'backend', 'node_modules', '.bin', 'tsx');
const FIXTURE = path.join(repoRoot, 'scripts', 'lib', 'capture-pool-config.js');

// Nothing in CI runs this suite, so a silent skip would mean a security control
// verified by nothing. Missing tooling is a hard error.
if (!fs.existsSync(TSX)) {
  throw new Error(`tsx not found at ${TSX} - run \`npm ci\` in backend/ before running these tests`);
}

const RDS = 'postgres://u:pw@cortex.abc123.eu-west-1.rds.amazonaws.com:5432/app';

const CA_FIXTURE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'role-scripts-ca-')),
  'global-bundle.pem'
);
fs.writeFileSync(CA_FIXTURE, '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n');

/**
 * The scripts converted to the helper in this change.
 *
 * This is now every script under scripts/ that opens a database connection with
 * privilege. Keep it that way: a new script here that builds its own Pool needs
 * an entry, or the guard silently stops covering the thing it exists to cover.
 */
const SCRIPTS = [
  { name: 'set-superadmin.js', file: 'scripts/set-superadmin.js', args: ['someone@adaptavist.com'] },
  { name: 'set-superadmin.ts', file: 'scripts/set-superadmin.ts', args: ['someone@adaptavist.com'] },
  {
    name: 'set-researcher-admin.ts',
    file: 'scripts/set-researcher-admin.ts',
    args: ['someone@adaptavist.com'],
  },
  {
    // --yes is required, and is passed here so the TLS cases reach the point
    // where a Pool would be built. Nothing can connect regardless: run() loads
    // capture-pool-config.js for every spawn, which replaces the Pool and exits
    // before pool.connect(), and the test host does not resolve.
    name: 'reset-keep-two-users.js',
    file: 'scripts/reset-keep-two-users.js',
    args: ['--yes'],
  },
  {
    // Validates three env vars before it builds a Pool, so they have to be
    // present for the TLS cases to reach the gate at all. --dry-run is belt and
    // braces on top of the capture fixture: even if it did connect, it would
    // write nothing.
    name: 'migrate-tokens.ts',
    file: 'scripts/migrate-tokens.ts',
    args: ['--dry-run'],
    env: {
      ENCRYPTION_KEY: '0'.repeat(64),
      GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret',
    },
  },
];

function run(script, env) {
  const isTs = script.file.endsWith('.ts');
  const target = path.join(repoRoot, script.file);
  const result = spawnSync(isTs ? TSX : process.execPath, [target, ...script.args], {
    // The capture fixture is set for EVERY case, not just the ones that read
    // it back. reset-keep-two-users.js deletes bookings, sessions and
    // opportunities, and it is driven from a shared loop where the next case
    // is easy to write wrongly. With the fixture always loaded, no case in
    // this file can reach a real connection even if it neither refuses nor
    // checks the config - a mistake surfaces as `exit 3` rather than as a
    // deleted database. Verified not to change refusal outcomes: a refusal
    // happens before any Pool is constructed.
    env: {
      PATH: process.env.PATH,
      CORTEX_CAPTURE_POOL_CONFIG: '1',
      NODE_OPTIONS: `--require ${FIXTURE}`,
      // Anything the script needs before it reaches the Pool at all.
      ...(script.env || {}),
      ...env,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  // result.error carries the spawn failure (notably a timeout, which leaves
  // status null); dropping it turns "the process never ran" into an assertion
  // reading `null !== 1` with nothing to diagnose from.
  const failure = result.error ? `\nspawn error: ${result.error.message}` : '';
  const signal = result.signal ? `\nkilled by signal: ${result.signal}` : '';
  return {
    status: result.status,
    out: `${result.stdout || ''}${result.stderr || ''}${failure}${signal}`,
  };
}

/** What pg would actually connect with, resolved through a real pg Client. */
function capturedSsl(script, env) {
  const { status, out } = run(script, { PGSSLROOTCERT: CA_FIXTURE, ...env });
  const line = /POOL_SSL_CONFIG:(.*)/.exec(out);
  assert.ok(line, `no Pool config captured (exit ${status}); output was:\n${out}`);
  assert.equal(status, 3, 'the capture fixture must not exit 0');
  return JSON.parse(line[1]);
}

for (const script of SCRIPTS) {
  describe(script.name, () => {
    test('connects to a remote database with a verifying TLS config', () => {
      const ssl = capturedSsl(script, { DATABASE_URL: RDS });
      assert.equal(ssl.kind, 'object', 'the connection would carry no TLS at all');
      assert.notEqual(ssl.rejectUnauthorized, false, 'the connection would not verify the server');
      assert.equal(ssl.hasCa, true, 'the connection would trust the public root store');
      assert.equal(ssl.replacedHostnameCheck, false, 'hostname checking was replaced');
    });

    test('refuses a remote database when there is no CA to verify against', () => {
      const { status, out } = run(script, { DATABASE_URL: RDS });
      assert.equal(status, 1);
      assert.match(out, /PGSSLROOTCERT/);
    });

    // Each of these reached a weaker connection than the script reported,
    // before the TLS parameters were stripped from the connection string.
    for (const [label, query] of [
      ['?ssl=0', '?ssl=0'],
      ['a duplicated sslmode', '?sslmode=verify-full&sslmode=no-verify'],
      ['a duplicated host', '?host=localhost&host=cortex.abc.eu-west-1.rds.amazonaws.com'],
      ['uselibpqcompat', '?uselibpqcompat=true&sslmode=verify-full'],
      ['sslmode=disable', '?sslmode=disable'],
    ]) {
      test(`refuses ${label}`, () => {
        const { status } = run(script, {
          DATABASE_URL: `${RDS}${query}`,
          PGSSLROOTCERT: CA_FIXTURE,
        });
        assert.equal(status, 1, `${label} was not refused`);
      });
    }

    test('keeps the operator CA when the string carries sslmode=verify-full', () => {
      const ssl = capturedSsl(script, { DATABASE_URL: `${RDS}?sslmode=verify-full` });
      assert.equal(ssl.hasCa, true, 'the CA was discarded in favour of the public root store');
    });
  });
}

// The argument gate on the multi-email script. It is not the finding this MR
// was raised for, but it is the same class: an argument that reads as valid,
// promotes nobody, and exits reporting success.
describe('set-researcher-admin.ts argument gate', () => {
  const script = SCRIPTS.find((s) => s.name === 'set-researcher-admin.ts');

  test('refuses a whitespace-only email rather than exiting 0 having done nothing', () => {
    const { status, out } = run({ ...script, args: ['   '] }, { DATABASE_URL: RDS });
    assert.equal(status, 1);
    assert.match(out, /Usage:/);
    assert.doesNotMatch(out, /Done\./);
  });

  test('refuses no arguments at all', () => {
    const { status, out } = run({ ...script, args: [] }, { DATABASE_URL: RDS });
    assert.equal(status, 1);
    assert.match(out, /Usage:/);
  });
});

// The confirmation flag on the destructive script. It deletes every booking,
// session and opportunity and takes no target argument, so the guard is the
// only thing between a mistyped DATABASE_URL and an emptied database.
describe('reset-keep-two-users.js confirmation', () => {
  const script = SCRIPTS.find((s) => s.name === 'reset-keep-two-users.js');
  const withCa = { DATABASE_URL: RDS, PGSSLROOTCERT: CA_FIXTURE };

  test('refuses to run without --yes', () => {
    const { status, out } = run({ ...script, args: [] }, withCa);
    assert.equal(status, 1);
    assert.match(out, /--yes/);
    assert.match(out, /deletes EVERY booking, session and opportunity/);
    // It must not have got as far as building a Pool.
    assert.doesNotMatch(out, /POOL_SSL_CONFIG/);
  });

  test('names the database it would have emptied, so a wrong environment shows', () => {
    const { out } = run({ ...script, args: [] }, withCa);
    assert.match(out, /cortex\.abc123\.eu-west-1\.rds\.amazonaws\.com:5432\/app/);
  });

  test('never prints the password in that message', () => {
    const { out } = run({ ...script, args: [] }, {
      DATABASE_URL: 'postgres://u:hunter2@cortex.abc123.eu-west-1.rds.amazonaws.com:5432/app',
      PGSSLROOTCERT: CA_FIXTURE,
    });
    assert.doesNotMatch(out, /hunter2/);
  });

  test('a near-miss flag does not count as confirmation', () => {
    for (const flag of ['--Yes', '-y', 'yes', '--yes=true']) {
      const { status } = run({ ...script, args: [flag] }, withCa);
      assert.equal(status, 1, `${flag} was accepted as confirmation`);
    }
  });

  test('the TLS gate still runs first, so --yes cannot buy an unverified connection', () => {
    const { status, out } = run({ ...script, args: ['--yes'] }, { DATABASE_URL: RDS });
    assert.equal(status, 1);
    assert.match(out, /PGSSLROOTCERT/);
  });
});

// migrate-tokens.ts gated TLS on NODE_ENV rather than on the host, so an
// operator running it from a laptop against a remote database - NODE_ENV
// unset - got a cleartext connection carrying OAuth token material. The host
// decides now, not the environment name.
describe('migrate-tokens.ts does not decide TLS from NODE_ENV', () => {
  const script = SCRIPTS.find((s) => s.name === 'migrate-tokens.ts');

  for (const nodeEnv of [undefined, 'development', 'test', 'production']) {
    test(`verifies against a remote host with NODE_ENV=${nodeEnv ?? '(unset)'}`, () => {
      const ssl = capturedSsl(script, {
        DATABASE_URL: RDS,
        ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}),
      });
      assert.equal(ssl.kind, 'object', `NODE_ENV=${nodeEnv} produced a cleartext connection`);
      assert.notEqual(ssl.rejectUnauthorized, false);
      assert.equal(ssl.hasCa, true);
    });
  }
});
