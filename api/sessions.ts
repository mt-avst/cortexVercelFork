import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from './db';

/**
 * POST /api/sessions
 * Creates sessions for an opportunity
 * 
 * Request body:
 * {
 *   opportunity_id: string,
 *   sessions: Array<{
 *     start_time: string,
 *     end_time: string,
 *     capacity?: number,
 *     location_or_meet_link_optional?: string
 *   }>
 * }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('Sessions creation endpoint called:', {
      method: req.method,
      url: req.url,
      body: req.body ? (Array.isArray(req.body.sessions) ? `${req.body.sessions.length} sessions` : 'no sessions array') : 'no body'
    });

    const { opportunity_id, sessions } = req.body;
    
    if (!opportunity_id) {
      console.error('Missing opportunity_id in request body');
      return res.status(400).json({ error: 'opportunity_id is required' });
    }
    
    if (!Array.isArray(sessions) || sessions.length === 0) {
      console.error('Invalid sessions array:', sessions);
      return res.status(400).json({ error: 'sessions array is required and must not be empty' });
    }

    // Validate opportunity exists
    const oppCheck = await query(
      `SELECT id FROM opportunities WHERE id = $1`,
      [opportunity_id]
    );
    
    if (oppCheck.rows.length === 0) {
      console.error('Opportunity not found:', opportunity_id);
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    
    // Validate session data
    for (const session of sessions) {
      if (!session.start_time || !session.end_time) {
        return res.status(400).json({ 
          error: 'start_time and end_time are required for each session' 
        });
      }
    }
    
    // Insert sessions into database
    const createdSessions = [];
    for (const session of sessions) {
      try {
        const result = await query(
          `INSERT INTO sessions (
            opportunity_id,
            start_time,
            end_time,
            capacity,
            booked_count,
            location_or_meet_link_optional
          ) VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *`,
          [
            opportunity_id,
            session.start_time,
            session.end_time,
            session.capacity || 1,
            0, // booked_count starts at 0
            session.location_or_meet_link_optional || null,
          ]
        );
        
        const created = result.rows[0];
        createdSessions.push({
          ...created,
          start_time: created.start_time.toISOString(),
          end_time: created.end_time.toISOString(),
          created_at: created.created_at.toISOString(),
          updated_at: created.updated_at.toISOString(),
          remaining: created.capacity - created.booked_count,
        });
      } catch (dbError: any) {
        console.error('Database error inserting session:', dbError);
        throw dbError;
      }
    }
    
    console.log(`Successfully created ${createdSessions.length} sessions for opportunity ${opportunity_id}`);
    return res.status(201).json(createdSessions);
  } catch (error: any) {
    console.error('Error creating sessions:', error);
    console.error('Error stack:', error.stack);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message,
      code: error.code,
    });
  }
}

