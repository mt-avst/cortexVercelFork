import { Pool } from 'pg';
import dotenv from 'dotenv';
import { getBackendConfig, BackendEnvironment } from '../../../shared/config/environment';

dotenv.config();

// Validate environment variables
const config: BackendEnvironment = getBackendConfig();

// Use process.env.DATABASE_URL directly if available, otherwise use the correct fallback
// Note: Use localhost format without username to connect as the default database user
// The format 'postgresql://localhost:5432/dbname' uses the current system user automatically
let databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  // Default to localhost format - this uses the current OS user for auth
  databaseUrl = 'postgresql://localhost:5432/adaptalabs_dev';
}

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export { config };
