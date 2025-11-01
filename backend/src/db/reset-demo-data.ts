import { pool } from '../config';

/**
 * Clean database and add 6 new demo opportunities
 * - 2 test opportunities
 * - 2 poll opportunities  
 * - 2 survey opportunities
 */
export async function resetDemoData() {
  const client = await pool.connect();
  
  try {
    console.log('🧹 Cleaning database...');
    
    // Delete all bookings (cascades to related data)
    await client.query('DELETE FROM bookings');
    console.log('✅ Deleted all bookings');
    
    // Delete all sessions
    await client.query('DELETE FROM sessions');
    console.log('✅ Deleted all sessions');
    
    // Delete all opportunities
    await client.query('DELETE FROM opportunities');
    console.log('✅ Deleted all opportunities');
    
    // Get the demo admin user ID
    const adminResult = await client.query(
      `SELECT id FROM users WHERE email = $1 OR role = 'researcher_admin' LIMIT 1`,
      ['admin@test.com']
    );
    
    if (adminResult.rows.length === 0) {
      throw new Error('Demo admin user not found. Please run seed script first.');
    }
    
    const adminUserId = adminResult.rows[0].id;
    console.log(`✅ Using admin user ID: ${adminUserId}`);
    
    // Calculate dates for sessions (next week, Monday-Friday)
    const today = new Date();
    const nextMonday = new Date(today);
    nextMonday.setDate(today.getDate() + (8 - today.getDay()) % 7 || 7);
    nextMonday.setHours(0, 0, 0, 0);
    
    // Helper to create sessions for an opportunity
    const createSessions = async (opportunityId: string, defaultDuration: number, days: number[]) => {
      const sessions = [];
      for (const dayOffset of days) {
        const sessionDate = new Date(nextMonday);
        sessionDate.setDate(nextMonday.getDate() + dayOffset);
        
        // Create 3 sessions per day: 10am, 2pm, 3pm
        const times = [10, 14, 15];
        for (const hour of times) {
          const startTime = new Date(sessionDate);
          startTime.setHours(hour, 0, 0, 0);
          
          const endTime = new Date(startTime);
          endTime.setMinutes(endTime.getMinutes() + defaultDuration);
          
          const result = await client.query(
            `INSERT INTO sessions (opportunity_id, start_time, end_time, capacity, location_or_meet_link_optional)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [
              opportunityId,
              startTime.toISOString(),
              endTime.toISOString(),
              5, // Capacity of 5
              `https://meet.google.com/${Math.random().toString(36).substring(2, 11)}`
            ]
          );
          sessions.push(result.rows[0].id);
        }
      }
      return sessions;
    };
    
    console.log('📝 Creating demo opportunities...');
    
    // 1. Test Opportunity 1: User Interface Testing
    const test1Result = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional, product_optional,
        default_duration_minutes, status, owner_user_id, participant_type_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [
        'test',
        'User Interface Testing',
        'Help us improve our mobile app interface through usability testing',
        'We are looking for users to test our new mobile app interface. This will involve completing various tasks while we observe your interactions and gather feedback on the design and usability.',
        'Mobile Banking App',
        45,
        'published',
        adminUserId,
        'any'
      ]
    );
    const test1Id = test1Result.rows[0].id;
    await createSessions(test1Id, 45, [0, 1, 2, 3, 4]); // Mon-Fri
    console.log('✅ Created Test Opportunity 1: User Interface Testing');
    
    // 2. Test Opportunity 2: Feature Validation
    const test2Result = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional, product_optional,
        default_duration_minutes, status, owner_user_id, participant_type_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [
        'test',
        'New Feature Validation',
        'Test our latest dashboard features and provide feedback',
        'We\'ve built some exciting new features for our analytics dashboard and need your help to validate them. Share your thoughts on functionality, design, and overall experience.',
        'Analytics Dashboard',
        30,
        'published',
        adminUserId,
        'internal'
      ]
    );
    const test2Id = test2Result.rows[0].id;
    await createSessions(test2Id, 30, [0, 2, 4]); // Mon, Wed, Fri
    console.log('✅ Created Test Opportunity 2: New Feature Validation');
    
    // 3. Poll Opportunity 1: Work-Life Balance
    const poll1Result = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional,
        default_duration_minutes, status, owner_user_id, external_link_optional, participant_type_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [
        'poll',
        'Work-Life Balance Survey',
        'Share your thoughts on work-life balance at AdaptaLabs',
        'We want to understand how our team members are managing work-life balance. Your anonymous input will help us improve our workplace policies and support programs.',
        5,
        'published',
        adminUserId,
        'https://forms.google.com/work-life-balance-poll',
        'internal'
      ]
    );
    const poll1Id = poll1Result.rows[0].id;
    // Polls don't need sessions, but we can add them for consistency
    await createSessions(poll1Id, 5, [0, 1, 2, 3, 4]);
    console.log('✅ Created Poll Opportunity 1: Work-Life Balance Survey');
    
    // 4. Poll Opportunity 2: Remote Work Preferences
    const poll2Result = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional,
        default_duration_minutes, status, owner_user_id, external_link_optional, participant_type_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [
        'poll',
        'Remote Work Preferences',
        'Tell us about your remote work preferences and experiences',
        'Help us understand your preferences for remote, hybrid, and in-office work arrangements. This quick poll will inform our future office and remote work policies.',
        5,
        'published',
        adminUserId,
        'https://forms.google.com/remote-work-poll',
        'any'
      ]
    );
    const poll2Id = poll2Result.rows[0].id;
    await createSessions(poll2Id, 5, [1, 3]); // Tue, Thu
    console.log('✅ Created Poll Opportunity 2: Remote Work Preferences');
    
    // 5. Survey Opportunity 1: Employee Engagement
    const survey1Result = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional,
        default_duration_minutes, status, owner_user_id, external_link_optional, participant_type_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [
        'survey',
        'Employee Engagement Survey',
        'Help us understand engagement levels across the organization',
        'Your feedback is crucial in helping us create a better workplace. This comprehensive survey covers topics like job satisfaction, team collaboration, career development, and company culture. All responses are confidential.',
        15,
        'published',
        adminUserId,
        'https://surveys.google.com/engagement-2024',
        'internal'
      ]
    );
    const survey1Id = survey1Result.rows[0].id;
    await createSessions(survey1Id, 15, [0, 2, 4]); // Mon, Wed, Fri
    console.log('✅ Created Survey Opportunity 1: Employee Engagement Survey');
    
    // 6. Survey Opportunity 2: Product Feedback
    const survey2Result = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional, product_optional,
        default_duration_minutes, status, owner_user_id, external_link_optional, participant_type_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id`,
      [
        'survey',
        'Product Feedback Survey',
        'Share your experience using our latest product features',
        'We\'re continuously improving our products based on user feedback. This survey focuses on recent feature releases and your overall product experience. Your insights help shape our roadmap.',
        'Customer Portal',
        20,
        'published',
        adminUserId,
        'https://surveys.google.com/product-feedback-2024',
        'any'
      ]
    );
    const survey2Id = survey2Result.rows[0].id;
    await createSessions(survey2Id, 20, [1, 3]); // Tue, Thu
    console.log('✅ Created Survey Opportunity 2: Product Feedback Survey');
    
    console.log('\n✅ Database reset completed successfully!');
    console.log('📊 Created 6 demo opportunities:');
    console.log('   - 2 Test opportunities');
    console.log('   - 2 Poll opportunities');
    console.log('   - 2 Survey opportunities');
    console.log('   - All bookings cleared');
    console.log('   - All sessions cleared and recreated');
    
  } catch (error) {
    console.error('❌ Database reset failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run if executed directly
if (require.main === module) {
  resetDemoData()
    .then(() => {
      console.log('\n✨ All done!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Error:', error);
      process.exit(1);
    });
}

