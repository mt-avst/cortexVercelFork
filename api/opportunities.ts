import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from './db';
import { createErrorResponse, getErrorMessage } from './utils/errors';
import { parseSessionCookie } from './utils/auth';
import { logger } from './utils/logger';

/**
 * GET /api/opportunities
 * Returns all opportunities (with optional filters)
 * POST /api/opportunities
 * Creates a new opportunity
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === 'GET') {
      const { id, type, q, status } = req.query;
      
      // If an ID is specified, return just that opportunity
      if (id) {
        const result = await query(
          `SELECT o.*, u.name as owner_name, u.email as owner_email
           FROM opportunities o
           LEFT JOIN users u ON o.owner_user_id = u.id
           WHERE o.id = $1`,
          [id]
        );
        
        if (result.rows.length === 0) {
          return res.status(404).json(createErrorResponse('Opportunity not found'));
        }
        
        const opportunity = result.rows[0];
        
        // Load sessions with dynamic booked_count calculation
        const sessionsResult = await query(
          `SELECT s.*, 
                  COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)::int as actual_booked_count
           FROM sessions s
           LEFT JOIN bookings b ON s.id = b.session_id
           WHERE s.opportunity_id = $1
           GROUP BY s.id, s.opportunity_id, s.start_time, s.end_time, s.capacity, 
                    s.location_or_meet_link_optional, s.created_at, s.updated_at, s.booked_count
           ORDER BY s.start_time ASC`,
          [id]
        );
        opportunity.sessions = sessionsResult.rows.map(s => ({
          ...s,
          booked_count: s.actual_booked_count, // Use calculated value
          start_time: s.start_time.toISOString(),
          end_time: s.end_time.toISOString(),
          created_at: s.created_at.toISOString(),
          updated_at: s.updated_at.toISOString(),
          remaining: s.capacity - (s.actual_booked_count || 0), // Calculate from actual bookings
        }));
        
        // Convert timestamps to ISO strings
        opportunity.created_at = opportunity.created_at.toISOString();
        opportunity.updated_at = opportunity.updated_at.toISOString();
        opportunity.start_date = opportunity.start_date ? new Date(opportunity.start_date).toISOString() : null;
        opportunity.end_date = opportunity.end_date ? new Date(opportunity.end_date).toISOString() : null;
        
        return res.status(200).json(opportunity);
      }
      
      // Build query for list view with filters
      // Use LEFT JOIN to handle cases where user might not exist yet
      let sql = `
        SELECT o.*, u.name as owner_name, u.email as owner_email
        FROM opportunities o
        LEFT JOIN users u ON o.owner_user_id = u.id
        WHERE 1=1
      `;
      const params: unknown[] = [];
      let paramIndex = 1;
      
      if (type) {
        sql += ` AND o.type = $${paramIndex}`;
        params.push(type);
        paramIndex++;
      }
      
      if (q) {
        sql += ` AND (o.title ILIKE $${paramIndex} OR o.purpose_one_liner ILIKE $${paramIndex})`;
        params.push(`%${q}%`);
        paramIndex++;
      }
      
      if (status) {
        sql += ` AND o.status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }
      
      // Check if user is admin - non-admins should only see published opportunities
      const user = parseSessionCookie(req);
      const isAdmin = user?.role === 'researcher_admin' || user?.role === 'superadmin';
      
      // Filter out drafts for non-admin users (unless they specifically requested draft status)
      if (!isAdmin && (!status || status !== 'draft')) {
        sql += ` AND o.status = 'published'`;
      }
      
      sql += ` ORDER BY o.created_at DESC`;
      
      const result = await query(sql, params);
      
      // If no opportunities found, return empty array
      if (result.rows.length === 0) {
        return res.status(200).json([]);
      }

      // Performance optimization: Batch load all sessions and click counts in single queries
      // instead of N+1 queries per opportunity
      const opportunityIds = result.rows.map(opp => opp.id);
      
      // Get all sessions for all opportunities in one query
      let allSessionsMap: Map<string, any[]> = new Map();
      try {
        const sessionsResult = await query(
          `SELECT s.*, 
                  COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)::int as actual_booked_count,
                  s.opportunity_id
           FROM sessions s
           LEFT JOIN bookings b ON s.id = b.session_id
           WHERE s.opportunity_id = ANY($1::uuid[])
           GROUP BY s.id, s.opportunity_id, s.start_time, s.end_time, s.capacity, 
                    s.location_or_meet_link_optional, s.created_at, s.updated_at, s.booked_count
           ORDER BY s.opportunity_id, s.start_time ASC`,
          [opportunityIds]
        );
        
        // Group sessions by opportunity_id
        for (const session of sessionsResult.rows) {
          const oppId = session.opportunity_id;
          if (!allSessionsMap.has(oppId)) {
            allSessionsMap.set(oppId, []);
          }
          allSessionsMap.get(oppId)!.push({
            ...session,
            booked_count: session.actual_booked_count,
            start_time: session.start_time.toISOString(),
            end_time: session.end_time.toISOString(),
            created_at: session.created_at.toISOString(),
            updated_at: session.updated_at.toISOString(),
            remaining: session.capacity - (session.actual_booked_count || 0),
          });
        }
      } catch (sessionError: unknown) {
        logger.error('Error loading sessions batch', {
          error: getErrorMessage(sessionError),
        });
        // Continue with empty sessions map - opportunities will have empty sessions array
      }

      // Get all click counts for poll/survey/unmoderated opportunities in one query (only if admin)
      let clicksMap: Map<string, number> = new Map();
      if (isAdmin) {
        try {
          const pollSurveyOppIds = result.rows
            .filter(opp => opp.type === 'poll' || opp.type === 'survey' || opp.type === 'unmoderated')
            .map(opp => opp.id);
          
          if (pollSurveyOppIds.length > 0) {
            const clicksResult = await query(
              `SELECT opportunity_id, COUNT(*)::int as count 
               FROM opportunity_clicks 
               WHERE opportunity_id = ANY($1::uuid[])
               GROUP BY opportunity_id`,
              [pollSurveyOppIds]
            );
            
            // Map click counts by opportunity_id
            for (const row of clicksResult.rows) {
              const clickRow = row as { opportunity_id: string; count: string | number };
              clicksMap.set(clickRow.opportunity_id, parseInt(String(clickRow.count || '0'), 10));
            }
          }
        } catch (clickError: unknown) {
          logger.error('Error loading click counts batch', {
            error: clickError instanceof Error ? clickError.message : String(clickError),
          });
          // Continue with empty clicks map
        }
      }

      // Combine results
      const opportunities = result.rows.map((opp: any) => {
        const sessions = allSessionsMap.get(opp.id) || [];
        const clicks_total = ((opp.type === 'poll' || opp.type === 'survey' || opp.type === 'unmoderated') && isAdmin)
          ? (clicksMap.get(opp.id) ?? 0)
          : undefined;

        return {
          ...opp,
          created_at: opp.created_at.toISOString(),
          updated_at: opp.updated_at.toISOString(),
          start_date: opp.start_date ? new Date(opp.start_date).toISOString() : null,
          end_date: opp.end_date ? new Date(opp.end_date).toISOString() : null,
          owner_name: opp.owner_name || 'Unknown',
          owner_email: opp.owner_email || 'unknown@example.com',
          sessions,
          clicks_total,
        };
      });
      
      return res.status(200).json(opportunities);
    }
    
    if (req.method === 'POST') {
      const {
        type,
        title,
        purpose_one_liner,
        description_optional,
        product_optional,
        meeting_location_optional,
        default_duration_minutes = 30,
        status = 'draft',
        owner_user_id,
        external_link_optional,
        participant_type_required = 'any',
        participant_type_specific_details,
        display_width,
        start_date,
        end_date,
      } = req.body;
      
      // Validate required fields
      if (!type || !title || !purpose_one_liner) {
        return res.status(400).json(createErrorResponse('Type, title, and purpose are required'));
      }
      
      // For demo purposes, use a default owner if not provided
      // In production, this should come from the authenticated user
      const finalOwnerId = owner_user_id || '633608bc-4b0e-4d60-a498-e680ee97c252'; // Demo admin ID
      
      // Only superadmins can set display_width - default to 'single' otherwise
      const user = parseSessionCookie(req);
      const isSuperadmin = user?.role === 'superadmin';
      const finalDisplayWidth = isSuperadmin && display_width ? display_width : 'single';
      
      const result = await query(
        `INSERT INTO opportunities (
          type, title, purpose_one_liner, description_optional,
          product_optional, meeting_location_optional, default_duration_minutes, status,
          owner_user_id, external_link_optional, participant_type_required,
          participant_type_specific_details, display_width, start_date, end_date
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *`,
        [
          type,
          title.trim(),
          purpose_one_liner.trim(),
          description_optional?.trim() || null,
          product_optional?.trim() || null,
          meeting_location_optional?.trim() || null,
          default_duration_minutes,
          status,
          finalOwnerId,
          external_link_optional?.trim() || null,
          participant_type_required,
          participant_type_specific_details?.trim() || null,
          finalDisplayWidth,
          start_date || null,
          end_date || null,
        ]
      );
      
      const opportunity = result.rows[0] as any;
      
      // Get owner info
      const ownerResult = await query(
        `SELECT name, email FROM users WHERE id = $1`,
        [finalOwnerId]
      );
      
      const ownerRow = ownerResult.rows[0] as { name?: string; email?: string } | undefined;
      
      const opportunityWithOwner = {
        ...opportunity,
        owner_name: ownerRow?.name || 'Unknown',
        owner_email: ownerRow?.email || 'unknown@example.com',
        sessions: [],
        created_at: opportunity.created_at.toISOString(),
        updated_at: opportunity.updated_at.toISOString(),
        start_date: opportunity.start_date ? new Date(opportunity.start_date).toISOString() : null,
        end_date: opportunity.end_date ? new Date(opportunity.end_date).toISOString() : null,
      };
      
      return res.status(201).json(opportunityWithOwner);
    }
    
    return res.status(405).json(createErrorResponse('Method not allowed'));
  } catch (error: unknown) {
    logger.error('Error in opportunities handler', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    const errorMessage = getErrorMessage(error);
    return res.status(500).json(
      createErrorResponse('Internal server error', errorMessage)
    );
  }
}

