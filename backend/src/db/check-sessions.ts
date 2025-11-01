import { pool } from '../config';

async function checkSessions() {
  const client = await pool.connect();
  
  try {
    console.log('📊 Checking session availability...\n');
    
    // Get sessions with their booking counts
    const result = await client.query(`
      SELECT 
        s.id,
        s.start_time,
        s.end_time,
        s.capacity,
        s.booked_count,
        (s.capacity - s.booked_count) as remaining,
        COUNT(b.id)::int as actual_bookings
      FROM sessions s
      LEFT JOIN bookings b ON s.id = b.session_id AND b.status = 'booked'
      WHERE s.start_time >= '2025-10-30' AND s.start_time < '2025-11-07'
      GROUP BY s.id, s.start_time, s.end_time, s.capacity, s.booked_count
      ORDER BY s.start_time
      LIMIT 30
    `);
    
    console.log('Found', result.rows.length, 'sessions\n');
    
    let mismatches = 0;
    let fullSessions = 0;
    let availableSessions = 0;
    
    for (const row of result.rows) {
      const bookedCountMatches = row.booked_count === row.actual_bookings;
      const isFull = row.remaining <= 0;
      
      if (!bookedCountMatches) {
        mismatches++;
        console.log('⚠️  MISMATCH:');
      } else if (isFull) {
        fullSessions++;
      } else {
        availableSessions++;
      }
      
      console.log(`Session ${row.id.substring(0, 8)}...`);
      console.log(`  Time: ${new Date(row.start_time).toISOString()}`);
      console.log(`  Capacity: ${row.capacity}`);
      console.log(`  booked_count (stored): ${row.booked_count}`);
      console.log(`  actual_bookings (from bookings table): ${row.actual_bookings}`);
      console.log(`  Remaining: ${row.remaining}`);
      console.log(`  Status: ${isFull ? 'FULL' : 'AVAILABLE'}`);
      if (!bookedCountMatches) {
        console.log(`  ❌ booked_count doesn't match actual bookings!`);
      }
      console.log('');
    }
    
    console.log('\n📈 Summary:');
    console.log(`   Total sessions checked: ${result.rows.length}`);
    console.log(`   Available sessions: ${availableSessions}`);
    console.log(`   Full sessions: ${fullSessions}`);
    console.log(`   Mismatches (booked_count ≠ actual): ${mismatches}`);
    
    if (mismatches > 0) {
      console.log('\n⚠️  Need to fix booked_count values!');
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  checkSessions()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('💥 Error:', error);
      process.exit(1);
    });
}


