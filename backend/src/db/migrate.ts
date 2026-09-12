import { pool } from '../config';

/**
 * A MIGRATION MUST NOT BE ABLE TO REPORT SUCCESS AFTER A CANCELLED STATEMENT.
 *
 * TWELVE blocks below wrap `IF NOT EXISTS` / `DROP IF EXISTS` DDL in a
 * try/catch that logged the message and carried on. They swallowed EVERY error
 * class, which was survivable while nothing bounded a statement: the query
 * waited, and a slow deploy is at least a visible one.
 *
 * Twelve, measured - `grep -c 'catch (error: any)'` returned 9 more after the
 * 3 an independent review named. They are the same shape for the same reason,
 * so fixing 3 would have left 9 able to swallow the same cancellation.
 *
 * cto/AdaptaLabs#40 put a 120s `statement_timeout` on this pool, and that turned
 * the swallow into a silent deploy failure. Proven by fault injection - 57014
 * raised on the dedup DELETE, nothing else changed:
 *
 *   ℹ️  Session event dedup index may already exist: canceling statement due to
 *       statement timeout
 *   ✅ Database migrations completed successfully
 *   pg_indexes WHERE indexname='uq_session_event_dedup' -> 0
 *
 * A successful-looking migration with the dedup constraint absent. That DELETE
 * is a `NOT IN` anti-join over `opportunity_session_events`, which grows with
 * every participant session lifecycle event, so it is the likeliest statement
 * in this file to cross the bound - the danger is not theoretical.
 *
 * SQLSTATE CLASS 42 IS THE ONLY BENIGN CLASS. "Syntax error or access rule
 * violation" is where Postgres puts duplicate_table (42P07), duplicate_object
 * (42710), duplicate_column (42701), undefined_table (42P01) and
 * undefined_column (42703) - exactly the "the schema is already in this shape"
 * outcomes these blocks exist to tolerate. Everything else now rethrows:
 * cancellations (57014), connection loss (class 08), resource exhaustion
 * (class 53), deadlocks (40P01) and lock timeouts (55P03).
 *
 * DELIBERATELY NOT BENIGN: unique_violation (23505), which on the
 * `CREATE UNIQUE INDEX` below means the dedup DELETE left duplicates behind;
 * and check_violation (23514), which on the users role constraint means real
 * rows violate it. Both used to be swallowed and both are genuine failures. If
 * either starts failing a deploy, that is this guard working - the constraint
 * was silently absent before, not applied.
 *
 * THERE IS STILL NO `BEGIN` IN THIS FILE, so a rethrow leaves a partially
 * applied schema. That is not new and it is not made worse by failing loudly
 * rather than quietly; a partial schema that says so beats a partial schema
 * that reports success. Wrapping the run in a transaction is the upgrade path.
 *
 * ponytail: one error-class predicate for all three blocks rather than a
 * per-block allow-list.
 *   -> the blocks tolerate the same thing for the same reason, so a second
 *   predicate would be a second thing to keep in step. Split it if a block
 *   ever needs to tolerate something the others must not.
 */
function rethrowUnlessSchemaAlreadyApplied(error: unknown, note: string): void {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && code.startsWith('42')) {
    console.log(`ℹ️  ${note}:`, (error as Error).message);
    return;
  }
  throw error;
}

export async function runMigrations() {
  console.log('⏳ Connecting to database...');
  const client = await pool.connect();
  console.log('✅ Database connection established');
  
  try {
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
        CREATE TYPE opportunity_type AS ENUM ('test', 'poll', 'survey', 'question', 'interview', 'unmoderated');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    
    // Add 'unmoderated' to existing enum if it doesn't exist
    await client.query(`
      DO $$ BEGIN
        ALTER TYPE opportunity_type ADD VALUE IF NOT EXISTS 'unmoderated';
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
        start_date TIMESTAMPTZ,
        end_date TIMESTAMPTZ,
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
    await client.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ
    `);

    // Researcher notes on a moderated booking (#79). Distinct from
    // `admin_notes`, which is the one-shot completion-approval annotation:
    // this is the researcher's running record of the session itself, written
    // from the Participants tab. Lives on the booking row so it is deleted
    // with the booking, and so the participant-facing projections
    // (`ownBookingColumns`, `participantBookingColumns` in routes/bookings.ts)
    // exclude it by construction.
    await client.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS researcher_notes TEXT
    `);
    await client.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS researcher_notes_updated_at TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS researcher_notes_updated_by UUID REFERENCES users(id) ON DELETE SET NULL
    `);

    // Moderated consent (#79). A live session's consent is anchored on the
    // OPPORTUNITY - `firsthand.studies.consent_text` needs a study and a
    // moderated session has none. Same three-column shape as migration 0013
    // gave studies (text + template provenance) so "which approved wording is
    // this" is answerable the same way in both homes. Nullable: an opportunity
    // without consent text simply has no consent step, which is every
    // pre-existing row and every non-moderated type.
    await client.query(`
      ALTER TABLE opportunities
      ADD COLUMN IF NOT EXISTS consent_text TEXT
    `);
    await client.query(`
      ALTER TABLE opportunities
      ADD COLUMN IF NOT EXISTS consent_template_id TEXT
    `);
    await client.query(`
      ALTER TABLE opportunities
      ADD COLUMN IF NOT EXISTS consent_template_version INTEGER
    `);

    // The same three legal shapes 0013 constrains studies to: no claim at all,
    // custom wording, or a named template at a named version. Guarded because
    // ADD CONSTRAINT has no IF NOT EXISTS and this file re-runs on every boot.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'opportunities_consent_template_shape'
            AND conrelid = 'opportunities'::regclass
        ) THEN
          ALTER TABLE opportunities
            ADD CONSTRAINT opportunities_consent_template_shape
            CHECK (
              (consent_template_id IS NULL AND consent_template_version IS NULL)
              OR (consent_template_id = 'custom' AND consent_template_version IS NULL)
              OR (consent_template_id IS NOT NULL
                  AND consent_template_id <> 'custom'
                  AND consent_template_version IS NOT NULL)
            );
        END IF;
      END $$;
    `);

    // What a participant ACCEPTED when they booked (#79), pinned at the moment
    // of acceptance. The runtime path never snapshots wording - its acceptance
    // event points at a study row that can be edited afterwards - and that
    // asymmetry is a recorded defect of that path, not a precedent. Here the
    // hash pins the exact text; the template columns pin what it claimed to
    // be. Researcher-facing only, like researcher_notes above: both
    // participant projections must exclude nothing here (the participant
    // accepted it - it is their record too), but nothing here is secret
    // either, so the columns simply ride the existing projections untouched.
    await client.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS consent_accepted_at TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS consent_template_id TEXT
    `);
    await client.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS consent_template_version INTEGER
    `);
    await client.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS consent_text_snapshot_hash TEXT
    `);
    // The wording ITSELF, not only its hash. A security gate on step 1b made
    // the case: custom consent wording is editable after acceptances exist,
    // and a hash can prove the text changed but can never produce the sentence
    // the participant actually agreed to - which is the whole record in a
    // dispute. The hash stays for cheap comparisons; this column is the
    // recoverable copy.
    await client.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS consent_text_snapshot TEXT
    `);

    // An acceptance without its sentence is the hash-only defect reborn, so
    // the database refuses the shape outright: a recorded moment requires the
    // recoverable text and its hash beside it. Added while no acceptance rows
    // exist anywhere - a shape constraint retrofitted later has to argue with
    // whatever drifted in first.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'bookings_consent_acceptance_shape'
            AND conrelid = 'bookings'::regclass
        ) THEN
          ALTER TABLE bookings
            ADD CONSTRAINT bookings_consent_acceptance_shape
            CHECK (
              consent_accepted_at IS NULL
              OR (consent_text_snapshot IS NOT NULL
                  AND consent_text_snapshot_hash IS NOT NULL)
            );
        END IF;
      END $$;
    `);

    // The twin of opportunities_consent_template_shape: the acceptance record
    // pins the same pair, so it is constrained to the same three legal shapes.
    // Added while the columns are still empty everywhere (step 1b is what
    // starts writing them) - a shape constraint retrofitted onto populated
    // columns has to argue with whatever drifted in first.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'bookings_consent_template_shape'
            AND conrelid = 'bookings'::regclass
        ) THEN
          ALTER TABLE bookings
            ADD CONSTRAINT bookings_consent_template_shape
            CHECK (
              (consent_template_id IS NULL AND consent_template_version IS NULL)
              OR (consent_template_id = 'custom' AND consent_template_version IS NULL)
              OR (consent_template_id IS NOT NULL
                  AND consent_template_id <> 'custom'
                  AND consent_template_version IS NOT NULL)
            );
        END IF;
      END $$;
    `);

    /*
     * Clear the fabricated Google event ids (cto/AdaptaLabs#89).
     *
     * Until this release `CalendarService.createEvent` simulated its writes and
     * answered `{ success: true, eventId: 'demo-event-<now>' }`, and the booking
     * route wrote that id here. So production rows record Google events that
     * have never existed - which is not merely untidy: the cancel and reschedule
     * paths are gated on `booking.gcal_event_id` being truthy, so every one of
     * them attempts to delete or update a phantom event and logs about failing.
     *
     * Idempotent, and scoped by the exact prefix that only the simulation ever
     * produced - a real Google event id is base32hex and never starts
     * `demo-event-`. Nulling the column is the honest value: no event exists.
     *
     * ponytail: a data UPDATE in a runner with no version table, so this
     *   re-scans `bookings` unindexed on every boot, forever
     *   -> no issue: negligible at this table's size and a full migration
     *   versioning scheme is the real fix, not an index for this one statement.
     *   Revisit if `bookings` grows past ~1e6 rows or boot time becomes a
     *   concern. Verified idempotent against a real Postgres 17: UPDATE 2, then
     *   UPDATE 0, then UPDATE 0.
     */
    await client.query(`
      UPDATE bookings
      SET gcal_event_id = NULL
      WHERE gcal_event_id LIKE 'demo-event-%'
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
    } catch (error) {
      rethrowUnlessSchemaAlreadyApplied(error, 'Could not add question type to enum (may already exist)');
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
    } catch (error) {
      rethrowUnlessSchemaAlreadyApplied(error, 'Could not add interview type to enum (may already exist)');
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
    } catch (error) {
      rethrowUnlessSchemaAlreadyApplied(error, 'Could not add participant_type_required column (may already exist)');
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
    } catch (error) {
      rethrowUnlessSchemaAlreadyApplied(error, 'Could not add participant_type_specific_details column (may already exist)');
    }

    // Adds `display_width`, which is RETIRED: nothing writes it and NO SURFACE
    // CONSUMES it. The column is still selected and still goes out on the wire,
    // because the read paths use `SELECT *` and `RETURNING *` - so every
    // opportunity response still carries `display_width: 'single'` with no type
    // declaring it. The double-width home page layout it drove was removed on
    // 2026-08-17 by 844bae8, when the grid moved to closing-soonest ordering,
    // and the superadmin control that set it was removed with the rest of the
    // feature. The migration stays because existing rows carry values and
    // dropping the column buys nothing. Do not write to it again without
    // restoring a consumer first - a stored setting no surface reads is what
    // made this look like a working feature for nine months.
    try {
      const columnCheck = await client.query(`
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'opportunities' 
        AND column_name = 'display_width'
      `);
      
      if (columnCheck.rows.length === 0) {
        await client.query(`
          ALTER TABLE opportunities ADD COLUMN display_width TEXT DEFAULT 'single' CHECK (display_width IN ('single', 'double'))
        `);
        console.log('✅ Added display_width column to opportunities table');
      } else {
        console.log('ℹ️  display_width column already exists in opportunities table');
      }
    } catch (error) {
      rethrowUnlessSchemaAlreadyApplied(error, 'Could not add display_width column (may already exist)');
    }

    // Add start_date and end_date columns for external link study types (poll, survey, question, unmoderated)
    try {
      const startDateCheck = await client.query(`
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'opportunities' 
        AND column_name = 'start_date'
      `);
      
      if (startDateCheck.rows.length === 0) {
        await client.query(`
          ALTER TABLE opportunities ADD COLUMN start_date TIMESTAMPTZ
        `);
        console.log('✅ Added start_date column to opportunities table');
      } else {
        console.log('ℹ️  start_date column already exists in opportunities table');
      }
    } catch (error) {
      rethrowUnlessSchemaAlreadyApplied(error, 'Could not add start_date column (may already exist)');
    }

    try {
      const endDateCheck = await client.query(`
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'opportunities' 
        AND column_name = 'end_date'
      `);
      
      if (endDateCheck.rows.length === 0) {
        await client.query(`
          ALTER TABLE opportunities ADD COLUMN end_date TIMESTAMPTZ
        `);
        console.log('✅ Added end_date column to opportunities table');
      } else {
        console.log('ℹ️  end_date column already exists in opportunities table');
      }
    } catch (error) {
      rethrowUnlessSchemaAlreadyApplied(error, 'Could not add end_date column (may already exist)');
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
            ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'employee' CHECK (role IN ('employee', 'researcher_admin', 'superadmin'))
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
          
          // Update role constraint to include superadmin
          await client.query(`
            ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
            ALTER TABLE users ADD CONSTRAINT users_role_check 
              CHECK (role IN ('employee', 'researcher_admin', 'superadmin'));
          `);
          console.log('✅ Updated role constraint to include superadmin');
        } else {
          console.log('ℹ️  Role column already exists, skipping migration');
        }
      } else {
        console.log('ℹ️  is_researcher_admin column does not exist, skipping migration');
      }
    } catch (error) {
      rethrowUnlessSchemaAlreadyApplied(error, 'Could not migrate is_researcher_admin to role (may already be migrated)');
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
    } catch (error) {
      rethrowUnlessSchemaAlreadyApplied(error, 'Could not migrate unique constraint (may already be migrated)');
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
        ip_hash TEXT,
        visitor_nonce TEXT
      )
    `);

    // Add click_type column if table already exists without it.
    //
    // This catch used to be empty, on the stated reasoning that the column "may
    // already exist" - which ADD COLUMN IF NOT EXISTS already handles, so
    // nothing benign can reach the catch at all. Anything that does is a real
    // failure (a lock timeout, a privilege problem, a half-built table), and
    // discarding it left every click-tracking insert failing at runtime for the
    // life of the deployment with no trace anywhere.
    //
    // The error is not simply rethrown, because the outer catch aborts the
    // whole migration and takes the pod with it, and this column is not worth
    // that on the strength of an error nobody has ever seen. Instead the schema
    // is asked directly: continue if the column is there after all, fail loudly
    // if it genuinely is not.
    //
    // TWO REASONS THE OBVIOUS information_schema.columns QUERY IS WRONG HERE,
    // both of which turn this guard into the failure it exists to prevent:
    //
    //   1. It matches ANY schema, while ALTER TABLE binds the FIRST match on
    //      the search path. With a legacy public.opportunity_clicks that has
    //      the column and an app.opportunity_clicks that does not, the ALTER
    //      fails against app, the check finds public, and the migration goes
    //      green with the column still missing where it is actually used.
    //   2. information_schema is PRIVILEGE-FILTERED. A privilege failure is one
    //      of the causes named above, and it hides the column from the check
    //      for the same reason it broke the ALTER - so the one case designed to
    //      continue safely would rethrow and CrashLoop the pod instead.
    //
    // to_regclass resolves by the identical rule the ALTER used, by
    // construction, and pg_catalog is not privilege-filtered. Do not "simplify"
    // this back to information_schema.
    try {
      await client.query(`
        ALTER TABLE opportunity_clicks
        ADD COLUMN IF NOT EXISTS click_type TEXT NOT NULL DEFAULT 'action'
      `);
    } catch (error) {
      console.error(
        '❌ Could not add opportunity_clicks.click_type:',
        error instanceof Error ? error.message : String(error)
      );

      // Guarded in turn: if the ALTER failed because the connection died, this
      // throws too, and an unguarded version would replace the real cause with
      // "Client has encountered a connection error" on the way to the outer
      // catch - a different fault entirely from the one that happened.
      let columnCheck;
      try {
        columnCheck = await client.query(`
          SELECT 1
          FROM pg_attribute
          WHERE attrelid = to_regclass('opportunity_clicks')
            AND attname = 'click_type'
            AND attnum > 0
            AND NOT attisdropped
        `);
      } catch {
        throw error;
      }

      if (columnCheck.rows.length === 0) {
        throw error;
      }

      console.log('ℹ️  opportunity_clicks.click_type is present despite the error above, continuing');
    }

    // Add visitor_nonce column if the table predates it (#125). A first-party
    // per-visitor id recorded on anonymous clicks so the distinct-visitor count
    // survives the reverse proxy, which collapses every anonymous ip_hash to the
    // ingress address. Old rows and clients that send no nonce fall back to
    // ip_hash in the COALESCE at read time.
    //
    // Guarded exactly like click_type above, and for the same reason: the column
    // add itself is metadata-only (nullable, no default, no rewrite), but
    // `ADD COLUMN IF NOT EXISTS` still takes ACCESS EXCLUSIVE before it evaluates
    // IF NOT EXISTS, so on a busy opportunity_clicks it can lock-timeout even on
    // the no-op re-run. Unguarded, that one failure aborts the whole migration
    // and CrashLoops the pod - far too high a price for an OPTIONAL analytics
    // column the read path already degrades past (COALESCE -> ip_hash). So on
    // failure, ask the schema directly (to_regclass + pg_catalog, the same
    // resolution rule the ALTER used, not privilege-filtered information_schema)
    // and continue if the column is there, fail only if it genuinely is not.
    try {
      await client.query(`
        ALTER TABLE opportunity_clicks
        ADD COLUMN IF NOT EXISTS visitor_nonce TEXT
      `);
    } catch (error) {
      console.error(
        '❌ Could not add opportunity_clicks.visitor_nonce:',
        error instanceof Error ? error.message : String(error)
      );

      let columnCheck;
      try {
        columnCheck = await client.query(`
          SELECT 1
          FROM pg_attribute
          WHERE attrelid = to_regclass('opportunity_clicks')
            AND attname = 'visitor_nonce'
            AND attnum > 0
            AND NOT attisdropped
        `);
      } catch {
        throw error;
      }

      if (columnCheck.rows.length === 0) {
        throw error;
      }

      console.log('ℹ️  opportunity_clicks.visitor_nonce is present despite the error above, continuing');
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

    // Performance optimization: Add indexes for frequently queried columns
    // Index for sessions by opportunity_id (used in batch queries for opportunities list)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_opportunity_time 
      ON sessions(opportunity_id, start_time ASC)
    `);

    // Index for conflict checking (time range queries)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_time_range 
      ON sessions(start_time, end_time)
    `);

    // Index for bookings by session_id (used in booked_count calculations)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_session_status 
      ON bookings(session_id, status) 
      WHERE status = 'booked'
    `);

    // Composite index for opportunities filtering and sorting
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_opportunities_status_type_created 
      ON opportunities(status, type, created_at DESC)
    `);

    // Add meeting_location_optional column to opportunities table if it doesn't exist
    await client.query(`
      ALTER TABLE opportunities 
      ADD COLUMN IF NOT EXISTS meeting_location_optional TEXT
    `);

    // Create admin_requests table for admin access requests
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
    } catch (error) {
      rethrowUnlessSchemaAlreadyApplied(error, 'requested_role column may already exist');
    }

    // Create indexes for admin_requests
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_requests_user_id ON admin_requests(user_id);
      CREATE INDEX IF NOT EXISTS idx_admin_requests_status ON admin_requests(status);
      CREATE INDEX IF NOT EXISTS idx_admin_requests_requested_at ON admin_requests(requested_at DESC);
    `);
    console.log('✅ Created admin_requests indexes');

    // Update role constraint to include superadmin (if not already done)
    try {
      await client.query(`
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
        ALTER TABLE users ADD CONSTRAINT users_role_check 
          CHECK (role IN ('employee', 'researcher_admin', 'superadmin'));
      `);
      console.log('✅ Updated role constraint to include superadmin');
    } catch (error) {
      rethrowUnlessSchemaAlreadyApplied(error, 'Could not update role constraint (may already be updated)');
    }

    // Create feedback table for storing user feedback (superadmin inbox)
    await client.query(`
      CREATE TABLE IF NOT EXISTS feedback (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        user_name TEXT,
        user_email TEXT,
        category TEXT NOT NULL CHECK (category IN ('bug', 'feature', 'question', 'other')),
        feedback TEXT NOT NULL,
        url TEXT,
        user_agent TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ Created feedback table');

    // Create indexes for feedback table
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback(category);
      CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id);
    `);
    console.log('✅ Created feedback indexes');

    // Add firsthand_study_id column for Cortex↔FirstHand integration (Phase 5)
    await client.query(`
      ALTER TABLE opportunities
      ADD COLUMN IF NOT EXISTS firsthand_study_id TEXT
    `);

    // Whether a poll or survey runs inside Cortex or hands off to an external
    // service. Polls and surveys were external-link-only, forced by the publish
    // guard rather than by anything about the types themselves, so this turns a
    // fixed behaviour into a choice.
    //
    // DEFAULT 'external' is a correct backfill rather than a guess: every poll
    // and survey that exists when this runs carries an external link, because
    // the guard would not let it publish without one. Ignored for every other
    // type - a recorded study has no external mode and a bookable one has no
    // link at all.
    await client.query(`
      ALTER TABLE opportunities
      ADD COLUMN IF NOT EXISTS delivery_mode TEXT NOT NULL DEFAULT 'external'
    `);

    // Constrained for the same reason firsthand.studies.kind is: two code paths
    // will switch on this value, and the zod schema only guards the ones that
    // arrive through the API. Guarded because ADD CONSTRAINT has no
    // IF NOT EXISTS and this file re-runs on every deploy.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'opportunities_delivery_mode_check'
            AND conrelid = 'opportunities'::regclass
        ) THEN
          ALTER TABLE opportunities
            ADD CONSTRAINT opportunities_delivery_mode_check
            CHECK (delivery_mode IN ('native', 'external'));
        END IF;
      END $$;
    `);

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

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_events_opportunity
        ON opportunity_session_events(opportunity_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_events_participant
        ON opportunity_session_events(participant_user_id, occurred_at DESC);
    `);

    // Phase 9: dedup constraint so duplicate callback deliveries don't create duplicate rows
    try {
      await client.query(`
        DELETE FROM opportunity_session_events
        WHERE id NOT IN (
          SELECT DISTINCT ON (firsthand_session_id, event_type) id
          FROM opportunity_session_events
          ORDER BY firsthand_session_id, event_type, received_at DESC
        )
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_session_event_dedup
          ON opportunity_session_events(firsthand_session_id, event_type)
      `);
    } catch (error) {
      rethrowUnlessSchemaAlreadyApplied(error, 'Session event dedup index may already exist');
    }
    console.log('✅ Created opportunity_session_events table');

    // Booking artefacts (#79 step 2): recordings and transcripts of a
    // moderated session, ingested AFTER the call (decision D1 - the platform's
    // export, uploaded by the researcher). Attached to BOOKINGS (D4): the
    // session happened to a person who booked, and the runtime session model
    // cannot represent a session Cortex never ran. PUBLIC schema, like
    // bookings - the firsthand pool's search_path never sees these.
    //
    // The attestation trio records D3's escape hatch: consent legitimately
    // happened on the call for bookings made before the consent step shipped,
    // and storing WHO asserted that, WHEN and HOW (a typed reason, never a
    // bare boolean - review finding F13) is honest where silently allowing is
    // not. The CHECK forbids a partial attestation for the same reason the
    // consent shape CHECKs above forbid half a template pair.
    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_artifacts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('recording', 'transcript')),
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size_bytes BIGINT NOT NULL,
        storage_provider TEXT NOT NULL DEFAULT 's3',
        relative_path TEXT NOT NULL UNIQUE,
        uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        etag TEXT,
        consent_attested_by UUID REFERENCES users(id) ON DELETE SET NULL,
        consent_attested_at TIMESTAMPTZ,
        consent_attestation_reason TEXT,
        CONSTRAINT booking_artifacts_attestation_shape CHECK (
          (consent_attested_at IS NULL AND consent_attestation_reason IS NULL)
          OR (consent_attested_at IS NOT NULL AND consent_attestation_reason IS NOT NULL)
        )
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_booking_artifacts_booking
        ON booking_artifacts(booking_id, uploaded_at DESC)
    `);
    // Also as ALTER: `etag` joined the CREATE while this branch was still in
    // review, and CREATE TABLE IF NOT EXISTS skips a table that already
    // exists - so any database migrated mid-review (the local canary Postgres
    // this repo's workflow creates, a dev DB) would keep the old shape and
    // 500 on every finalize. The consent columns above use the same belt.
    await client.query(`
      ALTER TABLE booking_artifacts
      ADD COLUMN IF NOT EXISTS etag TEXT
    `);

    // The presign window, mirroring the runtime's pending_recording_uploads
    // (which lives in the FIRSTHAND migration runner - this is the public
    // twin). A presigned PUT is a raw write capability; the row is what makes
    // finalize refuse a URL nobody registered, and the UNIQUE path is what
    // stops two presigns racing onto one key. The attestation reason is
    // captured HERE so finalize persists what was asserted at presign time,
    // not whatever the finalize body cares to say.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pending_booking_artifact_uploads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('recording', 'transcript')),
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        consent_attestation_reason TEXT,
        valid_until TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pending_booking_artifact_uploads_booking
        ON pending_booking_artifact_uploads(booking_id)
    `);
    console.log('✅ Created booking_artifacts tables');

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
    .catch((error) => {
      console.error('❌ Migration script failed:', error);
      process.exit(1);
    });
}
