type DatabaseEnv = Record<string, string | undefined>;

function buildUrl(host: string, env: DatabaseEnv): string {
  const port = env.DB_PORT || env.POSTGRES_PORT || env.PGPORT || '5432';
  const database = env.DB_NAME || env.POSTGRES_DB || env.PGDATABASE || 'postgres';
  const user = env.DB_USER || env.POSTGRES_USER || env.PGUSER || 'postgres';
  const password = env.DB_PASSWORD || env.POSTGRES_PASSWORD || env.PGPASSWORD || '';
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
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
    return fullUrl;
  }

  const host = env.DB_HOST || env.POSTGRES_HOST || env.PGHOST;
  if (host) {
    return buildUrl(host, env);
  }

  return 'postgresql://localhost:5432/adaptalabs_dev';
}
