type DatabaseEnv = Record<string, string | undefined>;

const PASSWORD_CANDIDATE_KEYS = ['DB_PASSWORD', 'POSTGRES_PASSWORD', 'PGPASSWORD'] as const;

/**
 * Trims whitespace/newlines and strips one layer of matching wrapping quotes.
 * Secret managers and CI heredocs are a recurring source of both (a trailing
 * newline from `<<<` heredoc syntax is a documented gotcha in this org's
 * other projects) - a stray newline in a password looks exactly like a wrong
 * password until you print its length.
 */
function trimValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function buildUrl(host: string, env: DatabaseEnv): string {
  const port = env.DB_PORT || env.POSTGRES_PORT || env.PGPORT || '5432';
  const database = env.DB_NAME || env.POSTGRES_DB || env.PGDATABASE || 'postgres';
  const user = env.DB_USER || env.POSTGRES_USER || env.PGUSER || 'postgres';
  const password = env.DB_PASSWORD || env.POSTGRES_PASSWORD || env.PGPASSWORD || '';
  return `postgresql://${trimValue(user)}:${encodeURIComponent(trimValue(password))}@${trimValue(host)}:${trimValue(port)}/${trimValue(database)}`;
}

/**
 * Resolves the Postgres connection string across every naming convention this
 * app has run under. Order matters: a full URL always wins over individual
 * host/port/user vars, and Kubera's own names (DB_URL, DB_HOST, ...) are
 * checked before the generic POSTGRES_ and PG-prefixed fallbacks used by
 * other platforms - so on Kubera we always prefer what Kubera actually injects.
 */
export function resolveDatabaseUrl(env: DatabaseEnv): string {
  const fullUrl =
    env.DATABASE_URL || env.POSTGRES_URL || env.POSTGRESQL_URL || env.DB_URL;
  if (fullUrl) {
    return trimValue(fullUrl);
  }

  const host = env.DB_HOST || env.POSTGRES_HOST || env.PGHOST;
  if (host) {
    return buildUrl(host, env);
  }

  return 'postgresql://localhost:5432/adaptalabs_dev';
}

function describePasswordPresence(env: DatabaseEnv): string {
  for (const key of PASSWORD_CANDIDATE_KEYS) {
    const raw = env[key];
    if (raw !== undefined) {
      const trimmed = trimValue(raw);
      return trimmed.length > 0
        ? `password: present (${trimmed.length} chars)`
        : 'password: MISSING (blank after trim)';
    }
  }
  return 'password: MISSING';
}

/**
 * Human-readable, secret-free description of which env var actually supplied
 * the database connection, and whether a password was present. Intended to
 * be logged unconditionally so a bad credential shows up as an explicit
 * "MISSING" or a suspiciously short/long char count in the init container's
 * log, instead of forcing another round of trial and error against a live
 * database. Never returns the connection string or password value itself.
 */
export function describeDatabaseUrlSource(env: DatabaseEnv): string {
  if (env.DATABASE_URL) return 'DATABASE_URL';
  if (env.POSTGRES_URL) return 'POSTGRES_URL';
  if (env.POSTGRESQL_URL) return 'POSTGRESQL_URL';
  if (env.DB_URL) return 'DB_URL (Kubera full URL)';

  if (env.DB_HOST) {
    return `DB_HOST (Kubera individual vars), ${describePasswordPresence(env)}`;
  }
  if (env.POSTGRES_HOST) {
    return `POSTGRES_HOST (generic fallback), ${describePasswordPresence(env)}`;
  }
  if (env.PGHOST) {
    return `PGHOST (generic fallback), ${describePasswordPresence(env)}`;
  }

  return 'NONE FOUND - falling back to localhost dev database (this is wrong outside local dev!)';
}
