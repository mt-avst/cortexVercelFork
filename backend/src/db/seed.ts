import { pool, config } from '../config';

export async function seedDatabase() {
  const client = await pool.connect();
  
  try {
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
