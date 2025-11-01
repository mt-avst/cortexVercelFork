import { pool } from '../config';

/**
 * Reset all calendar bookings to default state
 * - Clears all gcal_event_id values (disconnects from Google Calendar)
 * - Resets booked_count on sessions to match actual ACTIVE bookings only
 * - Optionally cancels all existing bookings to fully reset availability
 */
export async function resetCalendarBookings(options: { cancelAllBookings?: boolean } = {}) {
  const client = await pool.connect();
  
  try {
    console.log('🔄 Resetting calendar bookings...');
    if (options.cancelAllBookings) {
      console.log('⚠️  Will cancel ALL bookings to reset availability');
    }
    
    // First, get current state
    const beforeStats = await client.query(`
      SELECT 
        COUNT(*) as total_bookings,
        COUNT(CASE WHEN status = 'booked' THEN 1 END) as active_bookings,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_bookings,
        COUNT(CASE WHEN gcal_event_id IS NOT NULL THEN 1 END) as bookings_with_calendar
      FROM bookings
    `);
    
    const before = beforeStats.rows[0];
    console.log('\n📊 Before reset:');
    console.log(`   Total bookings: ${before.total_bookings}`);
    console.log(`   Active bookings: ${before.active_bookings}`);
    console.log(`   Cancelled bookings: ${before.cancelled_bookings}`);
    console.log(`   Bookings with calendar events: ${before.bookings_with_calendar}`);
    
    // Clear all Google Calendar event IDs from bookings
    const clearResult = await client.query(`
      UPDATE bookings 
      SET gcal_event_id = NULL 
      WHERE gcal_event_id IS NOT NULL
    `);
    console.log(`\n✅ Cleared ${clearResult.rowCount} Google Calendar event IDs from bookings`);
    
    // Optionally cancel all bookings to fully reset
    if (options.cancelAllBookings) {
      const cancelResult = await client.query(`
        UPDATE bookings 
        SET status = 'cancelled',
            cancelled_at = NOW()
        WHERE status = 'booked'
      `);
      console.log(`✅ Cancelled ${cancelResult.rowCount} active bookings`);
    }
    
    // Recalculate booked_count for all sessions based on ACTIVE bookings only
    // This ensures booked_count matches the actual number of non-cancelled bookings
    const recalcResult = await client.query(`
      UPDATE sessions s
      SET booked_count = COALESCE(
        (SELECT COUNT(*)::int
         FROM bookings b
         WHERE b.session_id = s.id 
           AND b.status = 'booked'), 
        0
      ),
      updated_at = NOW()
    `);
    
    // Verify the recalculation - check for any discrepancies
    const verifyResult = await client.query(`
      SELECT 
        s.id,
        s.capacity,
        s.booked_count as stored_booked_count,
        COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)::int as actual_booked_count,
        (s.capacity - s.booked_count) as stored_remaining,
        (s.capacity - COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)) as actual_remaining
      FROM sessions s
      LEFT JOIN bookings b ON s.id = b.session_id
      GROUP BY s.id, s.capacity, s.booked_count
      HAVING s.booked_count != COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)
      LIMIT 10
    `);
    
    if (verifyResult.rows.length > 0) {
      console.log(`\n⚠️  Found ${verifyResult.rows.length} sessions with mismatched booked_count:`);
      verifyResult.rows.forEach(row => {
        console.log(`   Session ${row.id.substring(0, 8)}: stored=${row.stored_booked_count}, actual=${row.actual_booked_count}`);
      });
      
      // Force recalculate again
      console.log('\n🔄 Force recalculating all sessions...');
      await client.query(`
        UPDATE sessions s
        SET booked_count = COALESCE(
          (SELECT COUNT(*)::int
           FROM bookings b
           WHERE b.session_id = s.id 
             AND b.status = 'booked'), 
          0
        ),
        updated_at = NOW()
      `);
    }
    
    // Get final verification
    const finalVerify = await client.query(`
      SELECT 
        COUNT(*) as total_sessions,
        COUNT(CASE WHEN booked_count > 0 THEN 1 END) as sessions_with_bookings,
        COUNT(CASE WHEN booked_count = capacity THEN 1 END) as full_sessions,
        SUM(booked_count) as total_booked_count,
        SUM(capacity - booked_count) as total_available_slots
      FROM sessions
      WHERE start_time >= NOW() - INTERVAL '7 days'
    `);
    
    const verify = finalVerify.rows[0];
    console.log(`\n✅ Recalculated booked_count for all sessions`);
    console.log(`   Recent sessions (next 7 days): ${verify.total_sessions}`);
    console.log(`   Sessions with bookings: ${verify.sessions_with_bookings}`);
    console.log(`   Full sessions: ${verify.full_sessions}`);
    console.log(`   Total booked_count: ${verify.total_booked_count}`);
    console.log(`   Total available slots: ${verify.total_available_slots}`);
    
    // Get final booking statistics
    const afterStats = await client.query(`
      SELECT 
        COUNT(*) as total_bookings,
        COUNT(CASE WHEN status = 'booked' THEN 1 END) as active_bookings,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_bookings,
        COUNT(CASE WHEN gcal_event_id IS NOT NULL THEN 1 END) as bookings_with_calendar
      FROM bookings
    `);
    
    const after = afterStats.rows[0];
    console.log('\n📊 After reset:');
    console.log(`   Total bookings: ${after.total_bookings}`);
    console.log(`   Active bookings: ${after.active_bookings}`);
    console.log(`   Cancelled bookings: ${after.cancelled_bookings}`);
    console.log(`   Bookings with calendar events: ${after.bookings_with_calendar}`);
    
    console.log('\n✅ Calendar bookings reset completed successfully!');
    console.log('ℹ️  All Google Calendar event IDs have been cleared.');
    console.log('ℹ️  Session booked_count values have been recalculated to match active bookings.');
    if (options.cancelAllBookings) {
      console.log('ℹ️  All bookings have been cancelled - all slots are now available.');
    } else {
      console.log('ℹ️  Existing bookings remain active - calendar events will be recreated on next booking operations.');
    }
    
  } catch (error) {
    console.error('❌ Calendar bookings reset failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run if executed directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const cancelAll = args.includes('--cancel-all') || args.includes('-c');
  
  resetCalendarBookings({ cancelAllBookings: cancelAll })
    .then(() => {
      console.log('\n✨ All done!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Error:', error);
      process.exit(1);
    });
}
