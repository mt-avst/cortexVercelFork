import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from './db';
import { createErrorResponse, getErrorMessage } from './utils/errors';

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
        
        // Load sessions for this opportunity
        const sessionsResult = await query(
          `SELECT * FROM sessions WHERE opportunity_id = $1 ORDER BY start_time ASC`,
          [id]
        );
        opportunity.sessions = sessionsResult.rows.map(s => ({
          ...s,
          start_time: s.start_time.toISOString(),
          end_time: s.end_time.toISOString(),
          created_at: s.created_at.toISOString(),
          updated_at: s.updated_at.toISOString(),
          remaining: s.capacity - s.booked_count, // Add remaining field
        }));
        
        // Convert timestamps to ISO strings
        opportunity.created_at = opportunity.created_at.toISOString();
        opportunity.updated_at = opportunity.updated_at.toISOString();
        
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
      const params: any[] = [];
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
      
      sql += ` ORDER BY o.created_at DESC`;
      
      const result = await query(sql, params);
      
      // If no opportunities found, return empty array
      if (result.rows.length === 0) {
        return res.status(200).json([]);
      }
      
      // Load sessions for each opportunity
      const opportunities = await Promise.all(
        result.rows.map(async (opp) => {
          try {
            const sessionsResult = await query(
              `SELECT * FROM sessions WHERE opportunity_id = $1 ORDER BY start_time ASC`,
              [opp.id]
            );
            
            return {
              ...opp,
              created_at: opp.created_at.toISOString(),
              updated_at: opp.updated_at.toISOString(),
              owner_name: opp.owner_name || 'Unknown',
              owner_email: opp.owner_email || 'unknown@example.com',
              sessions: sessionsResult.rows.map(s => ({
                ...s,
                start_time: s.start_time.toISOString(),
                end_time: s.end_time.toISOString(),
                created_at: s.created_at.toISOString(),
                updated_at: s.updated_at.toISOString(),
                remaining: s.capacity - s.booked_count, // Add remaining field
              })),
            };
          } catch (sessionError: unknown) {
            console.error('Error loading sessions for opportunity', opp.id, ':', getErrorMessage(sessionError));
            // Return opportunity without sessions if session query fails
            return {
              ...opp,
              created_at: opp.created_at.toISOString(),
              updated_at: opp.updated_at.toISOString(),
              owner_name: opp.owner_name || 'Unknown',
              owner_email: opp.owner_email || 'unknown@example.com',
              sessions: [],
            };
          }
        })
      );
      
      return res.status(200).json(opportunities);
    }
    
    if (req.method === 'POST') {
      const {
        type,
        title,
        purpose_one_liner,
        description_optional,
        product_optional,
        default_duration_minutes = 30,
        status = 'draft',
        owner_user_id,
        external_link_optional,
        participant_type_required = 'any',
        participant_type_specific_details,
      } = req.body;
      
      // Validate required fields
      if (!type || !title || !purpose_one_liner) {
        return res.status(400).json(createErrorResponse('Type, title, and purpose are required'));
      }
      
      // For demo purposes, use a default owner if not provided
      // In production, this should come from the authenticated user
      const finalOwnerId = owner_user_id || '633608bc-4b0e-4d60-a498-e680ee97c252'; // Demo admin ID
      
      const result = await query(
        `INSERT INTO opportunities (
          type, title, purpose_one_liner, description_optional,
          product_optional, default_duration_minutes, status,
          owner_user_id, external_link_optional, participant_type_required,
          participant_type_specific_details
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *`,
        [
          type,
          title.trim(),
          purpose_one_liner.trim(),
          description_optional?.trim() || null,
          product_optional?.trim() || null,
          default_duration_minutes,
          status,
          finalOwnerId,
          external_link_optional?.trim() || null,
          participant_type_required,
          participant_type_specific_details?.trim() || null,
        ]
      );
      
      const opportunity = result.rows[0];
      
      // Get owner info
      const ownerResult = await query(
        `SELECT name, email FROM users WHERE id = $1`,
        [finalOwnerId]
      );
      
      const opportunityWithOwner = {
        ...opportunity,
        owner_name: ownerResult.rows[0]?.name || 'Unknown',
        owner_email: ownerResult.rows[0]?.email || 'unknown@example.com',
        sessions: [],
        created_at: opportunity.created_at.toISOString(),
        updated_at: opportunity.updated_at.toISOString(),
      };
      
      return res.status(201).json(opportunityWithOwner);
    }
    
    return res.status(405).json(createErrorResponse('Method not allowed'));
  } catch (error: unknown) {
    console.error('Error in opportunities handler:', error);
    const errorMessage = getErrorMessage(error);
    return res.status(500).json(
      createErrorResponse('Internal server error', errorMessage)
    );
  }
}

