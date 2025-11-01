import { pool, config } from '../config';

export async function seedDatabase() {
  const client = await pool.connect();
  
  try {
    // Insert demo admin user for development
    await client.query(`
      INSERT INTO users (id, email, name, business_unit, role_title, role) 
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name,
        business_unit = EXCLUDED.business_unit,
        role_title = EXCLUDED.role_title,
        role = EXCLUDED.role
    `, [
      '633608bc-4b0e-4d60-a498-e680ee97c252',
      'admin@test.com',
      'Test Admin',
      'Research',
      'Research Manager',
      'researcher_admin'
    ]);
    console.log('✅ Demo admin user inserted/updated');
    
    // Insert demo user for development
    await client.query(`
      INSERT INTO users (id, email, name, business_unit, role_title, role) 
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name,
        business_unit = EXCLUDED.business_unit,
        role_title = EXCLUDED.role_title,
        role = EXCLUDED.role
    `, [
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      'demo@example.com',
      'Demo User',
      'Engineering',
      'Software Engineer',
      'employee'
    ]);
    console.log('✅ Demo user inserted/updated');
    
    // Insert second demo user for multi-user testing
    await client.query(`
      INSERT INTO users (id, email, name, business_unit, role_title, role) 
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name,
        business_unit = EXCLUDED.business_unit,
        role_title = EXCLUDED.role_title,
        role = EXCLUDED.role
    `, [
      'b2c3d4e5-f6a7-8901-bcde-f12345678901',
      'demo2@example.com',
      'Demo User 2',
      'Product',
      'Product Manager',
      'employee'
    ]);
    console.log('✅ Demo user 2 inserted/updated');
    
    // Mark admin emails as researcher admins
    for (const email of config.ADMIN_EMAILS) {
      if (email.trim()) {
        await client.query(
          'UPDATE users SET role = $1 WHERE email = $2',
          ['researcher_admin', email.trim()]
        );
        console.log(`✅ Marked ${email.trim()} as researcher admin`);
      }
    }

    // Insert default settings
    await client.query(`
      INSERT INTO settings (key, value_json) 
      VALUES ('default_reminder_hours_before', '24')
      ON CONFLICT (key) DO NOTHING
    `);

    // Insert default achievements
    await client.query(`
      INSERT INTO achievements (name, description, icon, points_required, category, badge_color) VALUES
      ('First Steps', 'Complete your first research session', '🎯', 10, 'participation', '#28a745'),
      ('Test Taker', 'Complete 5 test sessions', '🧪', 50, 'milestone', '#007bff'),
      ('Survey Master', 'Complete 3 surveys', '📊', 30, 'milestone', '#6f42c1'),
      ('Poll Participant', 'Complete 2 polls', '📈', 20, 'milestone', '#fd7e14'),
      ('Question Answerer', 'Complete 5 questions', '❓', 25, 'milestone', '#20c997'),
      ('Research Enthusiast', 'Complete 10 total sessions', '🌟', 100, 'milestone', '#ffc107'),
      ('Monthly Champion', 'Top scorer for the month', '👑', 0, 'special', '#dc3545'),
      ('Consistent Contributor', 'Complete sessions for 3 consecutive months', '🔥', 150, 'special', '#e83e8c'),
      ('Team Player', 'Complete sessions across 3 different opportunity types', '🤝', 75, 'special', '#17a2b8'),
      ('AdaptaLabs Legend', 'Reach 500 total points', '🏆', 500, 'special', '#6c757d')
      ON CONFLICT (name) DO NOTHING
    `);

    // Test opportunities seeding removed - user will create their own test data

    console.log('✅ Database seeding completed successfully');
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    throw error;
  } finally {
    client.release();
  }
}


// Run seeding if this file is executed directly
if (require.main === module) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
