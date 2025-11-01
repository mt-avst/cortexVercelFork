import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { createErrorResponse, getErrorMessage } from '../utils/errors';
import { parseSessionCookie } from '../utils/auth';

/**
 * POST /api/admin/reset-demo-data
 * Reset database with fresh demo opportunities (Admin only)
 * Clears all bookings, sessions, and opportunities, then creates 6 new demo opportunities
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

    // Helper function to create sessions
    const createSessions = async (opportunityId: string, defaultDuration: number, days: number[]) => {
      const today = new Date();
      const nextMonday = new Date(today);
      nextMonday.setDate(today.getDate() + (8 - today.getDay()) % 7 || 7);
      nextMonday.setHours(0, 0, 0, 0);

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
          
          const result = await query(
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

    // Delete all bookings
    await query('DELETE FROM bookings');
    console.log('✅ Deleted all bookings');

    // Delete all sessions
    await query('DELETE FROM sessions');
    console.log('✅ Deleted all sessions');

    // Delete all opportunities
    await query('DELETE FROM opportunities');
    console.log('✅ Deleted all opportunities');

    const userId = user.id;

    // 1. Test Opportunity 1: User Interface Testing
    const test1Result = await query(
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
        userId,
        'any'
      ]
    );
    const test1Id = test1Result.rows[0].id;
    await createSessions(test1Id, 45, [0, 1, 2, 3, 4]); // Mon-Fri

    // 2. Test Opportunity 2: New Feature Validation
    const test2Result = await query(
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
        userId,
        'internal'
      ]
    );
    const test2Id = test2Result.rows[0].id;
    await createSessions(test2Id, 30, [0, 2, 4]); // Mon, Wed, Fri

    // 3. Poll Opportunity 1: Work-Life Balance
    const poll1Result = await query(
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
        userId,
        'https://forms.google.com/work-life-balance-poll',
        'internal'
      ]
    );
    const poll1Id = poll1Result.rows[0].id;
    await createSessions(poll1Id, 5, [0, 1, 2, 3, 4]);

    // 4. Poll Opportunity 2: Remote Work Preferences
    const poll2Result = await query(
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
        userId,
        'https://forms.google.com/remote-work-poll',
        'any'
      ]
    );
    const poll2Id = poll2Result.rows[0].id;
    await createSessions(poll2Id, 5, [1, 3]); // Tue, Thu

    // 5. Survey Opportunity 1: Employee Engagement
    const survey1Result = await query(
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
        userId,
        'https://surveys.google.com/engagement-2024',
        'internal'
      ]
    );
    const survey1Id = survey1Result.rows[0].id;
    await createSessions(survey1Id, 15, [0, 2, 4]); // Mon, Wed, Fri

    // 6. Survey Opportunity 2: Product Feedback
    const survey2Result = await query(
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
        userId,
        'https://surveys.google.com/product-feedback-2024',
        'any'
      ]
    );
    const survey2Id = survey2Result.rows[0].id;
    await createSessions(survey2Id, 20, [1, 3]); // Tue, Thu

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

