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

    // Create user_profiles table for AdaptaBits
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE NOT NULL,
        total_points INTEGER NOT NULL DEFAULT 0 CHECK (total_points >= 0),
        monthly_points INTEGER NOT NULL DEFAULT 0 CHECK (monthly_points >= 0),
        level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
        sessions_completed INTEGER NOT NULL DEFAULT 0 CHECK (sessions_completed >= 0),
        surveys_completed INTEGER NOT NULL DEFAULT 0 CHECK (surveys_completed >= 0),
        polls_completed INTEGER NOT NULL DEFAULT 0 CHECK (polls_completed >= 0),
        questions_completed INTEGER NOT NULL DEFAULT 0 CHECK (questions_completed >= 0),
        last_activity_date TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create achievements table
    await client.query(`
      CREATE TABLE IF NOT EXISTS achievements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        icon TEXT NOT NULL,
        points_required INTEGER NOT NULL CHECK (points_required >= 0),
        category TEXT NOT NULL CHECK (category IN ('participation', 'milestone', 'special')),
        badge_color TEXT NOT NULL DEFAULT '#28a745',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create user_achievements table
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_achievements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        achievement_id UUID REFERENCES achievements(id) ON DELETE CASCADE NOT NULL,
        earned_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT unique_user_achievement UNIQUE (user_id, achievement_id)
      )
    `);

    // Create user_calendar_tokens table for Google Calendar integration
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_calendar_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at TIMESTAMPTZ,
        token_type VARCHAR(50) DEFAULT 'Bearer',
        scope TEXT,
        calendar_id VARCHAR(255) DEFAULT 'primary',
        connected_at TIMESTAMPTZ DEFAULT NOW(),
        last_refreshed_at TIMESTAMPTZ
      )
    `);

    // Create index for user_calendar_tokens
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_calendar_tokens_user_id 
      ON user_calendar_tokens(user_id)
    `);

    // Note: points_transactions table is created AFTER opportunities and sessions tables
    // because it has foreign key references to both

    // Create indexes for AdaptaBits tables
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_profiles_points 
      ON user_profiles(total_points DESC, monthly_points DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id 
      ON user_profiles(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_achievements_user_id 
      ON user_achievements(user_id)
    `);

    // Note: idx_points_transactions_user_id index is created AFTER points_transactions table
    // (which is created after opportunities and sessions tables)

    // Create updated_at trigger function (must be created before any triggers use it)
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ language 'plpgsql'
    `);

    // Create triggers for user_profiles updated_at
    await client.query(`
      DROP TRIGGER IF EXISTS update_user_profiles_updated_at ON user_profiles;
      CREATE TRIGGER update_user_profiles_updated_at 
      BEFORE UPDATE ON user_profiles 
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    `);

    // Create opportunity types enum
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE opportunity_type AS ENUM ('test', 'poll', 'survey', 'question', 'interview');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // Create opportunity status enum
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE opportunity_status AS ENUM ('draft', 'published', 'closed');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // Create participant type enum
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE participant_type AS ENUM ('any', 'internal', 'external', 'specific');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
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
        meeting_location_optional TEXT,
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
      DROP TRIGGER IF EXISTS update_opportunities_updated_at ON opportunities;
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
      DROP TRIGGER IF EXISTS update_sessions_updated_at ON sessions;
      CREATE TRIGGER update_sessions_updated_at 
      BEFORE UPDATE ON sessions 
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    `);

    // Create points_transactions table for tracking point history
    // Must be created AFTER opportunities and sessions tables (due to foreign key constraints)
    await client.query(`
      CREATE TABLE IF NOT EXISTS points_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        points INTEGER NOT NULL,
        reason TEXT NOT NULL,
        opportunity_id UUID REFERENCES opportunities(id) ON DELETE SET NULL,
        session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create indexes for points_transactions
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_points_transactions_user_id 
      ON points_transactions(user_id, created_at DESC)
    `);

    // Create booking status enum
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE booking_status AS ENUM ('booked', 'cancelled');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
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
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    
    // Create partial unique index for active bookings only
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS unique_user_session_booking_active 
      ON bookings(user_id, session_id) 
      WHERE status = 'booked'
    `);

    // Add completion status fields to bookings table
    await client.query(`
      ALTER TABLE bookings 
      ADD COLUMN IF NOT EXISTS completion_status TEXT DEFAULT 'pending' 
      CHECK (completion_status IN ('pending', 'completed', 'approved', 'rejected'))
    `);
    await client.query(`
      ALTER TABLE bookings 
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE bookings 
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE bookings 
      ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id)
    `);
    await client.query(`
      ALTER TABLE bookings 
      ADD COLUMN IF NOT EXISTS admin_notes TEXT
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

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_completion_status 
      ON bookings(completion_status)
    `);

    // Create trigger for bookings updated_at
    await client.query(`
      DROP TRIGGER IF EXISTS update_bookings_updated_at ON bookings;
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

    // Add 'interview' type to existing enum if it doesn't exist
    try {
      // Check if the enum value already exists
      const enumCheck = await client.query(`
        SELECT 1 FROM pg_enum 
        WHERE enumlabel = 'interview' 
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'opportunity_type')
      `);
      
      if (enumCheck.rows.length === 0) {
        await client.query(`
          ALTER TYPE opportunity_type ADD VALUE 'interview'
        `);
        console.log('✅ Added interview type to opportunity_type enum');
      } else {
        console.log('ℹ️  Interview type already exists in opportunity_type enum');
      }
    } catch (error: any) {
      // Log the error but don't fail the migration
      console.log('ℹ️  Could not add interview type to enum (may already exist):', error.message);
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

    // Migrate unique constraint to partial unique index (for cancelled bookings to allow rebooking)
    try {
      await client.query(`
        ALTER TABLE bookings DROP CONSTRAINT IF EXISTS unique_user_session_booking
      `);
      
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS unique_user_session_booking_active 
        ON bookings(user_id, session_id) 
        WHERE status = 'booked'
      `);
      
      console.log('✅ Migrated unique constraint to partial unique index');
    } catch (error: any) {
      console.log('ℹ️  Could not migrate unique constraint (may already be migrated):', error.message);
    }

    // Create opportunity_clicks table for click tracking (M6)
    await client.query(`
      CREATE TABLE IF NOT EXISTS opportunity_clicks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        opportunity_id UUID REFERENCES opportunities(id) ON DELETE CASCADE NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        clicked_at TIMESTAMPTZ DEFAULT NOW(),
        user_agent TEXT,
        ip_hash TEXT
      )
    `);

    // Create index for efficient analytics queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_clicks_opportunity 
      ON opportunity_clicks(opportunity_id, clicked_at)
    `);

    // Add meeting_location_optional column to opportunities table if it doesn't exist
    await client.query(`
      ALTER TABLE opportunities 
      ADD COLUMN IF NOT EXISTS meeting_location_optional TEXT
    `);

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
