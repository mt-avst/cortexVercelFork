import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { createErrorResponse, getErrorMessage } from '../utils/errors';
import { parseSessionCookie } from '../utils/auth';

/**
 * POST /api/admin/reset-demo-data
 * Reset database with fresh demo opportunities (Admin only)
 * Clears all bookings, sessions, and opportunities, then creates 6 new demo opportunities WITHOUT sessions
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

    // Check authentication and admin role
    const user = parseSessionCookie(req);
    if (!user) {
      return res.status(401).json(createErrorResponse('Authentication required'));
    }

    if (user.role !== 'researcher_admin') {
      return res.status(403).json(createErrorResponse('Admin access required'));
    }

    console.log('🧹 Starting database reset by admin:', user.email);

    // Ensure meeting_location_optional column exists (for backward compatibility)
    let hasMeetingLocationColumn = false;
    try {
      const columnCheck = await query(`
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'opportunities' 
        AND column_name = 'meeting_location_optional'
      `);
      hasMeetingLocationColumn = columnCheck.rows.length > 0;
      
      if (!hasMeetingLocationColumn) {
        await query(`
          ALTER TABLE opportunities ADD COLUMN meeting_location_optional TEXT
        `);
        console.log('✅ Added meeting_location_optional column to opportunities table');
        hasMeetingLocationColumn = true;
      } else {
        console.log('✅ meeting_location_optional column already exists');
      }
    } catch (migrationError: any) {
      console.warn('⚠️ Could not add meeting_location_optional column:', migrationError.message);
      // Continue anyway - will try to use column in inserts
      hasMeetingLocationColumn = false;
    }

    // NOTE: Session creation function removed - we are NOT creating any sessions
    // All opportunities will be created without sessions to clear all timeslot availability

    // Verify current state before reset
    const beforeBookings = await query('SELECT COUNT(*)::int as count FROM bookings');
    const beforeSessions = await query('SELECT COUNT(*)::int as count FROM sessions');
    const beforeOpportunities = await query('SELECT COUNT(*)::int as count FROM opportunities');
    console.log(`📊 Before reset: ${beforeBookings.rows[0]?.count || 0} bookings, ${beforeSessions.rows[0]?.count || 0} sessions, ${beforeOpportunities.rows[0]?.count || 0} opportunities`);

    // Delete all bookings first (to ensure foreign key constraints are satisfied)
    await query('DELETE FROM bookings');
    console.log('✅ Deleted all bookings');

    // Clear any Google Calendar event IDs from bookings (cleanup - should be empty but safe)
    await query('UPDATE bookings SET gcal_event_id = NULL WHERE gcal_event_id IS NOT NULL').catch(() => {
      // Ignore error if bookings table is already empty
    });

    // Delete ALL sessions first (to ensure foreign key constraints are satisfied)
    // This must happen before deleting opportunities
    // Use CASCADE or explicit delete of all related data
    await query('DELETE FROM sessions');
    console.log('✅ Deleted all sessions');

    // Delete all opportunities (after sessions are deleted)
    await query('DELETE FROM opportunities');
    console.log('✅ Deleted all opportunities');
    
    // TRIPLE-CHECK: Ensure NO sessions remain (in case of any race conditions, foreign key issues, or orphaned sessions)
    let remainingSessionsCheck = await query('SELECT COUNT(*)::int as count FROM sessions');
    let retryCount = 0;
    while ((remainingSessionsCheck.rows[0]?.count || 0) > 0 && retryCount < 3) {
      console.warn(`⚠️  WARNING: ${remainingSessionsCheck.rows[0]?.count} sessions still exist after delete! Force deleting (attempt ${retryCount + 1})...`);
      await query('DELETE FROM sessions'); // Force delete again
      // Small delay to allow database to process
      await new Promise(resolve => setTimeout(resolve, 100));
      remainingSessionsCheck = await query('SELECT COUNT(*)::int as count FROM sessions');
      retryCount++;
    }
    if ((remainingSessionsCheck.rows[0]?.count || 0) > 0) {
      console.error(`❌ ERROR: ${remainingSessionsCheck.rows[0]?.count} sessions STILL exist after ${retryCount} retry attempts!`);
    } else {
      console.log('✅ Confirmed: All sessions deleted');
    }
    
    // Ensure all sessions have booked_count = 0 (double-check - should be empty but just in case)
    // This is a no-op if sessions table is already empty, but safe to run
    await query('UPDATE sessions SET booked_count = 0').catch(() => {
      // Ignore error if sessions table is already empty
    });

    // Verify cleanup completed - CRITICAL: Must be zero before creating new opportunities
    const afterBookings = await query('SELECT COUNT(*)::int as count FROM bookings');
    const afterSessions = await query('SELECT COUNT(*)::int as count FROM sessions');
    const afterOpportunities = await query('SELECT COUNT(*)::int as count FROM opportunities');
    console.log(`📊 After cleanup: ${afterBookings.rows[0]?.count || 0} bookings, ${afterSessions.rows[0]?.count || 0} sessions, ${afterOpportunities.rows[0]?.count || 0} opportunities`);
    
    // ENFORCE: Do not proceed if any data remains
    if ((afterSessions.rows[0]?.count || 0) > 0) {
      const errorMsg = `FATAL: ${afterSessions.rows[0]?.count} sessions still exist after cleanup! Cannot proceed.`;
      console.error(errorMsg);
      return res.status(500).json(createErrorResponse(errorMsg));
    }
    
    if ((afterBookings.rows[0]?.count || 0) > 0 || (afterOpportunities.rows[0]?.count || 0) > 0) {
      console.warn('⚠️  WARNING: Some data still exists after cleanup! This may indicate a database constraint issue.');
    }

    const userId = user.id;

    // Helper to build INSERT statement with optional meeting_location_optional
    const buildOpportunityInsert = (baseFields: string[], baseValues: any[], meetingLocation?: string) => {
      const fields = hasMeetingLocationColumn && meetingLocation
        ? [...baseFields, 'meeting_location_optional']
        : baseFields;
      const values = hasMeetingLocationColumn && meetingLocation
        ? [...baseValues, meetingLocation]
        : baseValues;
      const params = values.map((_, i) => `$${i + 1}`).join(', ');
      return {
        sql: `INSERT INTO opportunities (${fields.join(', ')}) VALUES (${params}) RETURNING id`,
        values
      };
    };

    // 1. Test Opportunity 1: User Interface Testing
    const test1Insert = buildOpportunityInsert(
      ['type', 'title', 'purpose_one_liner', 'description_optional', 'product_optional', 'default_duration_minutes', 'status', 'owner_user_id', 'participant_type_required'],
      ['test', 'User Interface Testing', 'Help us improve our mobile app interface through usability testing', 'We are looking for users to test our new mobile app interface. This will involve completing various tasks while we observe your interactions and gather feedback on the design and usability.', 'Mobile Banking App', 45, 'published', userId, 'any'],
      'https://zoom.us/j/1234567890'
    );
    const test1Result = await query(test1Insert.sql, test1Insert.values);
    const test1Id = test1Result.rows[0].id;
    // NO SESSIONS CREATED - all slots cleared
    console.log('✅ Created Test Opportunity 1: User Interface Testing (no sessions)');

    // 2. Test Opportunity 2: New Feature Validation
    const test2Insert = buildOpportunityInsert(
      ['type', 'title', 'purpose_one_liner', 'description_optional', 'product_optional', 'default_duration_minutes', 'status', 'owner_user_id', 'participant_type_required'],
      ['test', 'New Feature Validation', 'Test our latest dashboard features and provide feedback', 'We\'ve built some exciting new features for our analytics dashboard and need your help to validate them. Share your thoughts on functionality, design, and overall experience.', 'Analytics Dashboard', 30, 'published', userId, 'internal'],
      'https://meet.google.com/abc-defg-hij'
    );
    const test2Result = await query(test2Insert.sql, test2Insert.values);
    const test2Id = test2Result.rows[0].id;
    // NO SESSIONS CREATED - all slots cleared
    console.log('✅ Created Test Opportunity 2: New Feature Validation (no sessions)');

    // 3. Poll Opportunity 1: Work-Life Balance
    const poll1Insert = buildOpportunityInsert(
      ['type', 'title', 'purpose_one_liner', 'description_optional', 'default_duration_minutes', 'status', 'owner_user_id', 'external_link_optional', 'participant_type_required'],
      ['poll', 'Work-Life Balance Survey', 'Share your thoughts on work-life balance at AdaptaLabs', 'We want to understand how our team members are managing work-life balance. Your anonymous input will help us improve our workplace policies and support programs.', 5, 'published', userId, 'https://forms.google.com/work-life-balance-poll', 'internal'],
      'https://zoom.us/j/2345678901'
    );
    const poll1Result = await query(poll1Insert.sql, poll1Insert.values);
    const poll1Id = poll1Result.rows[0].id;
    // NO SESSIONS CREATED - all slots cleared
    console.log('✅ Created Poll Opportunity 1: Work-Life Balance Survey (no sessions)');

    // 4. Poll Opportunity 2: Remote Work Preferences
    const poll2Insert = buildOpportunityInsert(
      ['type', 'title', 'purpose_one_liner', 'description_optional', 'default_duration_minutes', 'status', 'owner_user_id', 'external_link_optional', 'participant_type_required'],
      ['poll', 'Remote Work Preferences', 'Tell us about your remote work preferences and experiences', 'Help us understand your preferences for remote, hybrid, and in-office work arrangements. This quick poll will inform our future office and remote work policies.', 5, 'published', userId, 'https://forms.google.com/remote-work-poll', 'any'],
      'https://meet.google.com/bcd-efgh-ijk'
    );
    const poll2Result = await query(poll2Insert.sql, poll2Insert.values);
    const poll2Id = poll2Result.rows[0].id;
    // NO SESSIONS CREATED - all slots cleared
    console.log('✅ Created Poll Opportunity 2: Remote Work Preferences (no sessions)');

    // 5. Survey Opportunity 1: Employee Engagement
    const survey1Insert = buildOpportunityInsert(
      ['type', 'title', 'purpose_one_liner', 'description_optional', 'default_duration_minutes', 'status', 'owner_user_id', 'external_link_optional', 'participant_type_required'],
      ['survey', 'Employee Engagement Survey', 'Help us understand engagement levels across the organization', 'Your feedback is crucial in helping us create a better workplace. This comprehensive survey covers topics like job satisfaction, team collaboration, career development, and company culture. All responses are confidential.', 15, 'published', userId, 'https://surveys.google.com/engagement-2024', 'internal'],
      'https://zoom.us/j/3456789012'
    );
    const survey1Result = await query(survey1Insert.sql, survey1Insert.values);
    const survey1Id = survey1Result.rows[0].id;
    // NO SESSIONS CREATED - all slots cleared
    console.log('✅ Created Survey Opportunity 1: Employee Engagement Survey (no sessions)');

    // 6. Survey Opportunity 2: Product Feedback
    const survey2Insert = buildOpportunityInsert(
      ['type', 'title', 'purpose_one_liner', 'description_optional', 'product_optional', 'default_duration_minutes', 'status', 'owner_user_id', 'external_link_optional', 'participant_type_required'],
      ['survey', 'Product Feedback Survey', 'Share your experience using our latest product features', 'We\'re continuously improving our products based on user feedback. This survey focuses on recent feature releases and your overall product experience. Your insights help shape our roadmap.', 'Customer Portal', 20, 'published', userId, 'https://surveys.google.com/product-feedback-2024', 'any'],
      'https://meet.google.com/cde-fghi-jkl'
    );
    const survey2Result = await query(survey2Insert.sql, survey2Insert.values);
    const survey2Id = survey2Result.rows[0].id;
    // NO SESSIONS CREATED - all slots cleared
    console.log('✅ Created Survey Opportunity 2: Product Feedback Survey (no sessions)');

    return res.status(200).json({
      success: true,
      message: 'Database reset completed successfully',
      created: {
        test: 2,
        poll: 2,
        survey: 2,
        total: 6
      }
    });
  } catch (error: unknown) {
    console.error('Error resetting database:', error);
    return res.status(500).json(createErrorResponse('Failed to reset database', getErrorMessage(error)));
  }
}

