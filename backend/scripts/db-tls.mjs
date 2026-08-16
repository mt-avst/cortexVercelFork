import fs from "node:fs";
import path from "node:path";

/**
 * ESM twin of backend/src/config/dbTls.ts.
 *
 * It exists because firsthand-migrate.mjs is the deploy initContainer and runs
 * as plain node against the repo, before and independently of any TypeScript
 * build - `npm run migrate:firsthand` is `node scripts/firsthand-migrate.mjs`.
 * Importing the compiled helper would make the initContainer depend on
 * dist/ having been built, which is exactly the kind of coupling that turns a
 * build change into a CrashLoop.
 *
 * The duplication is deliberate but NOT unguarded: db-tls-parity.test.ts drives
 * both implementations over the same table of inputs and fails if they ever
 * disagree. Change one, change the other, or the parity test fails.
 */

const TLS_PARAMS = ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_HOST_SUFFIXES = [".svc.cluster.local", ".localhost"];

const BUNDLED_CA_FILENAME = "rds-global-bundle.pem";

export function bundledCaCandidates() {
  return [
    path.resolve(process.cwd(), "certs", BUNDLED_CA_FILENAME),
    path.resolve(process.cwd(), "backend", "certs", BUNDLED_CA_FILENAME),
    path.resolve(process.cwd(), "..", "certs", BUNDLED_CA_FILENAME),
  ];
}

function isLocalHost(host, verifyRequested, env) {
  const bare = host.toLowerCase();
  if (LOCAL_HOSTS.has(bare)) return true;
  if (LOCAL_HOST_SUFFIXES.some((suffix) => bare.endsWith(suffix))) return true;
  // Unix socket directory.
  if (bare.startsWith("/") || bare.startsWith("%2f")) return true;
  // A SINGLE-LABEL host is usually a container or compose service, but a name
  // resolved through a DNS search suffix is remote - so the exemption stops
  // once verification is asked for. See dbTls.ts.
  if (!bare.includes(".") && !bare.includes(":")) {
    if (!verifyRequested) return true;
    return (env.DB_TLS_LOCAL_HOSTS || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .includes(bare);
  }
  return false;
}

export function isVerificationRequested(env) {
  const raw = (env.DB_TLS_VERIFY || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function resolveCaPath(env) {
  const explicit = env.DB_CA_BUNDLE || env.PGSSLROOTCERT;
  if (explicit) return explicit;
  return bundledCaCandidates().find((candidate) => fs.existsSync(candidate)) || null;
}

function readCa(caPath) {
  let pem;
  try {
    pem = fs.readFileSync(caPath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read the CA bundle at ${caPath}: ${error.message}. ` +
        "Set DB_CA_BUNDLE to a readable PEM, or unset DB_TLS_VERIFY to fall " +
        "back to unverified TLS."
    );
  }
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error(`The CA bundle at ${caPath} contains no certificate.`);
  }
  return pem;
}

export function resolveDbTls(databaseUrl, env) {
  const verifyRequested = isVerificationRequested(env);

  let url = null;
  try {
    url = new URL(databaseUrl);
  } catch {
    url = null;
  }

  if (!url) {
    // A unix-socket connection string is the realistic unparseable case and is
    // local by definition - see dbTls.ts.
    if (/[?&]host=(%2f|\/)/i.test(databaseUrl)) {
      return {
        connectionString: databaseUrl,
        ssl: false,
        mode: "disabled",
        description: "unix socket; no TLS",
      };
    }
    if (verifyRequested) {
      throw new Error(
        "DB_TLS_VERIFY is set but the database connection string could not be " +
          "parsed, so its TLS requirements are unknown. Refusing to connect."
      );
    }
    return {
      connectionString: databaseUrl,
      ssl: false,
      mode: "disabled",
      description: "connection string not parseable; no TLS applied",
    };
  }

  const hostValues = url.searchParams.getAll("host");
  if (hostValues.length > 1 && verifyRequested) {
    throw new Error(
      "The database connection string sets host more than once, so which " +
        "server this connects to is ambiguous. Refusing to connect."
    );
  }
  // pg-connection-string keeps the LAST value of a repeated parameter, so judge
  // that one. See dbTls.ts - returning no TLS here was a downgrade.
  const host = (hostValues.length > 0 ? hostValues[hostValues.length - 1] : "") || url.hostname;

  if (host && isLocalHost(host, verifyRequested, env)) {
    // An allow-listed exemption must be louder than the state it replaces -
    // see dbTls.ts.
    // Single-label AND not an intrinsic loopback name - `localhost` is itself
    // single-label. See dbTls.ts.
    const bare = host.toLowerCase();
    const allowListed =
      verifyRequested &&
      !bare.includes(".") &&
      !bare.includes(":") &&
      !LOCAL_HOSTS.has(bare);
    return {
      connectionString: databaseUrl,
      ssl: false,
      mode: allowListed ? "unverified" : "disabled",
      description: allowListed
        ? `${host} is exempted from verification by DB_TLS_LOCAL_HOSTS - NO TLS, ` +
          "despite DB_TLS_VERIFY=1. Remove it from that list to verify this " +
          "connection."
        : `local host (${host}); no TLS`,
    };
  }

  if (!verifyRequested) {
    // TLS parameters are NOT stripped here - see dbTls.ts. The string therefore
    // still overrides the ssl option, so the description must say so rather
    // than claim TLS over a connection pg will make in cleartext.
    const overriding = TLS_PARAMS.filter((param) => url.searchParams.has(param));
    const override =
      overriding.length > 0
        ? ` The connection string carries ${overriding
            .map((param) => `${param}=${url.searchParams.get(param)}`)
            .join(", ")}, which pg applies OVER this setting and which therefore ` +
          "decides the connection - it may be plaintext."
        : "";
    return {
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      mode: "unverified",
      description:
        `UNVERIFIED TLS to ${host || "the database"} - the server's certificate is not ` +
        "checked, so a machine-in-the-middle could read the credentials on this " +
        `connection.${override} Set DB_TLS_VERIFY=1 to require verification.`,
    };
  }

  const caPath = resolveCaPath(env);
  if (!caPath) {
    throw new Error(
      "DB_TLS_VERIFY is set but no CA bundle was found. Expected one of " +
        `${bundledCaCandidates().join(", ")}, or a path in DB_CA_BUNDLE or ` +
        "PGSSLROOTCERT."
    );
  }

  const sanitised = new URL(url.toString());
  for (const param of TLS_PARAMS) {
    sanitised.searchParams.delete(param);
  }

  return {
    connectionString: sanitised.toString(),
    ssl: { rejectUnauthorized: true, ca: readCa(caPath) },
    mode: "verified",
    description: `verified TLS to ${host} against ${caPath}`,
  };
}

export function applyDbTls(databaseUrl, env, label) {
  const result = resolveDbTls(databaseUrl, env);
  const line = `[db-tls:${label}] ${result.description}`;
  if (result.mode === "unverified") {
    console.warn(line);
  } else {
    console.info(line);
  }
  return { connectionString: result.connectionString, ssl: result.ssl };
}
