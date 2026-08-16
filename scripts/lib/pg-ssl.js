'use strict';

/**
 * TLS configuration for the operator scripts that change a user's role.
 *
 * These scripts grant an admin role over a connection string that carries the
 * database credentials, so the connection has to authenticate the server: a
 * machine-in-the-middle able to answer as the database captures those
 * credentials and can rewrite the UPDATE. They used to pass
 * `ssl: { rejectUnauthorized: false }`, which encrypts but verifies nothing.
 *
 * WHY THIS RETURNS A CONNECTION STRING AS WELL AS AN ssl OPTION, which is the
 * whole subtlety here. An earlier version of this file passed the original
 * string to `new Pool({ connectionString, ssl })` and asserted in a comment
 * that the ssl option won. It does not. pg does this
 * (node_modules/pg/lib/connection-parameters.js):
 *
 *     if (config.connectionString) {
 *       config = Object.assign({}, config, parse(config.connectionString))
 *     }
 *
 * so anything the string says about TLS REPLACES the option. Measured against
 * pg 8.18.0 / pg-connection-string 2.11.0, with a verifying config passed in:
 *
 *     ?ssl=0                                 -> false  (plaintext)
 *     ?sslmode=verify-full                   -> {}     (our CA discarded)
 *     ?sslmode=verify-full&sslmode=no-verify -> { rejectUnauthorized: false }
 *
 * The last one works because URLSearchParams.get returns the FIRST value while
 * pg-connection-string's object build keeps the LAST, so a gate reading the
 * first sees a mode it approves of and the driver uses a different one.
 *
 * So the TLS parameters are stripped from the string and the decision is made
 * once, here. Nothing is left for the driver to override with.
 *
 * The RDS CA is deliberately not bundled. AWS rotates it, and a copy committed
 * to a repository goes stale silently. The operator supplies it:
 *
 *   curl -o ~/.postgresql/rds-global-bundle.pem \
 *     https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
 *   export PGSSLROOTCERT=~/.postgresql/rds-global-bundle.pem
 *
 * PGSSLROOTCERT is libpq's own variable name, so an operator who already runs
 * psql against this database will usually have it set.
 */

const fs = require('node:fs');

/**
 * Every parameter pg-connection-string reads that changes the TLS outcome.
 * All of them are stripped from the string before it reaches the driver; the
 * list is here rather than inline so that adding one is a single edit.
 */
const TLS_PARAMS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

/**
 * Hosts where a plaintext connection is defensible because the traffic does
 * not leave the machine or the cluster. Everything else is treated as remote
 * and must use verified TLS.
 *
 * This is deliberately an allow-list. The first version keyed on
 * `.rds.amazonaws.com` and returned "no TLS" for anything else, which made
 * every non-RDS remote database - a managed provider, an RDS instance behind
 * a CNAME or an RDS Proxy - connect in cleartext. That was a REGRESSION on the
 * code being fixed: it authenticated nobody, but it did at least encrypt.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LOCAL_HOST_SUFFIXES = ['.svc.cluster.local', '.localhost'];

const CA_HELP = [
  'Supply the CA bundle, then run this again:',
  '',
  '  curl -o ~/.postgresql/rds-global-bundle.pem \\',
  '    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem',
  '  export PGSSLROOTCERT=~/.postgresql/rds-global-bundle.pem',
  '',
  'Or put ?sslrootcert=/path/to/global-bundle.pem on the connection string.',
].join('\n');

/**
 * sslmode values that do not authenticate the server.
 *
 * WHAT THIS LIST IS ACTUALLY FOR, since it is easy to mistake for the control.
 * The security control is the stripping above: once the TLS parameters are
 * removed from the string, nothing the operator wrote can weaken the
 * connection, and an unrecognised mode is caught by ACCEPTED_SSL_MODES anyway.
 *
 * This list earns its place by making the script FAIL LOUDLY rather than
 * silently ignoring an explicit instruction. An operator who writes
 * sslmode=disable has said something specific; quietly connecting with full
 * verification instead would be the same class of surprise this change exists
 * to remove. The named-mode message also explains WHY, which the
 * "not recognised" fallback cannot.
 *
 * That is a claim about message quality, so it is the messages that are
 * asserted. Mutations deleting 'verify-ca' from this set, dropping the
 * uselibpqcompat check or removing the case handling all survived until the
 * tests stopped matching the echoed mode name - which the fallback message
 * also contains - and started matching the distinguishing phrase, and until
 * something pinned the ACCEPT side of the normalisation. A surviving mutation
 * here means an assertion has gone vacuous, not that the layer is redundant.
 *
 * 'require' and 'verify-ca' are refused for a reason that is not obvious:
 * pg-connection-string currently treats them as aliases for 'verify-full' but
 * warns that in pg v9 they adopt libpq semantics, under which 'require' does
 * not check the chain and 'verify-ca' does not check the hostname. Refusing
 * them means a dependency bump cannot quietly weaken this connection.
 */
const REFUSED_SSL_MODES = new Set([
  'disable',
  'no-verify',
  'prefer',
  'allow',
  'require',
  'verify-ca',
]);

const ACCEPTED_SSL_MODES = new Set(['verify-full']);

function isLocalHost(host) {
  const bare = host.toLowerCase();
  if (LOCAL_HOSTS.has(bare)) return true;
  if (LOCAL_HOST_SUFFIXES.some((suffix) => bare.endsWith(suffix))) return true;
  // A unix socket directory, which pg accepts as a host.
  return bare.startsWith('/') || bare.startsWith('%2f');
}

function readCa(caPath) {
  let pem;
  try {
    pem = fs.readFileSync(caPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read the CA bundle at ${caPath}: ` +
        `${error instanceof Error ? error.message : String(error)}\n\n${CA_HELP}`
    );
  }
  // An empty file is the shape a failed or truncated curl leaves behind, and
  // it is the dangerous one: `ca: ''` is falsy, so Node falls back to its
  // DEFAULT PUBLIC ROOT STORE and the handshake succeeds against anything with
  // a publicly-trusted certificate. Garbage content fails closed on its own.
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(
      `The CA bundle at ${caPath} contains no certificate (${pem.length} bytes). ` +
        `An empty file would silently fall back to the public certificate ` +
        `authorities rather than pinning this database.\n\n${CA_HELP}`
    );
  }
  return pem;
}

/**
 * Decide how to connect, and return a connection string that cannot contradict
 * the decision.
 *
 * @param {string} connectionString
 * @param {Record<string, string | undefined>} env
 * @returns {{ connectionString: string, ssl: false | { ca: string, rejectUnauthorized: true } }}
 *   Pass BOTH to `new Pool(...)`. The returned string has every TLS parameter
 *   removed, so the ssl value is the one that takes effect.
 * @throws when TLS is needed but cannot be verified, or when the string asks
 *   for something weaker, so the caller stops rather than downgrading.
 */
function buildPgSslConfig(connectionString, env) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(
      'Could not parse the database connection string, so its TLS requirements ' +
        'are unknown. Refusing to connect rather than guessing.'
    );
  }

  // Every value, not just the first. pg-connection-string keeps the LAST of a
  // duplicated parameter, so reading only the first is how a string carrying
  // `?sslmode=verify-full&sslmode=no-verify` talks its way past the gate.
  for (const rawMode of url.searchParams.getAll('sslmode')) {
    const mode = rawMode.trim().toLowerCase();
    if (REFUSED_SSL_MODES.has(mode)) {
      throw new Error(
        `sslmode=${rawMode} does not fully authenticate the database server, and ` +
          'this script sends credentials and grants an admin role over that ' +
          'connection. Remove the parameter - this connects with full ' +
          'verification by default.'
      );
    }
    if (!ACCEPTED_SSL_MODES.has(mode)) {
      throw new Error(
        `sslmode=${rawMode} is not recognised, so its security properties are ` +
          'unknown. Remove the parameter - this connects with full ' +
          'verification by default.'
      );
    }
  }

  // The legacy boolean parameter. pg-connection-string honours it and turns
  // `ssl=0` into a plaintext connection; the first version of this file never
  // looked at it.
  for (const rawSsl of url.searchParams.getAll('ssl')) {
    const value = rawSsl.trim().toLowerCase();
    if (value !== '1' && value !== 'true') {
      throw new Error(
        `ssl=${rawSsl} on the connection string would disable TLS. Remove it - ` +
          'this connects with full verification by default.'
      );
    }
  }

  if (url.searchParams.has('uselibpqcompat')) {
    throw new Error(
      'uselibpqcompat=true switches sslmode to libpq semantics, under which ' +
        'the modes this script accepts no longer verify the hostname. Remove ' +
        'it - this connects with full verification by default.'
    );
  }

  // pg-connection-string prefers a `host` QUERY PARAMETER over the URL's own
  // authority, so reading url.hostname alone would judge a different server
  // from the one the driver dials.
  //
  // Read with getAll for the same reason sslmode is: .get returns the FIRST
  // value and pg-connection-string keeps the LAST. `host` cannot be stripped
  // the way the TLS parameters are - pg needs it - so a duplicate is refused
  // instead. `?host=localhost&host=elsewhere` otherwise had the gate judge
  // localhost, skip TLS, and hand the credentials and the role grant to
  // `elsewhere` in cleartext, with no interception needed at all.
  const hostValues = url.searchParams.getAll('host');
  if (hostValues.length > 1) {
    throw new Error(
      'The connection string sets host more than once, so which server this ' +
        'connects to is ambiguous. Remove the duplicates.'
    );
  }
  const host = hostValues[0] || url.hostname;

  // `postgresql:///cortex_dev` - the standard libpq "default socket, default
  // user" local form - parses fine (postgres: is a non-special scheme, so an
  // empty authority is legal) and pg falls back to PGHOST or the default unix
  // socket. Nothing here can judge what that would connect to, and without
  // this the remote branch below reports "remote host ()" to a developer
  // running against their own machine.
  if (!host) {
    throw new Error(
      'The connection string does not name a host, so pg would fall back to ' +
        'PGHOST or the default unix socket and this cannot judge what it ' +
        'would connect to. Name it explicitly, e.g. ' +
        'postgres://localhost:5432/cortex_dev.'
    );
  }

  // Whether TLS was asked for, checked BEFORE the local-host shortcut. A local
  // host that carries an explicit sslmode or sslrootcert has been given a
  // specific instruction, and silently connecting with less than was asked for
  // is the same class of surprise as silently connecting with more.
  // `localhost:5432` is also the standard shape of a forwarded tunnel to a
  // production database.
  const tlsRequested =
    url.searchParams.has('sslmode') ||
    url.searchParams.has('sslrootcert') ||
    url.searchParams.has('ssl');

  const sanitised = new URL(url.toString());
  for (const param of TLS_PARAMS) {
    sanitised.searchParams.delete(param);
  }

  if (isLocalHost(host) && !tlsRequested) {
    // Traffic that does not leave the machine or the cluster. Forcing TLS here
    // would break a plain local postgres for no gain.
    return { connectionString: sanitised.toString(), ssl: false };
  }

  const caPath = url.searchParams.get('sslrootcert') || env.PGSSLROOTCERT;
  if (!caPath) {
    throw new Error(
      (tlsRequested
        ? `TLS was requested for ${host}, so its certificate must be verified`
        : `This connection is to a remote host (${host}), whose certificate ` +
          'must be verified') +
        ' because the connection carries database credentials and grants an ' +
        'admin role.\n\n' +
        (isLocalHost(host)
          ? // Reached only when a LOCAL host carries an explicit TLS request.
            // Telling this operator to "use localhost" would send them in a
            // circle - they already are. The forwarded-tunnel case is the
            // reason the explicit request is honoured at all, so name it.
            `${host} is already local, so removing the TLS parameter connects ` +
            'without TLS. Keep it and supply a CA if this is a forwarded ' +
            'tunnel to a remote database.'
          : // There is deliberately no plaintext opt-out, so an operator whose
            // local database is not on the recognised list (a bare compose
            // service name, host.docker.internal, the trailing-dot form of
            // localhost) needs to know the fix is to name it, not find a flag.
            'If this IS a local database, reach it as localhost or 127.0.0.1. ' +
            'There is no option to connect without verification.') +
        `\n\n${CA_HELP}`
    );
  }

  return {
    connectionString: sanitised.toString(),
    ssl: { ca: readCa(caPath), rejectUnauthorized: true },
  };
}

module.exports = { buildPgSslConfig, TLS_PARAMS };
