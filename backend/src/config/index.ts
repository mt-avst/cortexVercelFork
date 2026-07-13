import { Pool } from 'pg';
import dotenv from 'dotenv';
import { getBackendConfig, BackendEnvironment } from '../../../shared/config/environment';

dotenv.config();

// Validate environment variables
const config: BackendEnvironment = getBackendConfig();

// Support multiple env var naming conventions (Kubera, Vercel, Railway, Heroku, etc.)
let databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRESQL_URL;

if (!databaseUrl) {
  // Construct from individual vars if present (some platforms inject these instead of a URL)
  const host = process.env.POSTGRES_HOST || process.env.PGHOST;
  if (host) {
    const port = process.env.POSTGRES_PORT || process.env.PGPORT || '5432';
    const db = process.env.POSTGRES_DB || process.env.PGDATABASE || 'postgres';
    const user = process.env.POSTGRES_USER || process.env.PGUSER || 'postgres';
    const pass = process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || '';
    databaseUrl = `postgresql://${user}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
  } else {
    databaseUrl = 'postgresql://localhost:5432/adaptalabs_dev';
  }
}

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // pg's default is 0 (wait forever). Without this, an unreachable database
  // makes the very first pool.connect() call hang silently - fatal in the
  // migrate/seed initContainer, which logs nothing until this fires and
  // exits with a clear error instead of hanging until Kubernetes kills it.
  connectionTimeoutMillis: 10_000,
});

export { config };
