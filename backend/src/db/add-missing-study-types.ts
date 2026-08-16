import { Pool } from 'pg';
import { applyDbTls } from '../config/dbTls';

/**
 * Add missing study types to production database
 * Run with: DATABASE_URL=<production_url> npx tsx backend/src/db/add-missing-study-types.ts
 */
async function addMissingStudyTypes() {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  
  if (!databaseUrl) {
    throw new Error('DATABASE_URL or POSTGRES_URL environment variable is not set');
  }

  // Clean up connection string
  let cleanUrl = databaseUrl.trim();
  if (cleanUrl.startsWith('"') || cleanUrl.startsWith("'")) {
    cleanUrl = cleanUrl.slice(1, -1);
  }

  console.log('🔌 Connecting to database...');
  const tls = applyDbTls(cleanUrl, process.env, 'add-missing-study-types');
  const pool = new Pool({
    connectionString: tls.connectionString,
    ssl: tls.ssl
  });

  const client = await pool.connect();

  try {
    // Check which types already exist
    console.log('📊 Checking existing study types...');
    const existingTypes = await client.query(
      'SELECT DISTINCT type FROM opportunities WHERE status = $1',
      ['published']
    );
    
    const existingTypeSet = new Set(existingTypes.rows.map(r => r.type));
    console.log('✅ Existing types:', Array.from(existingTypeSet).join(', ') || 'none');

    // Get or create an admin user
    console.log('👤 Finding admin user...');
    let ownerUserId: string;
    
    const adminEmail = process.env.ADMIN_EMAILS?.split(',')[0] || 'nick@nickster.com';
    const userResult = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [adminEmail]
    );

    if (userResult.rows.length > 0) {
      ownerUserId = userResult.rows[0].id;
      console.log(`✅ Found user: ${adminEmail}`);
    } else {
      // Try finding any admin
      const adminRoleResult = await client.query(
        "SELECT id, email FROM users WHERE role = 'researcher_admin' LIMIT 1"
      );
      
      if (adminRoleResult.rows.length > 0) {
        ownerUserId = adminRoleResult.rows[0].id;
        console.log(`✅ Found admin user: ${adminRoleResult.rows[0].email}`);
      } else {
        // Fall back to any user
        console.log('⚠️  No admin found, looking for any user...');
        const anyUserResult = await client.query(
          "SELECT id, email FROM users LIMIT 1"
        );
        
        if (anyUserResult.rows.length > 0) {
          ownerUserId = anyUserResult.rows[0].id;
          console.log(`✅ Using user: ${anyUserResult.rows[0].email}`);
        } else {
          throw new Error('No users found in database. Please create a user first.');
        }
      }
    }

    // Define the missing study types to add
    const studyTypesToAdd = [
      {
        type: 'interview',
        title: 'Customer Journey Research Interview',
        purpose_one_liner: 'Share your experiences and help us understand customer needs',
        description_optional: 'Join us for a 1-on-1 interview where we will discuss your experience with our products and services. We want to understand your workflow, pain points, and what features would make your life easier.',
        default_duration_minutes: 60,
        location: 'Remote - Video Call',
      },
      {
        type: 'poll',
        title: 'Feature Priority Poll',
        purpose_one_liner: 'Vote on which features matter most to you',
        description_optional: 'Help us prioritize our product roadmap by voting on the features you would like to see next. Takes just a few minutes!',
        default_duration_minutes: 15,
        location: 'Online',
      },
      {
        type: 'unmoderated',
        title: 'Self-Guided Checkout Flow Test',
        purpose_one_liner: 'Complete checkout tasks at your own pace',
        description_optional: 'Test our new checkout flow independently. You will receive step-by-step instructions and can complete the tasks whenever convenient.',
        default_duration_minutes: 30,
        location: 'Self-Guided',
      },
      {
        type: 'question',
        title: 'Quick Feedback Questions',
        purpose_one_liner: 'Answer a few quick questions about your experience',
        description_optional: 'Help us improve by answering a short set of questions about your recent experience with our product.',
        default_duration_minutes: 15,
        location: 'Online',
      },
    ];

    // Filter to only types that don't exist
    const typesToCreate = studyTypesToAdd.filter(s => !existingTypeSet.has(s.type));
    
    if (typesToCreate.length === 0) {
      console.log('✅ All study types already exist! Nothing to add.');
      return;
    }

    console.log(`📝 Adding ${typesToCreate.length} missing study types...`);

    await client.query('BEGIN');

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    for (const opp of typesToCreate) {
      const oppResult = await client.query(
        `INSERT INTO opportunities (
          type, title, purpose_one_liner, description_optional, 
          default_duration_minutes, status, owner_user_id, meeting_location_optional,
          participant_type_required
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id`,
        [
          opp.type,
          opp.title,
          opp.purpose_one_liner,
          opp.description_optional,
          opp.default_duration_minutes,
          'published',
          ownerUserId,
          opp.location,
          'any'
        ]
      );

      const opportunityId = oppResult.rows[0].id;
      console.log(`✅ Created ${opp.type}: ${opp.title}`);

      // Create sessions for this opportunity (next 2 weeks)
      for (let day = 0; day < 14; day++) {
        const sessionDate = new Date(tomorrow);
        sessionDate.setDate(sessionDate.getDate() + day);
        
        // Skip weekends
        if (sessionDate.getDay() === 0 || sessionDate.getDay() === 6) continue;
        
        // Create 3 sessions per weekday
        const timeSlots = [
          { hour: 10, minute: 0 },  // 10:00 AM
          { hour: 14, minute: 0 },  // 2:00 PM
          { hour: 16, minute: 0 },  // 4:00 PM
        ];

        for (const slot of timeSlots) {
          const startTime = new Date(sessionDate);
          startTime.setHours(slot.hour, slot.minute, 0, 0);
          
          const endTime = new Date(startTime);
          endTime.setMinutes(endTime.getMinutes() + opp.default_duration_minutes);

          await client.query(
            `INSERT INTO sessions (
              opportunity_id, start_time, end_time, capacity, booked_count,
              location_or_meet_link_optional
            ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              opportunityId,
              startTime,
              endTime,
              5,  // capacity
              0,  // booked_count
              opp.location,
            ]
          );
        }
      }
      console.log(`  📅 Created sessions for the next 2 weeks`);
    }

    await client.query('COMMIT');
    console.log('\n✅ Successfully added missing study types!');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the script
addMissingStudyTypes()
  .then(() => {
    console.log('✅ Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Failed:', error);
    process.exit(1);
  });

