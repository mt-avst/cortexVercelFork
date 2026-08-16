'use strict';

/**
 * Run with: node --test scripts/lib/pg-ssl.test.js
 *
 * THESE ASSERT ON THE CONFIG pg WOULD CONNECT WITH, not on the object the
 * helper returns. That distinction is the entire point of this file.
 *
 * pg merges a parsed connection string OVER the explicit ssl option
 * (connection-parameters.js: `config = Object.assign({}, config,
 * parse(config.connectionString))`), so a helper can return a perfectly
 * verifying config and the driver can still connect in cleartext. An earlier
 * version of these tests checked the returned object and passed while
 * `?ssl=0`, `?sslmode=verify-full` and a duplicated `sslmode` all produced a
 * weaker connection than the one asserted.
 *
 * `effectiveSsl` runs the same merge pg does, by asking pg.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');

const { buildPgSslConfig } = require('./pg-ssl');

const RDS = 'postgres://u:pw@cortex.abc123.eu-west-1.rds.amazonaws.com:5432/app';
const NEON = 'postgres://u:pw@ep-x.eu-central-1.aws.neon.tech:5432/app';
const LOCAL = 'postgres://u:pw@localhost:5432/app';

const caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ssl-test-'));
const caPath = path.join(caDir, 'global-bundle.pem');
const CA_PEM = '-----BEGIN CERTIFICATE-----\nnot-a-real-ca\n-----END CERTIFICATE-----\n';
fs.writeFileSync(caPath, CA_PEM);

/** What pg would actually connect with, given what the helper returned. */
function effectiveSsl(result) {
  return new Client(result).connectionParameters.ssl;
}

/** Resolve to a verdict so a refusal and a connection can be compared uniformly. */
function outcome(connectionString, env) {
  let result;
  try {
    result = buildPgSslConfig(connectionString, env);
  } catch (error) {
    return { refused: true, message: error.message };
  }
  return { refused: false, ssl: effectiveSsl(result), result };
}

function assertVerifying(o, label) {
  assert.equal(o.refused, false, `${label}: unexpectedly refused`);
  assert.ok(o.ssl && typeof o.ssl === 'object', `${label}: pg would use ssl=${o.ssl}`);
  assert.notEqual(o.ssl.rejectUnauthorized, false, `${label}: verification disabled`);
  assert.ok(o.ssl.ca, `${label}: pg would fall back to the public root store`);
  assert.equal(
    typeof o.ssl.checkServerIdentity,
    'undefined',
    `${label}: hostname checking was replaced`
  );
}

describe('buildPgSslConfig', () => {
  describe('the connection string cannot override the decision', () => {
    // Each of these produced a weaker connection than the helper reported,
    // measured against pg 8.18.0 / pg-connection-string 2.11.0.
    test('?ssl=0 cannot force a plaintext connection', () => {
      const o = outcome(`${RDS}?ssl=0`, { PGSSLROOTCERT: caPath });
      assert.equal(o.refused, true);
      assert.match(o.message, /ssl=0/);
    });

    test('a duplicated sslmode cannot smuggle no-verify past the first value', () => {
      const o = outcome(`${RDS}?sslmode=verify-full&sslmode=no-verify`, { PGSSLROOTCERT: caPath });
      assert.equal(o.refused, true);
      assert.match(o.message, /no-verify/);
    });

    test('a duplicated sslmode cannot smuggle disable past the first value', () => {
      const o = outcome(`${RDS}?sslmode=verify-full&sslmode=disable`, { PGSSLROOTCERT: caPath });
      assert.equal(o.refused, true);
      assert.match(o.message, /disable/);
    });

    test('sslmode=verify-full keeps OUR CA rather than discarding it', () => {
      // The remedy the old error message recommended. It parsed to `ssl: {}`,
      // dropping the operator's CA and falling back to the public root store -
      // which fails against RDS, whose roots are not publicly trusted.
      const o = outcome(`${RDS}?sslmode=verify-full`, { PGSSLROOTCERT: caPath });
      assertVerifying(o, 'sslmode=verify-full');
      assert.equal(o.ssl.ca, CA_PEM);
    });

    test('uselibpqcompat cannot switch the accepted modes to weaker semantics', () => {
      // Paired with verify-FULL, not verify-ca: verify-ca is refused by the
      // mode check on its own, so that version of this test passed without
      // exercising the uselibpqcompat branch at all.
      const o = outcome(`${RDS}?uselibpqcompat=true&sslmode=verify-full`, { PGSSLROOTCERT: caPath });
      assert.equal(o.refused, true);
      assert.match(o.message, /uselibpqcompat/);
    });

    test('a host query parameter cannot point pg at a server the gate never judged', () => {
      // pg-connection-string prefers ?host= over the URL authority, so a
      // localhost-looking string can dial a remote database.
      const o = outcome(`${LOCAL}?host=cortex.abc.eu-west-1.rds.amazonaws.com`, {});
      assert.equal(o.refused, true, 'a remote host reached via ?host= must still need a CA');
      assert.match(o.message, /rds\.amazonaws\.com/);
    });

    test('a duplicated host cannot redirect pg to a server the gate never judged', () => {
      // .get returns the FIRST value, pg-connection-string keeps the LAST, and
      // host cannot be stripped because pg needs it. This judged localhost,
      // skipped TLS, and handed the credentials to the second host in
      // cleartext - no interception required.
      const o = outcome(
        'postgres://u:pw@x:5432/app?host=localhost&host=cortex.abc.eu-west-1.rds.amazonaws.com',
        { PGSSLROOTCERT: caPath }
      );
      assert.equal(o.refused, true);
      assert.match(o.message, /host more than once/);
    });

    test('the returned connection string carries no TLS parameters', () => {
      const { connectionString } = buildPgSslConfig(`${RDS}?sslmode=verify-full&application_name=x`, {
        PGSSLROOTCERT: caPath,
      });
      const params = new URL(connectionString).searchParams;
      for (const p of ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) {
        assert.equal(params.has(p), false, `${p} survived`);
      }
      // Non-TLS parameters must survive untouched.
      assert.equal(params.get('application_name'), 'x');
    });
  });

  describe('remote hosts require verified TLS', () => {
    test('an RDS host verifies against a CA from PGSSLROOTCERT', () => {
      assertVerifying(outcome(RDS, { PGSSLROOTCERT: caPath }), 'rds');
    });

    test('an RDS host verifies against a CA from sslrootcert in the URL', () => {
      const o = outcome(`${RDS}?sslrootcert=${encodeURIComponent(caPath)}`, {});
      assertVerifying(o, 'sslrootcert');
      assert.equal(o.ssl.ca, CA_PEM);
    });

    test('a non-RDS managed host also requires verified TLS, never plaintext', () => {
      // The first version keyed on .rds.amazonaws.com and returned NO TLS for
      // anything else - a regression on code that at least encrypted.
      const o = outcome(NEON, {});
      assert.equal(o.refused, true, 'a remote non-RDS host must not connect unverified');
      assert.match(o.message, /neon\.tech/);
      assertVerifying(outcome(NEON, { PGSSLROOTCERT: caPath }), 'neon with CA');
    });

    test('a hostname merely ending in a lookalike of RDS is still remote', () => {
      assertVerifying(
        outcome('postgres://u:pw@rds.amazonaws.com.attacker.io:5432/app', { PGSSLROOTCERT: caPath }),
        'lookalike'
      );
    });

    test('an RDS host with no CA anywhere refuses, and says how to get one', () => {
      const o = outcome(RDS, {});
      assert.equal(o.refused, true);
      assert.match(o.message, /PGSSLROOTCERT/);
      assert.match(o.message, /global-bundle\.pem/);
    });

    test('sslrootcert in the URL wins over the environment', () => {
      const other = path.join(caDir, 'other.pem');
      fs.writeFileSync(other, `${CA_PEM}other`);
      const o = outcome(`${RDS}?sslrootcert=${encodeURIComponent(other)}`, {
        PGSSLROOTCERT: caPath,
      });
      assert.equal(o.ssl.ca, `${CA_PEM}other`);
    });
  });

  describe('only demonstrably local hosts skip TLS', () => {
    for (const [label, url] of [
      ['localhost', LOCAL],
      ['127.0.0.1', 'postgres://u:pw@127.0.0.1:5432/app'],
      ['in-cluster', 'postgres://u:pw@postgres.default.svc.cluster.local:5432/app'],
    ]) {
      test(`${label} connects without TLS`, () => {
        const o = outcome(url, {});
        assert.equal(o.refused, false);
        assert.equal(o.ssl, false);
      });
    }
  });

  describe('a local host may not silently discard an explicit TLS request', () => {
    // localhost:5432 is the usual shape of a forwarded tunnel to production.
    // Connecting with LESS than was asked for, silently, is the same class of
    // surprise as connecting with more.
    for (const [label, query] of [
      ['sslmode=verify-full', '?sslmode=verify-full'],
      ['sslrootcert', `?sslrootcert=${encodeURIComponent(caPath)}`],
    ]) {
      test(`localhost with ${label} gets verified TLS, not plaintext`, () => {
        const o = outcome(`${LOCAL}${query}`, { PGSSLROOTCERT: caPath });
        assert.notEqual(o.ssl, false, 'an explicit TLS request was silently dropped');
        assertVerifying(o, `localhost ${label}`);
      });
    }

    test('a local host with TLS requested and no CA is told the right remedy', () => {
      // The remote wording ("reach it as localhost") sends this operator in a
      // circle, because they already have. Both branches of the message are
      // reachable, so both are pinned.
      const o = outcome(`${LOCAL}?sslmode=verify-full`, {});
      assert.equal(o.refused, true);
      assert.match(o.message, /already local/);
      assert.match(o.message, /forwarded\s+tunnel/);
      assert.doesNotMatch(o.message, /reach it as localhost/);
    });

    test('a remote host with no CA is told to supply one', () => {
      const o = outcome(NEON, {});
      assert.equal(o.refused, true);
      assert.match(o.message, /reach it as localhost/);
      assert.doesNotMatch(o.message, /already local/);
    });

    test('localhost with no TLS parameters still connects without TLS', () => {
      const o = outcome(LOCAL, { PGSSLROOTCERT: caPath });
      assert.equal(o.ssl, false);
    });
  });

  describe('the CA has to be a certificate', () => {
    test('a CA path that does not exist refuses, and names the path', () => {
      const missing = path.join(caDir, 'absent.pem');
      const o = outcome(RDS, { PGSSLROOTCERT: missing });
      assert.equal(o.refused, true);
      assert.ok(o.message.includes(missing));
    });

    test('an empty CA file refuses rather than falling back to the public roots', () => {
      // `ca: ''` is falsy, so Node would use its default trust store and the
      // handshake would succeed against any publicly-trusted certificate.
      // This is the shape a truncated curl leaves behind.
      const empty = path.join(caDir, 'empty.pem');
      fs.writeFileSync(empty, '');
      const o = outcome(RDS, { PGSSLROOTCERT: empty });
      assert.equal(o.refused, true);
      assert.match(o.message, /no certificate/i);
    });

    test('a CA file with no certificate in it refuses', () => {
      const junk = path.join(caDir, 'junk.pem');
      fs.writeFileSync(junk, 'this is not a certificate\n');
      const o = outcome(RDS, { PGSSLROOTCERT: junk });
      assert.equal(o.refused, true);
      assert.match(o.message, /no certificate/i);
    });
  });

  describe('refused and unrecognised sslmodes', () => {
    for (const mode of ['disable', 'no-verify', 'prefer', 'allow', 'require', 'verify-ca']) {
      test(`sslmode=${mode} is refused rather than honoured`, () => {
        const o = outcome(`${RDS}?sslmode=${mode}`, { PGSSLROOTCERT: caPath });
        assert.equal(o.refused, true);
        assert.match(o.message, new RegExp(mode));
        // The distinguishing phrase. "not recognised" also echoes the mode, so
        // matching the mode alone cannot tell the named-refusal path from the
        // allow-list fallback, and a mutation removing this list survived it.
        assert.match(o.message, /does not fully authenticate/);
      });
    }

    test('case does not get a downgrade past the check', () => {
      const o = outcome(`${RDS}?sslmode=No-Verify`, { PGSSLROOTCERT: caPath });
      assert.equal(o.refused, true);
      assert.match(o.message, /does not fully authenticate/);
    });

    test('an accepted mode is still accepted in upper case', () => {
      // The accept side of the same normalisation. Without it, removing the
      // lowercasing only made the helper STRICTER, so every refusal assertion
      // still passed and the mutation survived.
      assertVerifying(outcome(`${RDS}?sslmode=VERIFY-FULL`, { PGSSLROOTCERT: caPath }), 'uppercase');
    });

    test('an accepted mode survives surrounding whitespace', () => {
      assertVerifying(
        outcome(`${RDS}?sslmode=%20verify-full%20`, { PGSSLROOTCERT: caPath }),
        'padded'
      );
    });

    test('an unrecognised sslmode is refused rather than assumed safe', () => {
      const o = outcome(`${RDS}?sslmode=sideways`, { PGSSLROOTCERT: caPath });
      assert.equal(o.refused, true);
      assert.match(o.message, /not recognised/);
    });

    test('a connection string naming no host is refused, not called remote', () => {
      // `postgresql:///cortex_dev` is the standard libpq local form and parses
      // fine, so it reached the remote branch and reported "remote host ()" to
      // a developer running against their own machine.
      const o = outcome('postgresql:///cortex_dev', {});
      assert.equal(o.refused, true);
      assert.match(o.message, /does not name a host/);
      assert.doesNotMatch(o.message, /remote host \(\)/);
    });

    test('a connection string that cannot be parsed is refused, not guessed at', () => {
      const o = outcome('not a url', {});
      assert.equal(o.refused, true);
      assert.match(o.message, /connection string/i);
    });
  });

  test('no input reaches a connection that skips verification', () => {
    // Driven by the inputs that BROKE the previous version, not by a list of
    // cases already known to be safe. Every entry is checked against what pg
    // would connect with.
    const hostile = [
      `${RDS}?ssl=0`,
      `${RDS}?ssl=false`,
      `${RDS}?sslmode=disable`,
      `${RDS}?sslmode=no-verify`,
      `${RDS}?sslmode=NO-VERIFY`,
      `${RDS}?sslmode=require`,
      `${RDS}?sslmode=verify-ca`,
      `${RDS}?sslmode=verify-full&sslmode=no-verify`,
      `${RDS}?sslmode=verify-full&sslmode=disable`,
      `${RDS}?sslmode=verify-full&ssl=0`,
      `${RDS}?uselibpqcompat=true&sslmode=require`,
      `${LOCAL}?host=cortex.abc.eu-west-1.rds.amazonaws.com`,
      'postgres://u:pw@x:5432/app?host=localhost&host=cortex.abc.eu-west-1.rds.amazonaws.com',
      'postgres://u:pw@x:5432/app?host=127.0.0.1&host=attacker.io',
      `${LOCAL}?sslmode=verify-full`,
      `${LOCAL}?sslrootcert=/nonexistent/ca.pem`,
      'postgresql:///cortex_dev',
      NEON,
      'postgres://u:pw@rds.amazonaws.com.attacker.io:5432/app',
      RDS,
    ];

    for (const url of hostile) {
      // With and without a CA in the environment: neither may yield a
      // connection that is remote and unverified.
      for (const env of [{}, { PGSSLROOTCERT: caPath }]) {
        const o = outcome(url, env);
        if (o.refused) continue; // a refusal cannot be an insecure connection
        if (o.ssl === false) {
          assert.fail(`${url} would connect in cleartext`);
        }
        assert.notEqual(o.ssl.rejectUnauthorized, false, `${url}: verification disabled`);
        assert.ok(o.ssl.ca, `${url}: no CA, so the public root store would be trusted`);
      }
    }
  });
});
