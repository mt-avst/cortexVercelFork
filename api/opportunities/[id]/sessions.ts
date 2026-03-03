import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../../db';
import { createErrorResponse, createSafeErrorResponse } from '../../utils/errors';
import { logger } from '../../utils/logger';

// Type for session row from database
interface SessionRow {
  id: string;
  opportunity_id: string;
  start_time: Date;
  end_time: Date;
  capacity: number;
  booked_count: number;
  created_at: Date;
  updated_at: Date;
  location_or_meet_link_optional?: string;
}

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
    
    if (!opportunityId) {
      logger.error('Opportunity ID not found in query or URL');
      return res.status(400).json(createErrorResponse('Opportunity ID is required'));
    }

    if (req.method === 'GET') {
      // Check if opportunity exists
      const oppCheck = await query(
        `SELECT id FROM opportunities WHERE id = $1`,
        [opportunityId]
      );
      
      if (oppCheck.rows.length === 0) {
        return res.status(404).json(createErrorResponse('Opportunity not found'));
      }
      
      // Get sessions from database
            const { include_past } = req.query;
            let sql = `
              SELECT * FROM sessions 
              WHERE opportunity_id = $1
            `;
            const params: unknown[] = [opportunityId];
            
            // Handle query param (can be string, string[], or undefined)
            const includePast = Array.isArray(include_past) ? include_past[0] : include_past;
            // Check if we should exclude past sessions (only if explicitly set to 'false')
            if (includePast === 'false') {
              sql += ` AND end_time > NOW()`;
            }
      
      sql += ` ORDER BY start_time ASC`;
      
      const result = await query(sql, params);
      
      const sessions = result.rows.map((row) => {
        const s = row as SessionRow;
        return {
          ...s,
          start_time: s.start_time.toISOString(),
          end_time: s.end_time.toISOString(),
          created_at: s.created_at.toISOString(),
          updated_at: s.updated_at.toISOString(),
          remaining: s.capacity - s.booked_count,
        };
      });
      
      return res.status(200).json(sessions);
    }
    
    if (req.method === 'POST') {
      // Check if opportunity exists
      const oppCheck = await query(
        `SELECT id FROM opportunities WHERE id = $1`,
        [opportunityId]
      );
      
      if (oppCheck.rows.length === 0) {
        return res.status(404).json(createErrorResponse('Opportunity not found'));
      }
      
      const sessionData = Array.isArray(req.body) ? req.body : [req.body];
      
      if (sessionData.length === 0) {
        return res.status(400).json(createErrorResponse('At least one session is required'));
      }
      
      // Validate session data
      for (const session of sessionData) {
        if (!session.start_time || !session.end_time) {
          return res.status(400).json(createErrorResponse('start_time and end_time are required for each session'));
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
        
        const created = result.rows[0] as SessionRow;
        createdSessions.push({
          ...created,
          start_time: created.start_time.toISOString(),
          end_time: created.end_time.toISOString(),
          created_at: created.created_at.toISOString(),
          updated_at: created.updated_at.toISOString(),
          remaining: created.capacity - created.booked_count,
        });
      }
      
      return res.status(201).json(createdSessions);
    }
    
    return res.status(405).json(createErrorResponse('Method not allowed'));
  } catch (error: unknown) {
    logger.error('Error in sessions handler', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Internal server error' })
    );
  }
}

