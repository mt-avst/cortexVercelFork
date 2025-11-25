#!/usr/bin/env node
/**
 * Run database migrations for production
 * Uses DATABASE_URL from environment variables
 */

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!databaseUrl) {
  console.error('❌ DATABASE_URL or POSTGRES_URL environment variable is not set');
  process.exit(1);
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

async function runMigrations() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 Running database migrations...\n');

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
    console.log('✅ Created users table');

    // Update existing role constraint to include superadmin (if table exists)
    try {
      await client.query(`
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
        ALTER TABLE users ADD CONSTRAINT users_role_check 
          CHECK (role IN ('employee', 'researcher_admin', 'superadmin'));
      `);
      console.log('✅ Updated users role constraint to include superadmin');
    } catch (error: any) {
      // Table might not exist yet, or constraint might not exist - that's okay
      console.log('ℹ️  Role constraint update skipped (may already be correct)');
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
    console.log('✅ Created notification_preferences table');

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
    console.log('✅ Created user_calendar_tokens table');

    // Create index for user_calendar_tokens
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_calendar_tokens_user_id 
      ON user_calendar_tokens(user_id)
    `);
    console.log('✅ Created indexes');

    // Create admin_requests table
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        requested_role TEXT NOT NULL CHECK (requested_role IN ('researcher_admin', 'superadmin')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
        reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('✅ Created admin_requests table');

    // Add requested_role column if it doesn't exist (for existing tables)
    try {
      await client.query(`
        ALTER TABLE admin_requests 
        ADD COLUMN IF NOT EXISTS requested_role TEXT CHECK (requested_role IN ('researcher_admin', 'superadmin'));
      `);
      // Update existing rows to have requested_role = 'researcher_admin' (default for old requests)
      await client.query(`
        UPDATE admin_requests 
        SET requested_role = 'researcher_admin' 
        WHERE requested_role IS NULL;
      `);
      // Make it NOT NULL after setting defaults
      await client.query(`
        ALTER TABLE admin_requests 
        ALTER COLUMN requested_role SET NOT NULL;
      `);
      console.log('✅ Added requested_role column to admin_requests');
    } catch (error: any) {
      console.log('ℹ️  requested_role column may already exist:', error.message);
    }

    // Create indexes for admin_requests
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_requests_user_id ON admin_requests(user_id);
      CREATE INDEX IF NOT EXISTS idx_admin_requests_status ON admin_requests(status);
      CREATE INDEX IF NOT EXISTS idx_admin_requests_requested_at ON admin_requests(requested_at DESC);
    `);
    console.log('✅ Created admin_requests indexes');

    // Add display_width column for controlling pod size on user front page (superadmin only)
    try {
      await client.query(`
        ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS display_width TEXT DEFAULT 'single' CHECK (display_width IN ('single', 'double'))
      `);
      console.log('✅ Added display_width column to opportunities table');
    } catch (error: any) {
      console.log('ℹ️  display_width column may already exist:', error.message);
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
    console.log('✅ Created opportunity_clicks table');

    // Add click_type column if table already exists without it
    try {
      await client.query(`
        ALTER TABLE opportunity_clicks 
        ADD COLUMN IF NOT EXISTS click_type TEXT NOT NULL DEFAULT 'action'
      `);
      console.log('✅ Added click_type column to opportunity_clicks');
    } catch (error: any) {
      console.log('ℹ️  click_type column may already exist:', error.message);
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
    console.log('✅ Created opportunity_clicks indexes');

    console.log('\n✅ All migrations completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations()
  .then(() => {
    console.log('\n🎉 Database is ready!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  });





