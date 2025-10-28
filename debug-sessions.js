const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/adaptalabs',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function checkSessions() {
  try {
    console.log('🔍 Checking sessions in database...');
    
    // Get all sessions
    const sessionsResult = await pool.query(`
      SELECT 
        s.id, 
        s.opportunity_id, 
        s.start_time, 
        s.end_time, 
        s.capacity, 
        s.booked_count,
        o.title as opportunity_title
      FROM sessions s
      JOIN opportunities o ON s.opportunity_id = o.id
      ORDER BY s.start_time ASC
    `);
    
    console.log(`📊 Found ${sessionsResult.rows.length} sessions:`);
    sessionsResult.rows.forEach((session, index) => {
      console.log(`${index + 1}. ${session.opportunity_title} - ${session.start_time} to ${session.end_time} (${session.capacity} slots, ${session.booked_count} booked)`);
    });
    
    // Check if there are any sessions with past end times
    const now = new Date();
    const pastSessions = sessionsResult.rows.filter(session => new Date(session.end_time) < now);
    console.log(`\n⏰ Sessions with past end times: ${pastSessions.length}`);
    pastSessions.forEach(session => {
      console.log(`- ${session.opportunity_title} - ${session.start_time} to ${session.end_time}`);
    });
    
  } catch (error) {
    console.error('❌ Error checking sessions:', error);
  } finally {
    await pool.end();
  }
}

checkSessions();
