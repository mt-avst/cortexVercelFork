import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../../db';

/**
 * GET /api/opportunities/[id]/sessions
 * Gets sessions for an opportunity
 * POST /api/opportunities/[id]/sessions
 * Creates sessions for an opportunity
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Try to get ID from query params first (Vercel dynamic routes)
    let opportunityId = req.query.id as string;
    
    // If not in query, try to parse from URL path
    if (!opportunityId && req.url) {
      const urlMatch = req.url.match(/\/opportunities\/([^\/]+)\/sessions/);
      if (urlMatch) {
        opportunityId = urlMatch[1];
      }
    }
    
    console.log('Sessions endpoint called:', {
      method: req.method,
      url: req.url,
      path: (req as any).path,
      query: req.query,
      opportunityId,
      body: req.body ? (Array.isArray(req.body) ? `${req.body.length} items` : 'single item') : 'no body',
      headers: { host: req.headers.host }
    });
    
    if (!opportunityId) {
      console.error('Opportunity ID not found in query or URL');
      return res.status(400).json({ error: 'Opportunity ID is required' });
    }

    if (req.method === 'GET') {
      console.log('Getting sessions for opportunity:', opportunityId);
      
      // Check if opportunity exists
      const oppCheck = await query(
        `SELECT id FROM opportunities WHERE id = $1`,
        [opportunityId]
      );
      
      if (oppCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      
      // Get sessions from database
      const { include_past } = req.query;
      let sql = `
        SELECT * FROM sessions 
        WHERE opportunity_id = $1
      `;
      const params: any[] = [opportunityId];
      
      if (include_past === 'false' || include_past === false) {
        sql += ` AND end_time > NOW()`;
      }
      
      sql += ` ORDER BY start_time ASC`;
      
      const result = await query(sql, params);
      
      const sessions = result.rows.map(s => ({
        ...s,
        start_time: s.start_time.toISOString(),
        end_time: s.end_time.toISOString(),
        created_at: s.created_at.toISOString(),
        updated_at: s.updated_at.toISOString(),
        remaining: s.capacity - s.booked_count,
      }));
      
      console.log(`Found ${sessions.length} sessions for opportunity ${opportunityId}`);
      return res.status(200).json(sessions);
    }
    
    if (req.method === 'POST') {
      console.log('Creating sessions for opportunity:', opportunityId);
      
      // Check if opportunity exists
      const oppCheck = await query(
        `SELECT id FROM opportunities WHERE id = $1`,
        [opportunityId]
      );
      
      if (oppCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      
      const sessionData = Array.isArray(req.body) ? req.body : [req.body];
      
      if (sessionData.length === 0) {
        return res.status(400).json({ error: 'At least one session is required' });
      }
      
      // Validate session data
      for (const session of sessionData) {
        if (!session.start_time || !session.end_time) {
          return res.status(400).json({ error: 'start_time and end_time are required for each session' });
        }
      }
      
      // Insert sessions into database
      const createdSessions = [];
      for (const session of sessionData) {
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
            opportunityId,
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
      }
      
      console.log(`Created ${createdSessions.length} sessions for opportunity ${opportunityId}`);
      return res.status(201).json(createdSessions);
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Error in sessions handler:', error);
    console.error('Error stack:', error.stack);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message,
      code: error.code,
    });
  }
}

