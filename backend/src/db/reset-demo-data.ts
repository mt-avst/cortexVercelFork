import { pool } from '../config';

/**
 * Clean database and add demo opportunities for all study types
 * All opportunities are themed around Atlassian Ecosystem and Forge development
 * - 1 test opportunity (Forge App Testing - requires sessions)
 * - 1 interview opportunity (requires sessions)
 * - 1 survey opportunity (external link)
 * - 1 poll opportunity (external link)
 * - 1 question opportunity (external link)
 * - 1 unmoderated opportunity (external link)
 * 
 * All opportunities have sessions scheduled dynamically starting from today for 1 month
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
    
    // Calculate dates for sessions - start from today and run for 1 month
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    
    // Helper to create sessions for an opportunity across multiple weeks
    const createSessions = async (
      opportunityId: string, 
      defaultDuration: number, 
      weekdayPattern: number[], // 0=Mon, 1=Tue, etc.
      numWeeks: number = 4
    ) => {
      const sessions = [];
      const now = new Date();
      const weekdaySet = new Set(weekdayPattern);
      const daysToCheck = numWeeks * 7; // 4 weeks = 28 days
      
      // Iterate through the next 28 days starting from today
      for (let dayOffset = 0; dayOffset < daysToCheck; dayOffset++) {
        const sessionDate = new Date(startDate);
        sessionDate.setDate(startDate.getDate() + dayOffset);
        
        // Get weekday: 0=Sun, 1=Mon, ..., 6=Sat
        const dayOfWeek = sessionDate.getDay();
        // Convert to Mon=0, Tue=1, ..., Sun=6
        const weekday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        
        // Skip if this day doesn't match the pattern
        if (!weekdaySet.has(weekday)) continue;
        
        // Create 3 sessions per day: 10am, 2pm, 3pm
        const times = [10, 14, 15];
        for (const hour of times) {
          const startTime = new Date(sessionDate);
          startTime.setHours(hour, 0, 0, 0);
          
          // Skip if this specific time is in the past
          if (startTime < now) continue;
          
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
      console.log(`   📅 Created ${sessions.length} sessions`);
      return sessions;
    };
    
    console.log('📝 Creating demo opportunities for all study types...\n');
    
    // ==========================================
    // 1. TEST (Forge App Testing) - Requires sessions
    // ==========================================
    const testResult = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional, product_optional,
        default_duration_minutes, status, owner_user_id, participant_type_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [
        'test',
        'Forge UI Kit Component Testing',
        'Help us improve the Forge UI Kit by testing new React components',
        'We\'re building new components for the Forge UI Kit and need developers to test them in real-world scenarios. You\'ll be testing React components like Button, TextField, and Dialog in a Forge app context. Your feedback on component APIs, accessibility, and developer experience directly influences the next Forge release.',
        'Forge UI Kit v3.0',
        45,
        'published',
        adminUserId,
        'any'
      ]
    );
    const testId = testResult.rows[0].id;
    await createSessions(testId, 45, [0, 1, 2, 3, 4], 4); // Mon-Fri for 4 weeks
    console.log('✅ Created TEST opportunity: Forge UI Kit Component Testing\n');
    
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
        'Forge Developer Experience Interview',
        'Share your experience building apps with Forge and help shape the platform',
        'We want to understand your journey as a Forge developer. Join us for a 1-on-1 interview where we\'ll discuss your experience building apps, using the Forge CLI, working with the UI Kit, and deploying to Atlassian Cloud. We\'re particularly interested in learning about pain points, workflow challenges, and what would make Forge development more enjoyable. Your insights directly influence our roadmap.',
        'Forge Platform',
        60,
        'published',
        adminUserId,
        'external',
        'Video call via Google Meet'
      ]
    );
    const interviewId = interviewResult.rows[0].id;
    await createSessions(interviewId, 60, [1, 3], 4); // Tue, Thu for 4 weeks
    console.log('✅ Created INTERVIEW opportunity: Forge Developer Experience Interview\n');
    
    // ==========================================
    // 3. SURVEY - External link
    // ==========================================
    //
    // Do NOT describe responses as anonymous here, or in any participant-facing
    // copy. Cortex does not provide anonymity and this description is the
    // promise a participant reads before answering: the results carry
    // `session_id`, and GET /api/opportunities/:id/session-events - open to the
    // same opportunity owner - carries that same id beside the participant's
    // name and email, so the join back to a named employee is exact. The owner
    // is entitled to both sets; the word was simply a claim we do not honour.
    // If real anonymity is ever wanted, it is a salted per-opportunity digest
    // of the session id in the results projection, not a wording change.
    const surveyResult = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional, product_optional,
        default_duration_minutes, status, owner_user_id, external_link_optional, participant_type_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id`,
      [
        'survey',
        'Atlassian Design System Usage Survey',
        'Tell us how you use the Atlassian Design System in your apps',
        'Help us understand how developers and designers are using the Atlassian Design System (ADS) in their Forge apps, Jira customizations, and Confluence macros. This survey covers component usage patterns, design token adoption, documentation quality, and what\'s missing. Your responses help us prioritize improvements to ADS.',
        'Atlassian Design System',
        15,
        'published',
        adminUserId,
        'https://forms.google.com/atlassian-design-system-survey',
        'any'
      ]
    );
    console.log('✅ Created SURVEY opportunity: Atlassian Design System Usage Survey\n');
    
    // ==========================================
    // 4. POLL - External link with simple questions
    // ==========================================
    const pollResult = await client.query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional,
        default_duration_minutes, status, owner_user_id, external_link_optional, participant_type_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [
        'poll',
        'Forge Platform Feature Priority Poll',
        'Quick vote: Which Forge feature should we prioritize?',
        `**Quick Poll - Takes 30 seconds!**

Which Forge platform feature should we prioritize next?

New UI Kit components (Button, TextField, Dialog)

Enhanced backend capabilities (more storage, better APIs)

Improved deployment workflows (faster builds, better errors)

Better documentation and examples

Confluence macro improvements

Your vote directly influences our roadmap. Click below to submit your choice!`,
        5,
        'published',
        adminUserId,
        'https://forms.google.com/forge-feature-priority-poll',
        'internal'
      ]
    );
    console.log('✅ Created POLL opportunity: Forge Platform Feature Priority Poll\n');
    
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
        'Quick Feedback: Forge CLI Experience',
        'What do you think of the new Forge CLI features?',
        'We recently updated the Forge CLI with new commands, better error messages, and improved local development workflows. What works well? What could be improved? Your candid feedback helps us iterate quickly on the developer experience.',
        5,
        'published',
        adminUserId,
        'https://forms.google.com/forge-cli-feedback',
        'any'
      ]
    );
    console.log('✅ Created QUESTION opportunity: Quick Feedback: Forge CLI Experience\n');
    
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
        'Self-Guided Confluence Macro Development Test',
        'Complete a series of tasks building a Confluence macro with Forge',
        'Test our new Confluence macro development workflow at your own pace. You\'ll be given specific tasks to build a macro using Forge, configure it, and deploy it to a test Confluence space. Your screen will be recorded while you work. This unmoderated test typically takes 20-30 minutes and can be done anytime that works for you.',
        'Forge Confluence Macros',
        25,
        'published',
        adminUserId,
        'https://usertesting.com/forge-confluence-macro-test',
        'external'
      ]
    );
    console.log('✅ Created UNMODERATED opportunity: Self-Guided Confluence Macro Development Test\n');
    
    console.log('═══════════════════════════════════════════════════════');
    console.log('✅ Database reset completed successfully!');
    console.log('═══════════════════════════════════════════════════════');
    console.log('\n📊 Created 6 demo opportunities (Atlassian/Forge themed):');
    console.log('   🔬 TEST: Forge UI Kit Component Testing');
    console.log('   🎤 INTERVIEW: Forge Developer Experience Interview');
    console.log('   📋 SURVEY: Atlassian Design System Usage Survey');
    console.log('   📊 POLL: Forge Platform Feature Priority Poll');
    console.log('   ❓ QUESTION: Quick Feedback: Forge CLI Experience');
    console.log('   🖥️  UNMODERATED: Self-Guided Confluence Macro Development Test');
    console.log('\n📅 Sessions scheduled for 1 month (starting from today)');
    console.log('   - TEST: Mon-Fri, 3 sessions/day (10am, 2pm, 3pm)');
    console.log('   - INTERVIEW: Tue & Thu, 3 sessions/day (10am, 2pm, 3pm)');
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
