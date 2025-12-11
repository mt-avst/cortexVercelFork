/**
 * Database Utility Functions
 * 
 * Shared database helpers used across route handlers.
 */

import { pool } from '../config';
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
 * Check if database is available and connected
 * 
 * Used to determine whether to use real database or mock data.
 * In development without DATABASE_URL, returns false to enable mock data mode.
 * 
 * @returns Promise<boolean> - true if database is available, false otherwise
 */
export const isDatabaseAvailable = async (): Promise<boolean> => {
  try {
    // Check if DATABASE_URL is set
    if (!process.env.DATABASE_URL) {
      logger.debug('DATABASE_URL not set, using mock data');
      return false;
    }
    // Test connection with a simple query
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    logger.warn('Database not available, using mock data', { 
      error: (error as Error).message 
    });
    return false;
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










