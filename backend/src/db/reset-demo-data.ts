import { pool } from '../config';

/**
 * Clean database and add demo opportunities for all study types
 * - 1 test opportunity (App Testing - requires sessions)
 * - 1 interview opportunity (requires sessions)
 * - 1 survey opportunity (external link)
 * - 1 poll opportunity (external link)
 * - 1 question opportunity (external link)
 * - 1 unmoderated opportunity (external link)
 * 
 * All opportunities have sessions scheduled dynamically from today
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
    
    // Calculate dates for sessions - start from tomorrow and go through December
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    // Helper to create sessions for an opportunity across multiple weeks
    const createSessions = async (
      opportunityId: string, 
      defaultDuration: number, 
      weekdayPattern: number[], // 0=Mon, 1=Tue, etc.
      numWeeks: number = 4
    ) => {
      const sessions = [];
      
      // Find the next occurrence of the first day in pattern
      const startDate = new Date(tomorrow);
      
      for (let week = 0; week < numWeeks; week++) {
        for (const dayOffset of weekdayPattern) {
          const sessionDate = new Date(startDate);
          // Add weeks and calculate the specific weekday
          sessionDate.setDate(startDate.getDate() + (week * 7) + dayOffset);
          
          // Skip if the date is in the past
          if (sessionDate < today) continue;
          
          // Create 3 sessions per day: 10am, 2pm, 3pm
          const times = [10, 14, 15];
          for (const hour of times) {
            const startTime = new Date(sessionDate);
            startTime.setHours(hour, 0, 0, 0);
            
            // Skip if this specific time is in the past
            if (startTime < today) continue;
            
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
      }
      console.log(`   📅 Created ${sessions.length} sessions`);
      return sessions;
    };
    
    console.log('📝 Creating demo opportunities for all study types...\n');
    
    // ==========================================
    // 1. TEST (App Testing) - Requires sessions
    // ==========================================
    const testResult = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional, product_optional,
        default_duration_minutes, status, owner_user_id, participant_type_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [
        'test',
        'Mobile App Usability Testing',
        'Help us improve our mobile banking app through hands-on testing',
        'We are looking for users to test our new mobile app interface. This will involve completing various tasks while we observe your interactions and gather feedback on the design and usability. Your feedback directly shapes our product roadmap.',
        'Mobile Banking App v3.0',
        45,
        'published',
        adminUserId,
        'any'
      ]
    );
    const testId = testResult.rows[0].id;
    await createSessions(testId, 45, [0, 1, 2, 3, 4], 4); // Mon-Fri for 4 weeks
    console.log('✅ Created TEST opportunity: Mobile App Usability Testing\n');
    
    // ==========================================
    // 2. INTERVIEW - Requires sessions
    // ==========================================
    const interviewResult = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional, product_optional,
        default_duration_minutes, status, owner_user_id, participant_type_required,
        meeting_location_optional
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id`,
      [
        'interview',
        'Customer Journey Research Interview',
        'Share your experiences and help us understand customer needs',
        'Join us for a 1-on-1 interview where we\'ll discuss your experience with our products and services. We want to understand your workflow, pain points, and what features would make your life easier. All feedback is confidential and used to improve our offerings.',
        'Enterprise Platform',
        60,
        'published',
        adminUserId,
        'external',
        'Video call via Google Meet'
      ]
    );
    const interviewId = interviewResult.rows[0].id;
    await createSessions(interviewId, 60, [1, 3], 4); // Tue, Thu for 4 weeks
    console.log('✅ Created INTERVIEW opportunity: Customer Journey Research Interview\n');
    
    // ==========================================
    // 3. SURVEY - External link
    // ==========================================
    const surveyResult = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional, product_optional,
        default_duration_minutes, status, owner_user_id, external_link_optional, participant_type_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id`,
      [
        'survey',
        'Annual Product Satisfaction Survey',
        'Share your feedback on our products and services',
        'Help us understand how well our products meet your needs. This comprehensive survey covers feature satisfaction, support quality, and future priorities. Your responses are anonymous and directly influence our 2025 roadmap.',
        'All Products',
        15,
        'published',
        adminUserId,
        'https://forms.google.com/product-satisfaction-2024',
        'any'
      ]
    );
    console.log('✅ Created SURVEY opportunity: Annual Product Satisfaction Survey\n');
    
    // ==========================================
    // 4. POLL - External link
    // ==========================================
    const pollResult = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional,
        default_duration_minutes, status, owner_user_id, external_link_optional, participant_type_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [
        'poll',
        'Feature Priority Poll',
        'Vote on which features we should build next',
        'We have several exciting features in our backlog and want YOUR input on what to prioritize. This quick poll takes less than 5 minutes and helps us focus on what matters most to you.',
        5,
        'published',
        adminUserId,
        'https://forms.google.com/feature-priority-poll',
        'internal'
      ]
    );
    console.log('✅ Created POLL opportunity: Feature Priority Poll\n');
    
    // ==========================================
    // 5. QUESTION - External link
    // ==========================================
    const questionResult = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional,
        default_duration_minutes, status, owner_user_id, external_link_optional, participant_type_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [
        'question',
        'Quick Feedback: Dashboard Redesign',
        'What do you think of our new dashboard design?',
        'We recently redesigned our main dashboard and would love to hear your thoughts. What works well? What could be improved? Your candid feedback helps us iterate quickly.',
        5,
        'published',
        adminUserId,
        'https://forms.google.com/dashboard-feedback',
        'any'
      ]
    );
    console.log('✅ Created QUESTION opportunity: Quick Feedback: Dashboard Redesign\n');
    
    // ==========================================
    // 6. UNMODERATED - External link
    // ==========================================
    const unmoderatedResult = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional, product_optional,
        default_duration_minutes, status, owner_user_id, external_link_optional, participant_type_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id`,
      [
        'unmoderated',
        'Self-Guided Checkout Flow Test',
        'Complete a series of tasks on our new checkout experience',
        'Test our redesigned checkout flow at your own pace. You\'ll be given specific tasks to complete while your screen is recorded. This unmoderated test typically takes 15-20 minutes and can be done anytime that works for you.',
        'E-commerce Platform',
        20,
        'published',
        adminUserId,
        'https://usertesting.com/checkout-flow-test',
        'external'
      ]
    );
    console.log('✅ Created UNMODERATED opportunity: Self-Guided Checkout Flow Test\n');
    
    console.log('═══════════════════════════════════════════════════════');
    console.log('✅ Database reset completed successfully!');
    console.log('═══════════════════════════════════════════════════════');
    console.log('\n📊 Created 6 demo opportunities (one of each type):');
    console.log('   🔬 TEST: Mobile App Usability Testing');
    console.log('   🎤 INTERVIEW: Customer Journey Research Interview');
    console.log('   📋 SURVEY: Annual Product Satisfaction Survey');
    console.log('   📊 POLL: Feature Priority Poll');
    console.log('   ❓ QUESTION: Quick Feedback: Dashboard Redesign');
    console.log('   🖥️  UNMODERATED: Self-Guided Checkout Flow Test');
    console.log('\n📅 Sessions scheduled for the next 4 weeks (starting from today)');
    console.log('   - TEST: Mon-Fri, 3 sessions/day');
    console.log('   - INTERVIEW: Tue & Thu, 3 sessions/day');
    console.log('   - Other types: External links (no sessions needed)');
    
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
