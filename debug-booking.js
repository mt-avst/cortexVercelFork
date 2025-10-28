const { Pool } = require('pg');

// Test database connection and booking creation
async function testBooking() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/adaptalabs_dev'
  });

  try {
    console.log('Testing database connection...');
    await pool.query('SELECT 1');
    console.log('✅ Database connected');

    const sessionId = '574bb8b5-a7b9-4bf8-ab31-dee589298fa9';
    const userId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    console.log(`Testing session query for session: ${sessionId}`);
    
    // Test the session query
    const sessionResult = await pool.query(`
      SELECT s.*, o.status as opportunity_status, o.title as opportunity_title,
             o.owner_user_id, COALESCE(u.name, 'Unknown User') as owner_name, COALESCE(u.email, 'unknown@example.com') as owner_email
      FROM sessions s
      JOIN opportunities o ON s.opportunity_id = o.id
      LEFT JOIN users u ON o.owner_user_id = u.id
      WHERE s.id = $1
    `, [sessionId]);

    console.log('Session query result:', sessionResult.rows.length > 0 ? sessionResult.rows[0] : 'No session found');

    if (sessionResult.rows.length === 0) {
      console.log('❌ Session not found');
      return;
    }

    const session = sessionResult.rows[0];
    console.log('Session details:', {
      id: session.id,
      opportunity_status: session.opportunity_status,
      capacity: session.capacity,
      booked_count: session.booked_count,
      owner_user_id: session.owner_user_id,
      owner_name: session.owner_name,
      owner_email: session.owner_email
    });

    // Test user existence
    console.log(`Testing user query for user: ${userId}`);
    const userResult = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [userId]);
    console.log('User query result:', userResult.rows.length > 0 ? userResult.rows[0] : 'No user found');

    // Test booking creation
    console.log('Testing booking creation...');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Check existing bookings
      const existingBooking = await client.query(
        'SELECT id FROM bookings WHERE user_id = $1 AND session_id = $2 AND status = $3',
        [userId, sessionId, 'booked']
      );
      console.log('Existing bookings:', existingBooking.rows.length);

      if (existingBooking.rows.length > 0) {
        console.log('❌ User already has a booking for this session');
        await client.query('ROLLBACK');
        return;
      }

      // Create booking
      const bookingResult = await client.query(`
        INSERT INTO bookings (user_id, session_id, status)
        VALUES ($1, $2, 'booked')
        RETURNING *
      `, [userId, sessionId]);

      console.log('✅ Booking created:', bookingResult.rows[0]);

      // Update session booked count
      await client.query(`
        UPDATE sessions 
        SET booked_count = booked_count + 1
        WHERE id = $1
      `, [sessionId]);

      await client.query('COMMIT');
      console.log('✅ Transaction committed successfully');

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Booking creation failed:', {
        message: error.message,
        code: error.code,
        detail: error.detail,
        constraint: error.constraint,
        table: error.table,
        column: error.column
      });
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('❌ Database error:', error);
  } finally {
    await pool.end();
  }
}

testBooking();

