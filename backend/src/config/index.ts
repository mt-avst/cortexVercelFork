import { Pool } from 'pg';
import dotenv from 'dotenv';
import { getBackendConfig, BackendEnvironment } from '../../../shared/config/environment';

dotenv.config();

// Validate environment variables
const config: BackendEnvironment = getBackendConfig();

export const pool = new Pool({
  connectionString: config.DATABASE_URL || 'postgresql://localhost:5432/adaptalabs',
  ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export { config };
