import { Pool } from 'pg';
import dotenv from 'dotenv';
import { getBackendConfig, BackendEnvironment } from '../../../shared/config/environment';
import { resolveDatabaseUrl } from './databaseUrl';

dotenv.config();

// Validate environment variables
const config: BackendEnvironment = getBackendConfig();

const databaseUrl = resolveDatabaseUrl(process.env);

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
