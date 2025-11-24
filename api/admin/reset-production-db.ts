import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';
import { parseSessionCookie } from '../utils/auth';
import { createErrorResponse } from '../utils/errors';

/**
 * POST /api/admin/reset-production-db
 * Reset production database: Remove all bookings and opportunities, create fresh studies
 * Requires admin authentication
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    // Get authenticated user
    const user = parseSessionCookie(req);
    if (!user) {
      return res.status(401).json(createErrorResponse('Authentication required'));
    }

    // Check admin role - also check ADMIN_EMAILS env var as fallback
    const adminEmails = process.env.ADMIN_EMAILS?.split(',').map(e => e.trim()) || [];
    const isAdmin = user.role === 'researcher_admin' || adminEmails.includes(user.email);
    
    // Debug logging
    console.log('🔐 Admin check:', {
      userEmail: user.email,
      userRole: user.role,
      adminEmails,
      isInAdminEmails: adminEmails.includes(user.email),
      isAdmin,
    });
    
    if (!isAdmin) {
      return res.status(403).json(createErrorResponse('Forbidden: Admin access required'));
    }

    const pool = getPool();
    const client = await pool.connect();

    try {
      // If user is in ADMIN_EMAILS but doesn't have admin role, update it
      if (adminEmails.includes(user.email) && user.role !== 'researcher_admin') {
        await client.query(
          `UPDATE users SET role = 'researcher_admin' WHERE id = $1`,
          [user.id]
        );
        console.log(`✅ Updated user ${user.email} to researcher_admin role`);
      }

      await client.query('BEGIN');

      console.log('🗑️  Deleting all bookings...');
      await client.query('DELETE FROM bookings');
      console.log('✅ All bookings deleted');

      console.log('🗑️  Deleting all sessions...');
      await client.query('DELETE FROM sessions');
      console.log('✅ All sessions deleted');

      console.log('🗑️  Deleting all opportunities...');
      await client.query('DELETE FROM opportunities');
      console.log('✅ All opportunities deleted');

      // Use the authenticated admin user as owner
      const ownerUserId = user.id;
      console.log(`✅ Using admin user: ${user.email} (${ownerUserId})`);

      // Create fresh opportunities with each type
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0); // Start of day

      const opportunities = [
        {
          type: 'test',
          title: 'User Interface Testing',
          purpose_one_liner: 'Help us improve our product by testing new interface designs',
          description_optional: 'We\'re looking for participants to test our latest user interface improvements. Your feedback will help shape the future of our product.',
          default_duration_minutes: 45,
          location: 'Remote - Video Call',
        },
        {
          type: 'poll',
          title: 'Feature Preference Survey',
          purpose_one_liner: 'Quick poll to understand which features matter most to you',
          description_optional: 'A short poll to gather your preferences on upcoming features. Takes just a few minutes!',
          default_duration_minutes: 5,
          location: 'Online',
        },
        {
          type: 'survey',
          title: 'Product Experience Survey',
          purpose_one_liner: 'Share your experience using our product',
          description_optional: 'We\'d love to hear about your experience using our product. This survey helps us understand what\'s working well and what we can improve.',
          default_duration_minutes: 15,
          location: 'Online',
        },
        {
          type: 'question',
          title: 'Product Questions & Feedback',
          purpose_one_liner: 'Have questions or suggestions? We want to hear them!',
          description_optional: 'Open session for any questions, feedback, or suggestions you have about our product.',
          default_duration_minutes: 30,
          location: 'Remote - Video Call',
        },
        {
          type: 'interview',
          title: 'User Interview Session',
          purpose_one_liner: 'One-on-one interview to understand your workflow and needs',
          description_optional: 'We\'re conducting user interviews to better understand how you use our product in your daily workflow. Your insights are invaluable!',
          default_duration_minutes: 60,
          location: 'Remote - Video Call',
        },
      ];

      console.log('📝 Creating fresh opportunities...');
      let totalSessions = 0;
      
      for (const opp of opportunities) {
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
        console.log(`✅ Created ${opp.type} opportunity: ${opp.title} (${opportunityId})`);

        // Create sessions for this opportunity (multiple sessions over the next week)
        const sessions = [];
        for (let day = 0; day < 7; day++) {
          const sessionDate = new Date(tomorrow);
          sessionDate.setDate(sessionDate.getDate() + day);
          
          // Create 3 sessions per day: morning, afternoon, evening
          const timeSlots = [
            { hour: 9, minute: 0 },   // 9:00 AM
            { hour: 14, minute: 0 },  // 2:00 PM
            { hour: 17, minute: 0 },  // 5:00 PM
          ];

          for (const slot of timeSlots) {
            const startTime = new Date(sessionDate);
            startTime.setHours(slot.hour, slot.minute, 0, 0);
            
            const endTime = new Date(startTime);
            endTime.setMinutes(endTime.getMinutes() + opp.default_duration_minutes);

            sessions.push({
              opportunity_id: opportunityId,
              start_time: startTime,
              end_time: endTime,
              capacity: 5,
              booked_count: 0,
              location: opp.location,
            });
          }
        }

        // Insert all sessions for this opportunity
        for (const session of sessions) {
          await client.query(
            `INSERT INTO sessions (
              opportunity_id, start_time, end_time, capacity, booked_count,
              location_or_meet_link_optional
            ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              session.opportunity_id,
              session.start_time,
              session.end_time,
              session.capacity,
              session.booked_count,
              session.location,
            ]
          );
        }

        totalSessions += sessions.length;
        console.log(`  ✅ Created ${sessions.length} sessions for ${opp.title}`);
      }

      await client.query('COMMIT');
      console.log('\n✅ Database reset complete!');
      
      return res.status(200).json({
        success: true,
        message: 'Database reset complete',
        stats: {
          opportunitiesCreated: opportunities.length,
          sessionsCreated: totalSessions,
          opportunityTypes: opportunities.map(o => o.type),
        }
      });
      
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error('❌ Error resetting database:', error);
      return res.status(500).json(createErrorResponse(`Database reset failed: ${error.message}`));
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error('❌ Error:', error);
    return res.status(500).json(createErrorResponse(error.message || 'Internal server error'));
  }
}

