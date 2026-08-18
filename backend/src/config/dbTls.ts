import fs from 'fs';
import path from 'path';

/**
 * TLS for the backend's database connections.
 *
 * Every pool in the backend connected with `rejectUnauthorized: false` - or, in
 * the case of the application pool outside production, with no TLS at all. The
 * connection string carries the database credentials, so anything able to
 * answer as the database captured them.
 *
 * WHY THIS RETURNS A CONNECTION STRING AS WELL AS AN ssl OPTION. pg merges a
 * parsed connection string OVER the explicit ssl option
 * (connection-parameters.js: `config = Object.assign({}, config,
 * parse(config.connectionString))`), so passing both means the STRING wins.
 * Measured on pg 8.x: `?ssl=0` yields a plaintext connection, and
 * `?sslmode=verify-full` discards the CA you supplied. The TLS parameters are
 * therefore stripped from the string and the decision made once, here.
 *
 * WHY VERIFICATION IS OFF BY DEFAULT, which is the important part of this file.
 * Turning it on changes whether the application can reach its database at all.
 * If the certificate does not verify, the pool fails at connect time - and this
 * same code runs in the deploy initContainer, so a wrong guess CrashLoops the
 * pod rather than degrading quietly. That cannot be tested from outside the
 * cluster, so it is not switched on by a code deploy. Set DB_TLS_VERIFY=1 in
 * the environment to enable it, watch the pod, and unset it to roll back
 * without redeploying anything.
 *
 * With DB_TLS_VERIFY unset this helper reproduces the previous behaviour at its
 * own boundary, plus one warning line naming what is unverified - the previous
 * state was not merely insecure, it was silent. TWO CALL SITES DO CHANGE, and
 * both are improvements rather than regressions: config/index.ts used to decide
 * from NODE_ENV, so a remote database outside production got NO TLS at all and
 * is now encrypted; and a single-label host under DB_TLS_VERIFY=1 is no longer
 * silently exempted from verification.
 */

const TLS_PARAMS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LOCAL_HOST_SUFFIXES = ['.svc.cluster.local', '.localhost'];

/**
 * The AWS RDS trust store, committed at backend/certs and copied into the
 * image.
 *
 * The operator scripts under scripts/ deliberately do NOT bundle this and make
 * the operator supply it, because a copy in a repository can go stale without
 * anyone noticing. The trade-off is different for a container: there is no
 * operator present to run curl, and shipping it is what makes DB_TLS_VERIFY a
 * one-variable change rather than a piece of cluster work. Staleness is not a
 * real risk for the roots themselves - the eu-west-1 roots in this bundle
 * expire in 2061, 2121 and 2121 - but refresh it if AWS publishes new roots.
 */
const BUNDLED_CA_FILENAME = 'rds-global-bundle.pem';

function bundledCaCandidates(): string[] {
  return [
    // Running from /app/backend (both the CMD and the initContainer workingDir)
    path.resolve(process.cwd(), 'certs', BUNDLED_CA_FILENAME),
    // Running from the repo root
    path.resolve(process.cwd(), 'backend', 'certs', BUNDLED_CA_FILENAME),
    // Relative to the compiled module, wherever it was invoked from
    path.resolve(__dirname, '..', '..', 'certs', BUNDLED_CA_FILENAME),
    path.resolve(__dirname, '..', '..', '..', '..', 'certs', BUNDLED_CA_FILENAME),
  ];
}

export type DbTlsMode = 'disabled' | 'unverified' | 'verified';

export interface DbTlsResult {
  /** The input with every TLS parameter removed, so `ssl` cannot be overridden. */
  connectionString: string;
  ssl: false | { rejectUnauthorized: boolean; ca?: string };
  mode: DbTlsMode;
  /** One line for the log. Never contains the connection string or password. */
  description: string;
}

type Env = Record<string, string | undefined>;

function isSingleLabel(host: string): boolean {
  return !host.includes('.') && !host.includes(':');
}

function isLocalHost(host: string, verifyRequested: boolean, env: Env): boolean {
  const bare = host.toLowerCase();
  if (LOCAL_HOSTS.has(bare)) return true;
  if (LOCAL_HOST_SUFFIXES.some((suffix) => bare.endsWith(suffix))) return true;
  // Unix socket directory.
  if (bare.startsWith('/') || bare.startsWith('%2f')) return true;

  // A SINGLE-LABEL host - no dot - is usually a container or compose service.
  // This project reaches its dev database at `postgres` and `postgres-dev`
  // (docker-compose.yml, docker-compose.dev.yml), and those are plaintext
  // containers: treating them as remote would attempt TLS and break local
  // development outright.
  //
  // BUT THE EXEMPTION STOPS WHEN VERIFICATION IS ASKED FOR. The justification
  // concedes its own counterexample: a single-label name resolved through a DNS
  // `search` suffix - a corporate domain, Kubernetes short-name resolution - is
  // a REMOTE host across a real network. Exempting it while DB_TLS_VERIFY=1 is
  // set would hand an operator a plaintext connection and an informational log
  // line, having been told verification was on. That is the silent downgrade
  // this whole change exists to remove.
  //
  // DB_TLS_LOCAL_HOSTS is the escape hatch for anyone who genuinely does reach
  // a plaintext database by a bare name and still wants verification elsewhere.
  if (isSingleLabel(bare)) {
    if (!verifyRequested) return true;
    return (env.DB_TLS_LOCAL_HOSTS || '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .includes(bare);
  }
  return false;
}

export function isVerificationRequested(env: Env): boolean {
  const raw = (env.DB_TLS_VERIFY || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function resolveCaPath(env: Env): string | null {
  const explicit = env.DB_CA_BUNDLE || env.PGSSLROOTCERT;
  if (explicit) return explicit;
  return bundledCaCandidates().find((candidate) => fs.existsSync(candidate)) || null;
}

function readCa(caPath: string): string {
  let pem: string;
  try {
    pem = fs.readFileSync(caPath, 'utf8');
  } catch (error) {
    // Nobody is watching a terminal when this fires - it is a CrashLoop or a
    // failed start - so the message has to carry the remedy with it.
    throw new Error(
      `Could not read the CA bundle at ${caPath}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'Set DB_CA_BUNDLE to a readable PEM, or unset DB_TLS_VERIFY to fall ' +
        'back to unverified TLS.'
    );
  }
  // An empty file is falsy to Node's TLS stack, which then falls back to its
  // DEFAULT PUBLIC ROOT STORE - and the RDS roots are private and self-signed,
  // so that would fail confusingly rather than verify. Garbage fails closed on
  // its own; the empty case is the one that misleads.
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(`The CA bundle at ${caPath} contains no certificate.`);
  }
  return pem;
}

/**
 * Decide how the backend should connect.
 *
 * @throws only when verification was explicitly requested and cannot be
 *   honoured. With DB_TLS_VERIFY unset this never throws - it degrades to the
 *   previous behaviour and says so in `description`.
 */
export function resolveDbTls(databaseUrl: string, env: Env): DbTlsResult {
  const verifyRequested = isVerificationRequested(env);

  let url: URL | null = null;
  try {
    url = new URL(databaseUrl);
  } catch {
    url = null;
  }

  if (!url) {
    // A unix-socket connection string is the realistic unparseable case:
    // `postgres://u:pw@/app?host=%2Fvar%2Frun%2Fpostgresql` has an empty
    // authority, which `new URL` rejects and pg accepts. It is local by
    // definition, so refusing it under DB_TLS_VERIFY would contradict the
    // socket handling below and stop the process for a connection that never
    // leaves the machine.
    if (/[?&]host=(%2f|\/)/i.test(databaseUrl)) {
      return {
        connectionString: databaseUrl,
        ssl: false,
        mode: 'disabled',
        description: 'unix socket; no TLS',
      };
    }
    if (verifyRequested) {
      throw new Error(
        'DB_TLS_VERIFY is set but the database connection string could not be ' +
          'parsed, so its TLS requirements are unknown. Refusing to connect.'
      );
    }
    return {
      connectionString: databaseUrl,
      ssl: false,
      mode: 'disabled',
      description: 'connection string not parseable; no TLS applied',
    };
  }

  // pg-connection-string prefers a `host` query parameter over the URL
  // authority, and keeps the LAST of a repeated parameter while
  // URLSearchParams.get returns the FIRST - so a duplicate could point the
  // driver at a different server from the one judged here.
  const hostValues = url.searchParams.getAll('host');
  if (hostValues.length > 1 && verifyRequested) {
    throw new Error(
      'The database connection string sets host more than once, so which ' +
        'server this connects to is ambiguous. Refusing to connect.'
    );
  }
  // pg-connection-string keeps the LAST value of a repeated parameter, so judge
  // that one. An earlier version returned no TLS here, which was a DOWNGRADE on
  // the code being replaced: a duplicated host would have dialled a remote
  // server in cleartext where the old pool at least encrypted.
  const host = (hostValues.length > 0 ? hostValues[hostValues.length - 1] : '') || url.hostname;

  if (host && isLocalHost(host, verifyRequested, env)) {
    // An exemption granted by DB_TLS_LOCAL_HOSTS while DB_TLS_VERIFY=1 must be
    // LOUDER than the state it replaces, not quieter. Plain DB_TLS_VERIFY=0
    // warns; without this, naming a host in the allow-list produced an
    // info-level "local host" line indistinguishable from a genuine loopback
    // exemption, and passed any audit keyed on "is DB_TLS_VERIFY set to 1".
    // Single-label AND not one of the intrinsic loopback names: `localhost` is
    // itself single-label, so without the second clause a genuine loopback
    // exemption would be reported as an allow-list override. Caught by the
    // test written for the loud version.
    const bare = host.toLowerCase();
    const allowListed = verifyRequested && isSingleLabel(bare) && !LOCAL_HOSTS.has(bare);
    return {
      connectionString: databaseUrl,
      ssl: false,
      mode: allowListed ? 'unverified' : 'disabled',
      description: allowListed
        ? `${host} is exempted from verification by DB_TLS_LOCAL_HOSTS - NO TLS, ` +
          'despite DB_TLS_VERIFY=1. Remove it from that list to verify this ' +
          'connection.'
        : `local host (${host}); no TLS`,
    };
  }

  if (!verifyRequested) {
    // Exactly the previous behaviour: encrypt, do not authenticate. The
    // warning is the change - this used to be silent.
    //
    // The TLS parameters are NOT stripped here, deliberately: stripping would
    // silently UPGRADE a connection someone had deliberately set to plaintext,
    // and not changing default-path behaviour is the whole basis of this
    // rollout. But that means the string still overrides the ssl option below,
    // so the description has to say so - a log line claiming "UNVERIFIED TLS"
    // over a connection pg will make in cleartext is worse than no log line at
    // all. Measured: `?sslmode=disable` and `?ssl=0` both yield plaintext here.
    const overriding = TLS_PARAMS.filter((param) => url.searchParams.has(param));
    const override =
      overriding.length > 0
        ? ` The connection string carries ${overriding
            .map((param) => `${param}=${url.searchParams.get(param)}`)
            .join(', ')}, which pg applies OVER this setting and which therefore ` +
          'decides the connection - it may be plaintext.'
        : '';
    return {
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      mode: 'unverified',
      description:
        `UNVERIFIED TLS to ${host || 'the database'} - the server's certificate is not ` +
        'checked, so a machine-in-the-middle could read the credentials on this ' +
        `connection.${override} Set DB_TLS_VERIFY=1 to require verification.`,
    };
  }

  const caPath = resolveCaPath(env);
  if (!caPath) {
    throw new Error(
      'DB_TLS_VERIFY is set but no CA bundle was found. Expected one of ' +
        `${bundledCaCandidates().join(', ')}, or a path in DB_CA_BUNDLE or ` +
        'PGSSLROOTCERT.'
    );
  }

  const sanitised = new URL(url.toString());
  for (const param of TLS_PARAMS) {
    sanitised.searchParams.delete(param);
  }

  return {
    connectionString: sanitised.toString(),
    ssl: { rejectUnauthorized: true, ca: readCa(caPath) },
    mode: 'verified',
    description: `verified TLS to ${host} against ${caPath}`,
  };
}

/**
 * What each pool decided, kept so it can be reported without a pod log.
 *
 * The decision was previously observable ONLY as a line on stdout, so
 * confirming that verification is actually on needed `kubectl logs` - which
 * meant it could not be confirmed at all by anyone without cluster access, and
 * `DB_TLS_VERIFY` shipping inert would have looked identical to it working.
 * Recording the mode here lets a superadmin read it back over HTTP instead.
 *
 * The MODE only, never `description`: that carries the database host and the CA
 * bundle path, and neither is needed to answer the question this exists to
 * answer.
 */
const appliedTlsModes = new Map<string, DbTlsMode>();

/** Every pool that has resolved TLS so far, as label to mode. */
export function getAppliedDbTlsModes(): Record<string, DbTlsMode> {
  return Object.fromEntries(appliedTlsModes);
}

/**
 * Apply the decision and log it once. Separated so the pools stay declarative
 * and every call site logs the same way.
 */
export function applyDbTls(
  databaseUrl: string,
  env: Env,
  label: string
): { connectionString: string; ssl: false | { rejectUnauthorized: boolean; ca?: string } } {
  const result = resolveDbTls(databaseUrl, env);
  appliedTlsModes.set(label, result.mode);
  const line = `[db-tls:${label}] ${result.description}`;
  if (result.mode === 'unverified') {
    console.warn(line);
  } else {
    console.info(line);
  }
  return { connectionString: result.connectionString, ssl: result.ssl };
}
