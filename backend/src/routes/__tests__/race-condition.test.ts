import { pool } from '../../config';

describe('Race Condition Protection', () => {
  it('should prevent concurrent session modifications', async () => {
    const client1 = await pool.connect();
    const client2 = await pool.connect();
    
    try {
      // Start two transactions simultaneously
      await client1.query('BEGIN');
      await client2.query('BEGIN');
      
      // Both try to lock the same session
      const sessionId = '550e8400-e29b-41d4-a716-446655440000'; // Valid UUID
      
      // First client locks the session
      await client1.query(`
        SELECT * FROM sessions WHERE id = $1 FOR UPDATE NOWAIT
      `, [sessionId]);
      
      // Second client should fail to lock
      await expect(
        client2.query(`
          SELECT * FROM sessions WHERE id = $1 FOR UPDATE NOWAIT
        `, [sessionId])
      ).rejects.toThrow();
      
    } finally {
      await client1.query('ROLLBACK');
      await client2.query('ROLLBACK');
      client1.release();
      client2.release();
    }
  });
});
