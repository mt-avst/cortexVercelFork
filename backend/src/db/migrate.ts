import { pool } from '../config';

export async function runMigrations() {
  const client = await pool.connect();
  
  try {
    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        business_unit TEXT,
        role_title TEXT,
        role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'researcher_admin')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create notification_preferences table
    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        on_book_email BOOLEAN DEFAULT true,
        on_cancel_email BOOLEAN DEFAULT true
      )
    `);

    // Create settings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key TEXT UNIQUE NOT NULL,
        value_json JSONB
      )
    `);

    // Create opportunity types enum
    await client.query(`
      CREATE TYPE opportunity_type AS ENUM ('test', 'poll', 'survey', 'question')
    `);

    // Create opportunity status enum
    await client.query(`
      CREATE TYPE opportunity_status AS ENUM ('draft', 'published', 'closed')
    `);

    // Create participant type enum
    await client.query(`
      CREATE TYPE participant_type AS ENUM ('any', 'internal', 'external', 'specific')
    `);

    // Create opportunities table
    await client.query(`
      CREATE TABLE IF NOT EXISTS opportunities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type opportunity_type NOT NULL,
        title TEXT NOT NULL CHECK (length(trim(title)) >= 4 AND length(trim(title)) <= 140),
        purpose_one_liner TEXT NOT NULL CHECK (length(trim(purpose_one_liner)) >= 10 AND length(trim(purpose_one_liner)) <= 180),
        description_optional TEXT,
        product_optional TEXT,
        default_duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (default_duration_minutes >= 5 AND default_duration_minutes <= 240),
        status opportunity_status NOT NULL DEFAULT 'draft',
        owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        external_link_optional TEXT,
        participant_type_required participant_type DEFAULT 'any',
        participant_type_specific_details TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create indexes for opportunities
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_opportunities_status_type_title 
      ON opportunities(status, type, title)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_opportunities_owner 
      ON opportunities(owner_user_id)
    `);

    // Create updated_at trigger function
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ language 'plpgsql'
    `);

    // Create trigger for opportunities updated_at
    await client.query(`
      CREATE TRIGGER update_opportunities_updated_at 
      BEFORE UPDATE ON opportunities 
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    `);

    // Create sessions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        opportunity_id UUID REFERENCES opportunities(id) ON DELETE CASCADE NOT NULL,
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ NOT NULL,
        capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 1),
        booked_count INTEGER NOT NULL DEFAULT 0 CHECK (booked_count >= 0),
        location_or_meet_link_optional TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CHECK (end_time > start_time),
        CHECK (booked_count <= capacity)
      )
    `);

    // Create indexes for sessions
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_opportunity 
      ON sessions(opportunity_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_time 
      ON sessions(start_time, end_time)
    `);

    // Create trigger for sessions updated_at
    await client.query(`
      CREATE TRIGGER update_sessions_updated_at 
      BEFORE UPDATE ON sessions 
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    `);

    // Create booking status enum
    await client.query(`
      CREATE TYPE booking_status AS ENUM ('booked', 'cancelled')
    `);

    // Create bookings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        session_id UUID REFERENCES sessions(id) ON DELETE CASCADE NOT NULL,
        status booking_status NOT NULL DEFAULT 'booked',
        gcal_event_id TEXT,
        cancelled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT unique_user_session_booking UNIQUE (user_id, session_id)
      )
    `);

    // Create indexes for bookings
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_user 
      ON bookings(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_session 
      ON bookings(session_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_status 
      ON bookings(status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_user_status 
      ON bookings(user_id, status)
    `);

    // Create trigger for bookings updated_at
    await client.query(`
      CREATE TRIGGER update_bookings_updated_at 
      BEFORE UPDATE ON bookings 
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    `);

    // Add 'question' type to existing enum if it doesn't exist
    try {
      // Check if the enum value already exists
      const enumCheck = await client.query(`
        SELECT 1 FROM pg_enum 
        WHERE enumlabel = 'question' 
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'opportunity_type')
      `);
      
      if (enumCheck.rows.length === 0) {
        await client.query(`
          ALTER TYPE opportunity_type ADD VALUE 'question'
        `);
        console.log('✅ Added question type to opportunity_type enum');
      } else {
        console.log('ℹ️  Question type already exists in opportunity_type enum');
      }
    } catch (error: any) {
      // Log the error but don't fail the migration
      console.log('ℹ️  Could not add question type to enum (may already exist):', error.message);
    }

    // Add participant_type_required column if it doesn't exist
    try {
      // Check if column exists first
      const columnCheck = await client.query(`
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'opportunities' 
        AND column_name = 'participant_type_required'
      `);
      
      if (columnCheck.rows.length === 0) {
        await client.query(`
          ALTER TABLE opportunities ADD COLUMN participant_type_required participant_type DEFAULT 'any'
        `);
        console.log('✅ Added participant_type_required column to opportunities table');
      } else {
        console.log('ℹ️  participant_type_required column already exists in opportunities table');
      }
    } catch (error: any) {
      console.log('ℹ️  Could not add participant_type_required column (may already exist):', error.message);
    }

    // Add participant_type_specific_details column if it doesn't exist
    try {
      // Check if column exists first
      const columnCheck = await client.query(`
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'opportunities' 
        AND column_name = 'participant_type_specific_details'
      `);
      
      if (columnCheck.rows.length === 0) {
        await client.query(`
          ALTER TABLE opportunities ADD COLUMN participant_type_specific_details TEXT
        `);
        console.log('✅ Added participant_type_specific_details column to opportunities table');
      } else {
        console.log('ℹ️  participant_type_specific_details column already exists in opportunities table');
      }
    } catch (error: any) {
      console.log('ℹ️  Could not add participant_type_specific_details column (may already exist):', error.message);
    }

    // Migrate is_researcher_admin to role column if needed
    try {
      // Check if is_researcher_admin column exists
      const columnCheck = await client.query(`
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'users' 
        AND column_name = 'is_researcher_admin'
      `);
      
      if (columnCheck.rows.length > 0) {
        // Check if role column exists
        const roleColumnCheck = await client.query(`
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'role'
        `);
        
        if (roleColumnCheck.rows.length === 0) {
          // Add role column
          await client.query(`
            ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'employee' CHECK (role IN ('employee', 'researcher_admin'))
          `);
          
          // Migrate data from is_researcher_admin to role
          await client.query(`
            UPDATE users SET role = CASE 
              WHEN is_researcher_admin = true THEN 'researcher_admin' 
              ELSE 'employee' 
            END
          `);
          
          // Make role column NOT NULL
          await client.query(`
            ALTER TABLE users ALTER COLUMN role SET NOT NULL
          `);
          
          // Drop the old is_researcher_admin column
          await client.query(`
            ALTER TABLE users DROP COLUMN is_researcher_admin
          `);
          
          console.log('✅ Migrated is_researcher_admin to role column');
        } else {
          console.log('ℹ️  Role column already exists, skipping migration');
        }
      } else {
        console.log('ℹ️  is_researcher_admin column does not exist, skipping migration');
      }
    } catch (error: any) {
      console.log('ℹ️  Could not migrate is_researcher_admin to role (may already be migrated):', error.message);
    }

    console.log('✅ Database migrations completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run migrations if this file is executed directly
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
