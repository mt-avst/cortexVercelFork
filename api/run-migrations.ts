import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Pool } from 'pg';
import { createSafeErrorResponse } from './utils/errors';

/**
 * GET /api/run-migrations
 * Run database migrations
 * This endpoint should be called manually to run migrations
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  if (!databaseUrl) {
    return res.status(500).json({ 
      error: 'DATABASE_URL or POSTGRES_URL environment variable is not set' 
    });
  }

  // Clean up connection string
  let cleanUrl = databaseUrl.trim();
  if (cleanUrl.startsWith('"') || cleanUrl.startsWith("'")) {
    cleanUrl = cleanUrl.slice(1, -1);
  }
  if (cleanUrl.startsWith("psql '")) {
    cleanUrl = cleanUrl.replace(/^psql ['"]/, '').replace(/['"]$/, '');
  }

  const pool = new Pool({
    connectionString: cleanUrl,
    ssl: {
      rejectUnauthorized: false
    }
  });

  const logs: string[] = [];
  const log = (message: string) => {
    console.log(message);
    logs.push(message);
  };

  let client;
  try {
    client = await pool.connect();
    log('🔄 Running database migrations...');

    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        business_unit TEXT,
        role_title TEXT,
        role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'researcher_admin', 'superadmin')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    log('✅ Created users table');

    // Update existing role constraint to include superadmin (if table exists)
    try {
      await client.query(`
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
        ALTER TABLE users ADD CONSTRAINT users_role_check 
          CHECK (role IN ('employee', 'researcher_admin', 'superadmin'));
      `);
      log('✅ Updated users role constraint to include superadmin');
    } catch (error: unknown) {
      const err = error as Error;
      log('ℹ️  Role constraint update skipped: ' + err.message);
    }

    // Create notification_preferences table
    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        on_book_email BOOLEAN DEFAULT true,
        on_cancel_email BOOLEAN DEFAULT true
      )
    `);
    log('✅ Created notification_preferences table');

    // Create user_calendar_tokens table
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
    log('✅ Created user_calendar_tokens table');

    // Create index for user_calendar_tokens
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_calendar_tokens_user_id 
      ON user_calendar_tokens(user_id)
    `);
    log('✅ Created user_calendar_tokens indexes');

    // Create admin_requests table
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        requested_role TEXT NOT NULL DEFAULT 'researcher_admin' CHECK (requested_role IN ('researcher_admin', 'superadmin')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
        reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    log('✅ Created admin_requests table');

    // Create indexes for admin_requests
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_requests_user_id ON admin_requests(user_id);
      CREATE INDEX IF NOT EXISTS idx_admin_requests_status ON admin_requests(status);
      CREATE INDEX IF NOT EXISTS idx_admin_requests_requested_at ON admin_requests(requested_at DESC);
    `);
    log('✅ Created admin_requests indexes');

    // Create feedback table for storing user feedback (superadmin inbox)
    await client.query(`
      CREATE TABLE IF NOT EXISTS feedback (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        user_name TEXT,
        user_email TEXT,
        category TEXT NOT NULL CHECK (category IN ('bug', 'feature', 'question', 'other', 'footer')),
        feedback TEXT NOT NULL,
        url TEXT,
        user_agent TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    log('✅ Created feedback table');

    // Allow 'footer' category for feedback footer submissions (existing DBs may have old CHECK)
    try {
      await client.query(`
        ALTER TABLE feedback DROP CONSTRAINT IF EXISTS feedback_category_check;
        ALTER TABLE feedback ADD CONSTRAINT feedback_category_check
          CHECK (category IN ('bug', 'feature', 'question', 'other', 'footer'));
      `);
      log('✅ Updated feedback category constraint to allow footer');
    } catch (error: unknown) {
      const err = error as Error;
      log('ℹ️  feedback category constraint may already be updated: ' + err.message);
    }

    // Create indexes for feedback table
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback(category);
      CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id);
    `);
    log('✅ Created feedback indexes');

    // Add reminder_sent_at to bookings for email reminder automation
    const bookingsExists = await client.query(`
      SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'bookings')
    `);
    if (bookingsExists.rows[0]?.exists) {
      try {
        await client.query(`
          ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ
        `);
        log('✅ Added reminder_sent_at column to bookings table');
      } catch (error: unknown) {
        const err = error as Error;
        log('ℹ️  reminder_sent_at column may already exist: ' + err.message);
      }
    }

    // Add 'unmoderated' to opportunity_type enum if it doesn't exist
    try {
      // Check if 'unmoderated' value exists in the enum
      const enumCheck = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_enum 
          WHERE enumlabel = 'unmoderated' 
          AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'opportunity_type')
        )
      `);
      
      if (!enumCheck.rows[0]?.exists) {
        await client.query(`ALTER TYPE opportunity_type ADD VALUE 'unmoderated'`);
        log('✅ Added unmoderated to opportunity_type enum');
      } else {
        log('ℹ️  unmoderated already exists in opportunity_type enum');
      }
    } catch (error: unknown) {
      const err = error as Error;
      log('ℹ️  Could not add unmoderated to enum: ' + err.message);
    }

    // Check if opportunities table exists (it might have been created by another migration)
    const opportunitiesCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'opportunities'
      )
    `);
    const opportunitiesExists = opportunitiesCheck.rows[0]?.exists;

    if (opportunitiesExists) {
      // Add display_width column for controlling pod size on user front page (superadmin only)
      try {
        await client.query(`
          ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS display_width TEXT DEFAULT 'single' CHECK (display_width IN ('single', 'double'))
        `);
        log('✅ Added display_width column to opportunities table');
      } catch (error: unknown) {
        const err = error as Error;
        log('ℹ️  display_width column may already exist: ' + err.message);
      }

      // Add start_date and end_date columns for external link study types
      try {
        await client.query(`
          ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ
        `);
        log('✅ Added start_date column to opportunities table');
      } catch (error: unknown) {
        const err = error as Error;
        log('ℹ️  start_date column may already exist: ' + err.message);
      }

      try {
        await client.query(`
          ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ
        `);
        log('✅ Added end_date column to opportunities table');
      } catch (error: unknown) {
        const err = error as Error;
        log('ℹ️  end_date column may already exist: ' + err.message);
      }

      // Create opportunity_clicks table for click tracking (M6)
      // click_type: 'view' = user viewed the study details, 'action' = user clicked action button (open link/book session)
      await client.query(`
        CREATE TABLE IF NOT EXISTS opportunity_clicks (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          opportunity_id UUID REFERENCES opportunities(id) ON DELETE CASCADE NOT NULL,
          user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          click_type TEXT NOT NULL DEFAULT 'action',
          clicked_at TIMESTAMPTZ DEFAULT NOW(),
          user_agent TEXT,
          ip_hash TEXT
        )
      `);
      log('✅ Created opportunity_clicks table');

      // Add click_type column if table already exists without it
      try {
        await client.query(`
          ALTER TABLE opportunity_clicks 
          ADD COLUMN IF NOT EXISTS click_type TEXT NOT NULL DEFAULT 'action'
        `);
        log('✅ Added click_type column to opportunity_clicks');
      } catch (error: unknown) {
        const err = error as Error;
        log('ℹ️  click_type column may already exist: ' + err.message);
      }

      // Create index for efficient analytics queries
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_clicks_opportunity 
        ON opportunity_clicks(opportunity_id, clicked_at)
      `);
      
      // Create index for click_type filtering
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_clicks_type 
        ON opportunity_clicks(opportunity_id, click_type, clicked_at)
      `);
      log('✅ Created opportunity_clicks indexes');
    } else {
      log('⚠️  Opportunities table does not exist - skipping opportunity-related migrations');
    }

    // Add firsthand_study_id column for Cortex↔FirstHand integration (Phase 5)
    if (opportunitiesExists) {
      try {
        await client.query(`
          ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS firsthand_study_id TEXT
        `);
        log('✅ Added firsthand_study_id column to opportunities table');
      } catch (error: unknown) {
        const err = error as Error;
        log('ℹ️  firsthand_study_id column may already exist: ' + err.message);
      }
    }

    // Create opportunity_session_events table for FirstHand lifecycle callbacks (Phase 6)
    await client.query(`
      CREATE TABLE IF NOT EXISTS opportunity_session_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        opportunity_id UUID REFERENCES opportunities(id) ON DELETE CASCADE NOT NULL,
        participant_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        firsthand_session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        payload JSONB,
        received_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    log('✅ Created opportunity_session_events table');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_events_opportunity
        ON opportunity_session_events(opportunity_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_events_participant
        ON opportunity_session_events(participant_user_id, occurred_at DESC);
    `);

    // Phase 9: dedup constraint so duplicate callback deliveries don't create duplicate rows
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_session_event_dedup
        ON opportunity_session_events(firsthand_session_id, event_type);
    `);
    log('✅ Created opportunity_session_events indexes');

    log('✅ All migrations completed successfully!');

    return res.status(200).json({
      success: true,
      message: 'Migrations completed successfully',
      logs
    });
  } catch (error: unknown) {
    const err = error as Error;
    console.error('❌ Migration failed:', err);
    log('❌ Migration failed: ' + err.message);
    const safe = createSafeErrorResponse(error, { userMessage: 'Migration failed' });
    return res.status(500).json({
      success: false,
      error: safe.error,
      logs
    });
  } finally {
    if (client) {
      client.release();
    }
    await pool.end();
  }
}
