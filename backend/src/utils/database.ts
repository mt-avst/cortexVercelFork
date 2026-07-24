/**
 * Database Utility Functions
 * 
 * Shared database helpers used across route handlers.
 */

import { pool } from '../config';
import { hasDatabaseConfig } from '../config/databaseUrl';
import { AppError } from './errorHandler';
import { logger } from './logger';

/**
 * Whitelist of valid table names in the database.
 * Used to prevent SQL injection in table name queries.
 */
const VALID_TABLE_NAMES = new Set([
  'users',
  'opportunities',
  'sessions',
  'bookings',
  'feedback',
  'notification_preferences',
  'user_calendar_tokens',
  'opportunity_clicks',
  'admin_requests',
  'user_profiles',
  'achievements',
  'user_achievements',
  'points_transactions',
]);

/**
 * Mock-data mode is a developer-machine convenience only. Anything else —
 * production, test, or an unrecognised value — must NOT quietly serve demo
 * fixtures. Checked against the raw env var, not the parsed config:
 * shared/config/environment coerces any unrecognised NODE_ENV to
 * 'development' (`z.enum([...]).catch(...)`), and inheriting that coercion
 * here would treat a typo'd production environment as a developer laptop.
 * Unset counts as development because `npm run dev` sets nothing.
 */
const isMockDataPermitted = (): boolean => {
  const nodeEnv = process.env.NODE_ENV;
  return nodeEnv === undefined || nodeEnv === 'development' || nodeEnv === 'test';
};

/**
 * Check if database is available and connected
 *
 * Used to determine whether to use real database or mock data. Only a
 * developer machine with no database configured gets mock-data mode
 * (returns false). Every real failure throws a 503 instead:
 *
 * - Configured but unreachable: ALWAYS an error, in every environment.
 *   Previously this returned false, so a database outage made the public
 *   API serve demo fixtures with HTTP 200 — monitoring saw success while
 *   every user saw fabricated content. A failover (routine now that the
 *   RDS instance is Multi-AZ) would have presented exactly that way.
 * - Not configured outside development/test: an error, not mock mode.
 *   This is the shape of the week-long outage recorded in
 *   config/__tests__/databaseUrl.test.ts — lost database config must
 *   surface as a deploy fault, not as plausible fake data.
 *
 * @returns Promise<boolean> - true if database is available, false only in
 *   mock-data mode
 * @throws AppError 503 DB_CONNECTION_FAILED / DB_NOT_CONFIGURED
 */
export const isDatabaseAvailable = async (): Promise<boolean> => {
  // Check every connection source the pool's URL resolver understands
  // (DATABASE_URL, POSTGRES_URL, DB_URL, DB_HOST, ...). Checking only
  // DATABASE_URL is a proven landmine: deleting the stale DATABASE_URL
  // from the Kubera secret silently flipped the app into mock-data mode
  // while the pool connected fine via Kubera's injected DB_URL/DB_HOST.
  if (!hasDatabaseConfig(process.env)) {
    if (isMockDataPermitted()) {
      logger.debug('No database connection configured, using mock data');
      return false;
    }
    logger.error('No database connection configured outside development/test', {
      nodeEnv: process.env.NODE_ENV,
    });
    throw new AppError('Service temporarily unavailable', 503, 'DB_NOT_CONFIGURED');
  }
  try {
    // Test connection with a simple query
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    // Message stays static: driver errors can carry hosts, usernames and
    // schema names, and errorHandler serialises AppError messages into the
    // response body. Log name and code as well as message - ECONNREFUSED
    // arrives as an AggregateError whose message is empty, so message alone
    // logs as "".
    logger.error('Database connectivity check failed', {
      error: {
        name: (error as Error).name,
        message: (error as Error).message,
        code: (error as { code?: string }).code,
      },
    });
    throw new AppError('Service temporarily unavailable', 503, 'DB_CONNECTION_FAILED');
  }
};

/**
 * Check if a specific table exists in the database
 * 
 * SECURITY: Uses parameterized query against information_schema to prevent SQL injection.
 * Table name is validated against a whitelist of known tables.
 * 
 * @param tableName - Name of the table to check (must be in whitelist)
 * @returns Promise<boolean> - true if table exists
 */
export const doesTableExist = async (tableName: string): Promise<boolean> => {
  // Validate table name against whitelist to prevent SQL injection
  if (!VALID_TABLE_NAMES.has(tableName.toLowerCase())) {
    logger.warn('Invalid table name requested', { tableName });
    return false;
  }

  try {
    // Use information_schema with parameterized query (safe approach)
    const result = await pool.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = $1
      )`,
      [tableName.toLowerCase()]
    );
    return result.rows[0]?.exists === true;
  } catch (error) {
    logger.error('Error checking table existence', {
      tableName,
      error: (error as Error).message,
    });
    return false;
  }
};










