import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';

/**
 * PATCH /api/opportunities/[id]
 * Updates an existing opportunity
 * DELETE /api/opportunities/[id]
 * Deletes an opportunity
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Get ID from query params (Vercel dynamic routes)
    let opportunityId = req.query.id as string;
    
    // If not in query, try to parse from URL path
    if (!opportunityId && req.url) {
      const urlMatch = req.url.match(/\/opportunities\/([^\/]+)/);
      if (urlMatch) {
        opportunityId = urlMatch[1];
      }
    }
    
    if (!opportunityId) {
      return res.status(400).json({ error: 'Opportunity ID is required' });
    }

    console.log('Opportunities [id] endpoint called:', {
      method: req.method,
      id: opportunityId,
      url: req.url
    });

    if (req.method === 'PATCH') {
      // Update opportunity
      const {
        type,
        title,
        purpose_one_liner,
        description_optional,
        product_optional,
        default_duration_minutes,
        status,
        external_link_optional,
        participant_type_required,
        participant_type_specific_details,
      } = req.body;

      // Check if opportunity exists
      const checkResult = await query(
        `SELECT id FROM opportunities WHERE id = $1`,
        [opportunityId]
      );
      
      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }

      // Build dynamic update query based on provided fields
      const updates: string[] = [];
      const params: any[] = [];
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

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
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

      console.log('Updated opportunity:', opportunityWithOwner.id);
      return res.status(200).json(opportunityWithOwner);
    }

    if (req.method === 'DELETE') {
      // Check if opportunity exists
      const checkResult = await query(
        `SELECT id FROM opportunities WHERE id = $1`,
        [opportunityId]
      );
      
      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }

      // Delete opportunity (cascading will delete related sessions and bookings)
      await query(
        `DELETE FROM opportunities WHERE id = $1`,
        [opportunityId]
      );

      console.log('Deleted opportunity:', opportunityId);
      return res.status(200).json({ message: 'Opportunity deleted successfully' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Error in opportunities [id] handler:', error);
    console.error('Error stack:', error.stack);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message,
      code: error.code,
    });
  }
}

