import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { createErrorResponse, getErrorMessage } from '../utils/errors';
import { parseSessionCookie } from '../utils/auth';
import { logger } from '../utils/logger';

/**
 * GET /api/opportunities/[id]
 * Get opportunity detail
 * PATCH /api/opportunities/[id]
 * Updates an existing opportunity
 * DELETE /api/opportunities/[id]
 * Deletes an opportunity
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Get ID from query params (Vercel dynamic routes)
    let opportunityId: string | undefined;
    
    // First try query.id (Vercel dynamic route parameter)
    if (req.query.id) {
      if (Array.isArray(req.query.id)) {
        opportunityId = req.query.id[0];
      } else {
        opportunityId = req.query.id as string;
      }
    }
    
    // Fallback: try to parse from URL path
    if (!opportunityId && req.url) {
      const urlMatch = req.url.match(/\/opportunities\/([^\/\?]+)/);
      if (urlMatch && urlMatch[1]) {
        opportunityId = urlMatch[1];
      }
    }
    
    // Validate ID format (UUID should be 36 chars with hyphens)
    if (!opportunityId || opportunityId.length < 10) {
      logger.error('Invalid opportunity ID', { 
        id: opportunityId, 
        query: req.query,
        url: req.url 
      });
      return res.status(400).json(createErrorResponse('Valid opportunity ID is required'));
    }

    if (req.method === 'GET') {
      // Get opportunity detail
      const user = parseSessionCookie(req);
      const isAdmin = user?.role === 'researcher_admin' || user?.role === 'superadmin';

      // Get opportunity
      let opportunityResult;
      try {
        opportunityResult = await query(
          `SELECT * FROM opportunities WHERE id = $1`,
          [opportunityId]
        );
      } catch (queryError: unknown) {
        const error = queryError as { code?: string; message?: string };
        logger.error('Error querying opportunity', {
          error: error.message || String(queryError),
          errorCode: error.code,
          opportunityId
        });
        return res.status(500).json(
          createErrorResponse('Failed to load opportunity', error.message || 'Database error')
        );
      }

      if (opportunityResult.rows.length === 0) {
        return res.status(404).json(createErrorResponse('Opportunity not found'));
      }

      const opportunity = opportunityResult.rows[0];

      // Only show published opportunities to non-admins
      // Admins can access all opportunities (including drafts) for editing
      if (!isAdmin && opportunity.status !== 'published') {
        return res.status(404).json(createErrorResponse('Opportunity not found'));
      }

      // For admins editing their own opportunities, verify ownership (optional security check)
      // For now, allow any admin to edit any opportunity

      // Get owner info
      let ownerResult;
      try {
        ownerResult = await query(
          `SELECT name, email FROM users WHERE id = $1`,
          [opportunity.owner_user_id]
        );
      } catch (ownerError: unknown) {
        logger.error('Error fetching owner info', {
          errorMessage: ownerError instanceof Error ? ownerError.message : String(ownerError),
        });
        ownerResult = { rows: [{ name: 'Unknown', email: 'unknown@example.com' }] };
      }

      // Load sessions with dynamic booked_count calculation (matches actual bookings)
      let sessionsResult;
      try {
        sessionsResult = await query(
          `SELECT s.id, s.opportunity_id, s.start_time, s.end_time, s.capacity, 
                  s.location_or_meet_link_optional, s.created_at, s.updated_at,
                  s.booked_count as stored_booked_count,
                  COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)::int as booked_count,
                  (s.capacity - COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0))::int as remaining
           FROM sessions s
           LEFT JOIN bookings b ON s.id = b.session_id 
           WHERE s.opportunity_id = $1
           GROUP BY s.id, s.opportunity_id, s.start_time, s.end_time, s.capacity, 
                    s.location_or_meet_link_optional, s.created_at, s.updated_at, s.booked_count
           ORDER BY s.start_time ASC`,
          [opportunityId]
        );
      } catch (sessionsError: unknown) {
        logger.error('Error fetching sessions', {
          errorMessage: sessionsError instanceof Error ? sessionsError.message : String(sessionsError),
        });
        sessionsResult = { rows: [] };
      }

      // Get click count for polls/surveys (admin only)
      let clicks_total = null;
      if (isAdmin && (opportunity.type === 'poll' || opportunity.type === 'survey')) {
        try {
          const clicksResult = await query(
            `SELECT COUNT(*)::int as count FROM opportunity_clicks WHERE opportunity_id = $1`,
            [opportunityId]
          );
          clicks_total = clicksResult.rows[0]?.count || 0;
        } catch (clicksError: unknown) {
          logger.error('Error fetching clicks', {
            errorMessage: clicksError instanceof Error ? clicksError.message : String(clicksError),
          });
          clicks_total = 0;
        }
      }

      // Safely serialize opportunity data
      const opportunityWithDetails = {
        id: opportunity.id,
        type: opportunity.type,
        title: opportunity.title,
        purpose_one_liner: opportunity.purpose_one_liner,
        description_optional: opportunity.description_optional || null,
        product_optional: opportunity.product_optional || null,
        meeting_location_optional: opportunity.meeting_location_optional || null,
        default_duration_minutes: opportunity.default_duration_minutes,
        status: opportunity.status,
        owner_user_id: opportunity.owner_user_id,
        external_link_optional: opportunity.external_link_optional || null,
        participant_type_required: opportunity.participant_type_required || 'any',
        participant_type_specific_details: opportunity.participant_type_specific_details || null,
        display_width: opportunity.display_width || 'single',
        owner_name: ownerResult.rows[0]?.name || 'Unknown',
        owner_email: ownerResult.rows[0]?.email || 'unknown@example.com',
        sessions: sessionsResult.rows.map(s => {
          // Remove stored_booked_count from response, keep calculated booked_count
          const { stored_booked_count, ...session } = s;
          return {
            ...session,
            start_time: s.start_time ? new Date(s.start_time).toISOString() : null,
            end_time: s.end_time ? new Date(s.end_time).toISOString() : null,
            created_at: s.created_at ? new Date(s.created_at).toISOString() : null,
            updated_at: s.updated_at ? new Date(s.updated_at).toISOString() : null,
          };
        }),
        clicks_total,
        created_at: opportunity.created_at ? new Date(opportunity.created_at).toISOString() : null,
        updated_at: opportunity.updated_at ? new Date(opportunity.updated_at).toISOString() : null,
      };

      return res.status(200).json(opportunityWithDetails);
    }

    if (req.method === 'PATCH') {
      // Update opportunity
      const {
        type,
        title,
        purpose_one_liner,
        description_optional,
        product_optional,
        meeting_location_optional,
        default_duration_minutes,
        status,
        external_link_optional,
        participant_type_required,
        participant_type_specific_details,
        display_width,
      } = req.body;

      // Check if opportunity exists
      const checkResult = await query(
        `SELECT id FROM opportunities WHERE id = $1`,
        [opportunityId]
      );
      
      if (checkResult.rows.length === 0) {
        return res.status(404).json(createErrorResponse('Opportunity not found'));
      }

      // Build dynamic update query based on provided fields
      const updates: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (type !== undefined) {
        updates.push(`type = $${paramIndex++}`);
        params.push(type);
      }
      if (title !== undefined) {
        updates.push(`title = $${paramIndex++}`);
        params.push(title.trim());
      }
      if (purpose_one_liner !== undefined) {
        updates.push(`purpose_one_liner = $${paramIndex++}`);
        params.push(purpose_one_liner.trim());
      }
      if (description_optional !== undefined) {
        updates.push(`description_optional = $${paramIndex++}`);
        params.push(description_optional?.trim() || null);
      }
      if (product_optional !== undefined) {
        updates.push(`product_optional = $${paramIndex++}`);
        params.push(product_optional?.trim() || null);
      }
      if (meeting_location_optional !== undefined) {
        updates.push(`meeting_location_optional = $${paramIndex++}`);
        params.push(meeting_location_optional?.trim() || null);
      }
      if (default_duration_minutes !== undefined) {
        updates.push(`default_duration_minutes = $${paramIndex++}`);
        params.push(default_duration_minutes);
      }
      if (status !== undefined) {
        updates.push(`status = $${paramIndex++}`);
        params.push(status);
      }
      if (external_link_optional !== undefined) {
        updates.push(`external_link_optional = $${paramIndex++}`);
        params.push(external_link_optional?.trim() || null);
      }
      if (participant_type_required !== undefined) {
        updates.push(`participant_type_required = $${paramIndex++}`);
        params.push(participant_type_required);
      }
      if (participant_type_specific_details !== undefined) {
        updates.push(`participant_type_specific_details = $${paramIndex++}`);
        params.push(participant_type_specific_details?.trim() || null);
      }
      
      // Only superadmins can update display_width
      if (display_width !== undefined) {
        const user = parseSessionCookie(req);
        if (user?.role === 'superadmin') {
          updates.push(`display_width = $${paramIndex++}`);
          params.push(display_width);
        }
      }

      if (updates.length === 0) {
        return res.status(400).json(createErrorResponse('No fields to update'));
      }

      // Add updated_at and opportunity ID
      updates.push(`updated_at = NOW()`);
      params.push(opportunityId);

      const sql = `
        UPDATE opportunities 
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      const result = await query(sql, params);
      
      const opportunity = result.rows[0];

      // Get owner info
      const ownerResult = await query(
        `SELECT name, email FROM users WHERE id = $1`,
        [opportunity.owner_user_id]
      );

      // Load sessions
      const sessionsResult = await query(
        `SELECT * FROM sessions WHERE opportunity_id = $1 ORDER BY start_time ASC`,
        [opportunityId]
      );

      const opportunityWithOwner = {
        ...opportunity,
        owner_name: ownerResult.rows[0]?.name || 'Unknown',
        owner_email: ownerResult.rows[0]?.email || 'unknown@example.com',
        sessions: sessionsResult.rows.map(s => ({
          ...s,
          start_time: s.start_time.toISOString(),
          end_time: s.end_time.toISOString(),
          created_at: s.created_at.toISOString(),
          updated_at: s.updated_at.toISOString(),
        })),
        created_at: opportunity.created_at.toISOString(),
        updated_at: opportunity.updated_at.toISOString(),
      };

      return res.status(200).json(opportunityWithOwner);
    }

    if (req.method === 'DELETE') {
      // Check if opportunity exists
      const checkResult = await query(
        `SELECT id FROM opportunities WHERE id = $1`,
        [opportunityId]
      );
      
      if (checkResult.rows.length === 0) {
        return res.status(404).json(createErrorResponse('Opportunity not found'));
      }

      // Delete opportunity (cascading will delete related sessions and bookings)
      await query(
        `DELETE FROM opportunities WHERE id = $1`,
        [opportunityId]
      );

      return res.status(200).json({ message: 'Opportunity deleted successfully' });
    }

    return res.status(405).json(createErrorResponse('Method not allowed'));
  } catch (error: unknown) {
    // Enhanced error logging
    logger.error('Error in opportunities [id] handler', {
      errorMessage: error instanceof Error ? error.message : String(error),
      errorType: typeof error,
      errorStack: error instanceof Error ? error.stack : undefined,
      query: req.query,
      url: req.url,
      method: req.method,
      opportunityId: req.query.id
    });
    const errorMessage = getErrorMessage(error);
    return res.status(500).json(
      createErrorResponse('Internal server error', errorMessage)
    );
  }
}


