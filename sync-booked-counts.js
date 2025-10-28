// Use the same config as the backend
const { Client } = require('pg');
require('dotenv').config({ path: './backend/.env' });

// Create a connection using the same DATABASE_URL as the backend
const pool = new Client({
  connectionString: process.env.DATABASE_URL || 'postgresql://nickster@localhost:5432/adaptalabs_dev'
});

// Connect to the database
pool.connect();

async function syncBookedCounts() {
  try {
    console.log('Starting booked_count sync...');
    
    // Get all sessions
    const sessionsResult = await pool.query('SELECT id FROM sessions');
    
    let syncedCount = 0;
    let mismatchedCount = 0;
    
    for (const session of sessionsResult.rows) {
      // Count actual active bookings for this session
      const bookingsResult = await pool.query(
        'SELECT COUNT(*) as count FROM bookings WHERE session_id = $1 AND status = $2',
        [session.id, 'booked']
      );
      
      const actualCount = parseInt(bookingsResult.rows[0].count);
      
      // Get current booked_count
      const sessionResult = await pool.query(
        'SELECT booked_count FROM sessions WHERE id = $1',
        [session.id]
      );
      
      const currentCount = sessionResult.rows[0].booked_count;
      
      // Only update if there's a mismatch
      if (actualCount !== currentCount) {
        console.log(`Session ${session.id}: ${currentCount} -> ${actualCount}`);
        
        await pool.query(
          'UPDATE sessions SET booked_count = $1 WHERE id = $2',
          [actualCount, session.id]
        );
        
        mismatchedCount++;
      }
      
      syncedCount++;
    }
    
    console.log(`Sync complete: ${syncedCount} sessions checked, ${mismatchedCount} fixed`);
    
  } catch (error) {
    console.error('Error syncing booked_count:', error);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

syncBookedCounts();
