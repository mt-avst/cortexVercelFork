'use strict';

/**
 * Run with: node --test scripts/set-superadmin.test.js
 *
 * Spawns the scripts rather than importing them, because what is under test is
 * the refusal to run at all: the argument gate and the TLS gate both call
 * process.exit before any database work, and only a real invocation proves the
 * script stops there.
 *
 * The .js and .ts files are duplicates of each other, so both are driven -
 * a fix applied to one and missed on the other is the obvious failure here.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const JS_SCRIPT = path.join(repoRoot, 'scripts', 'set-superadmin.js');
const TS_SCRIPT = path.join(repoRoot, 'scripts', 'set-superadmin.ts');
const TSX = path.join(repoRoot, 'backend', 'node_modules', '.bin', 'tsx');

const RDS_URL = 'postgres://u:pw@cortex.abc123.eu-west-1.rds.amazonaws.com:5432/app';

// The helper only reads this file; it never parses it, so any bytes will do.
const CA_FIXTURE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'superadmin-ca-')),
  'global-bundle.pem'
);
fs.writeFileSync(CA_FIXTURE, '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n');

function run(argv, env, useTs = false) {
  const cmd = useTs ? TSX : process.execPath;
  const args = useTs ? [TS_SCRIPT, ...argv] : [JS_SCRIPT, ...argv];
  const result = spawnSync(cmd, args, {
    env: { PATH: process.env.PATH, ...env },
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

/** Runs the script under the capture fixture and returns what pg would connect with. */
function capturedSsl(argv, env, useTs) {
  const { status, out } = run(argv, {
    ...env,
    PGSSLROOTCERT: env.PGSSLROOTCERT || CA_FIXTURE,
    CORTEX_CAPTURE_POOL_CONFIG: '1',
    NODE_OPTIONS: `--require ${path.join(repoRoot, 'scripts', 'lib', 'capture-pool-config.js')}`,
  }, useTs);
  const line = /POOL_SSL_CONFIG:(.*)/.exec(out);
  assert.ok(line, `no Pool config captured (exit ${status}); output was:\n${out}`);
  assert.equal(status, 3, 'the capture fixture must not exit 0');
  return JSON.parse(line[1]);
}

// Nothing in CI runs these, so the local matrix is the whole gate - and a
// suite that reports success having silently skipped half of it is exactly the
// failure mode this MR exists to remove. Missing tooling is a hard error.
if (!fs.existsSync(TSX)) {
  throw new Error(`tsx not found at ${TSX} - run \`npm ci\` in backend/ before running these tests`);
}

const variants = [
  { name: 'set-superadmin.js', useTs: false },
  { name: 'set-superadmin.ts', useTs: true },
];

for (const variant of variants) {
  describe(variant.name, () => {
    test('refuses to run with no email, rather than promoting a default', () => {
      const { status, out } = run([], { DATABASE_URL: RDS_URL }, variant.useTs);
      assert.equal(status, 1);
      assert.match(out, /Usage:/);
      // The regression that matters: this address used to be the default, so a
      // dropped argument silently granted superadmin to it.
      assert.doesNotMatch(out, /Setting superadmin role for nfine@adaptavist\.com/);
      assert.doesNotMatch(out, /Found user/);
    });

    test('refuses an empty or whitespace-only email', () => {
      const { status, out } = run(['   '], { DATABASE_URL: RDS_URL }, variant.useTs);
      assert.equal(status, 1);
      assert.match(out, /Usage:/);
    });

    test('refuses to connect to RDS without a CA to verify against', () => {
      const { status, out } = run(['someone@adaptavist.com'], { DATABASE_URL: RDS_URL }, variant.useTs);
      assert.equal(status, 1);
      assert.match(out, /PGSSLROOTCERT/);
      assert.doesNotMatch(out, /Found user/);
    });

    test('refuses an sslmode that would skip verification', () => {
      const { status, out } = run(
        ['someone@adaptavist.com'],
        { DATABASE_URL: `${RDS_URL}?sslmode=no-verify` },
        variant.useTs
      );
      assert.equal(status, 1);
      assert.match(out, /sslmode=no-verify/);
      assert.doesNotMatch(out, /Found user/);
    });

    test('still reports a missing connection string', () => {
      const { status, out } = run(['someone@adaptavist.com'], {}, variant.useTs);
      assert.equal(status, 1);
      assert.match(out, /DATABASE_URL/);
    });

    // The gates above all return before the Pool is built, so on their own
    // they pass just as happily against a Pool constructed with
    // ssl: { rejectUnauthorized: false } - the exact regression this change
    // exists to prevent. Three mutations proved that.
    //
    // This asserts on what the REAL driver would connect with, resolved
    // through pg's own ConnectionParameters. Asserting on the argument handed
    // to new Pool() is not enough: pg merges the connection string over the
    // ssl option, so a verifying argument and a cleartext connection coexist
    // happily. See capture-pool-config.js.
    test('connects to RDS with a verifying TLS config', () => {
      const ssl = capturedSsl(['someone@adaptavist.com'], { DATABASE_URL: RDS_URL }, variant.useTs);
      assert.equal(ssl.kind, 'object', 'the connection would carry no TLS at all');
      assert.notEqual(ssl.rejectUnauthorized, false, 'the connection would not verify the server');
      assert.equal(ssl.hasCa, true, 'the connection would trust the public root store');
      assert.equal(ssl.replacedHostnameCheck, false, 'hostname checking was replaced');
    });

    // Each of these produced a weaker connection than the script reported,
    // before the TLS parameters were stripped from the string.
    for (const [label, query] of [
      ['?ssl=0', '?ssl=0'],
      ['a duplicated sslmode', '?sslmode=verify-full&sslmode=no-verify'],
      ['uselibpqcompat', '?uselibpqcompat=true&sslmode=verify-full'],
      ['a duplicated host', '?host=localhost&host=cortex.abc.eu-west-1.rds.amazonaws.com'],
    ]) {
      test(`refuses ${label} rather than connecting more weakly than it reports`, () => {
        const { status, out } = run(
          ['someone@adaptavist.com'],
          { DATABASE_URL: `${RDS_URL}${query}`, PGSSLROOTCERT: CA_FIXTURE },
          variant.useTs
        );
        assert.equal(status, 1);
        assert.doesNotMatch(out, /Found user/);
      });
    }

    test('a connection string carrying sslmode=verify-full keeps the operator CA', () => {
      const ssl = capturedSsl(
        ['someone@adaptavist.com'],
        { DATABASE_URL: `${RDS_URL}?sslmode=verify-full` },
        variant.useTs
      );
      assert.equal(ssl.hasCa, true, 'the CA was discarded in favour of the public root store');
    });
  });
}
