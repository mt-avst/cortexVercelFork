/**
 * Database Utility Functions
 * 
 * Shared database helpers used across route handlers.
 */

import { pool } from '../config';
import { logger } from './logger';

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
 * @param tableName - Name of the table to check
 * @returns Promise<boolean> - true if table exists
 */
export const doesTableExist = async (tableName: string): Promise<boolean> => {
  try {
    await pool.query(`SELECT 1 FROM ${tableName} LIMIT 1`);
    return true;
  } catch (error) {
    return false;
  }
};


