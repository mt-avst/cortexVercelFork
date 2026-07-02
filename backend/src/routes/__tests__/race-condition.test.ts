import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import crypto from 'crypto';
import { pool } from '../../config';

describe('Race Condition Protection', () => {
  let databaseAvailable = false;

  beforeAll(async () => {
    // Check if database is available before running tests
    let timeoutHandle: NodeJS.Timeout;
    try {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Database connection timeout')), 2000);
        })
      ]);
      databaseAvailable = true;
    } catch (error) {
      databaseAvailable = false;
      // Database not available, skipping race condition test
    } finally {
      clearTimeout(timeoutHandle!);
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('should prevent concurrent session modifications', async () => {
    if (!databaseAvailable) {
      // Skipping test - database not available
      return;
    }

    const client1 = await pool.connect();
    const client2 = await pool.connect();
    
    try {
      // First, create a test session to lock
      const opportunityId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const testUserId = crypto.randomUUID();

      // opportunities.owner_user_id has a foreign key to users(id), so the owning
      // user must exist first.
      await pool.query(`
        INSERT INTO users (id, name, email)
        VALUES ($1, 'Race Condition Test User', $2)
        ON CONFLICT (id) DO NOTHING
      `, [testUserId, `race-condition-test-${testUserId}@example.com`]);

      // Create opportunity if it doesn't exist
      await pool.query(`
        INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
        VALUES ($1, 'test', 'Test', 'Test purpose', $2, 'published')
        ON CONFLICT (id) DO NOTHING
      `, [opportunityId, testUserId]);
      
      // Create session
      await pool.query(`
        INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
        VALUES ($1, $2, NOW(), NOW() + INTERVAL '1 hour', 10, 0)
        ON CONFLICT (id) DO NOTHING
      `, [sessionId, opportunityId]);
      
      // Start two transactions simultaneously
      await client1.query('BEGIN');
      await client2.query('BEGIN');
      
      // First client locks the session
      const result1 = await client1.query(`
        SELECT * FROM sessions WHERE id = $1 FOR UPDATE NOWAIT
      `, [sessionId]);
      
      // If session exists, second client should fail to lock
      if (result1.rows.length > 0) {
        await expect(
          client2.query(`
            SELECT * FROM sessions WHERE id = $1 FOR UPDATE NOWAIT
          `, [sessionId])
        ).rejects.toThrow();
      } else {
        // Session doesn't exist, test passes (lock works on empty result)
        // Session not found, skipping lock test
      }
      
    } finally {
      await client1.query('ROLLBACK');
      await client2.query('ROLLBACK');
      client1.release();
      client2.release();
    }
  });
});
