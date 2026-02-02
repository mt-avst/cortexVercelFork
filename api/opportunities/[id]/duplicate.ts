import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../../db';
import { createErrorResponse, getErrorMessage } from '../../utils/errors';
import { parseSessionCookie } from '../../utils/auth';
import { logger } from '../../utils/logger';

interface OpportunityRow {
  id: string;
  owner_user_id: string;
  type: string;
  title: string;
  purpose_one_liner: string;
  description_optional?: string | null;
  product_optional?: string | null;
  meeting_location_optional?: string | null;
  default_duration_minutes: number;
  status: string;
  external_link_optional?: string | null;
  participant_type_required?: string | null;
  participant_type_specific_details?: string | null;
  display_width?: string | null;
  start_date?: Date | string | null;
  end_date?: Date | string | null;
  created_at?: Date;
  updated_at?: Date;
  [key: string]: unknown;
}

/**
 * POST /api/opportunities/[id]/duplicate
 * Duplicate an opportunity as a draft (admin only; owner or superadmin).
 * Returns the new opportunity with owner_name, owner_email, sessions: [].
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    const user = parseSessionCookie(req);
    if (!user) {
      return res.status(401).json(createErrorResponse('Authentication required'));
    }
    if (user.role !== 'researcher_admin' && user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Admin access required'));
    }

    let opportunityId: string | undefined;
    if (req.query.id) {
      opportunityId = Array.isArray(req.query.id) ? req.query.id[0] : (req.query.id as string);
    }
    if (!opportunityId && req.url) {
      const urlMatch = req.url.match(/\/opportunities\/([^\/\?]+)\/duplicate/);
      if (urlMatch?.[1]) opportunityId = urlMatch[1];
    }
    if (!opportunityId || opportunityId.length < 10) {
      logger.error('Duplicate: Invalid opportunity ID', { id: opportunityId, query: req.query, url: req.url });
      return res.status(400).json(createErrorResponse('Valid opportunity ID is required'));
    }

    const ownershipResult = await query(
      'SELECT id, owner_user_id FROM opportunities WHERE id = $1',
      [opportunityId]
    );
    if (ownershipResult.rows.length === 0) {
      return res.status(404).json(createErrorResponse('Opportunity not found'));
    }
    const { owner_user_id } = ownershipResult.rows[0] as { owner_user_id: string };
    if (owner_user_id !== user.id && user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Only the owner can duplicate this opportunity'));
    }

    const originalResult = await query('SELECT * FROM opportunities WHERE id = $1', [opportunityId]);
    if (originalResult.rows.length === 0) {
      return res.status(404).json(createErrorResponse('Opportunity not found'));
    }
    const opp = originalResult.rows[0] as OpportunityRow;

    const insertResult = await query(
      `INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional,
        product_optional, meeting_location_optional, default_duration_minutes, status,
        owner_user_id, external_link_optional, participant_type_required,
        participant_type_specific_details, display_width, start_date, end_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [
        opp.type,
        `${opp.title} (copy)`,
        opp.purpose_one_liner,
        opp.description_optional ?? null,
        opp.product_optional ?? null,
        opp.meeting_location_optional ?? null,
        opp.default_duration_minutes,
        user.id,
        opp.external_link_optional ?? null,
        opp.participant_type_required ?? 'any',
        opp.participant_type_specific_details ?? null,
        opp.display_width ?? 'single',
        opp.start_date ?? null,
        opp.end_date ?? null,
      ]
    );

    const newOpp = insertResult.rows[0] as OpportunityRow;

    const ownerResult = await query(
      'SELECT name, email FROM users WHERE id = $1',
      [user.id]
    );
    const ownerRow = ownerResult.rows[0] as { name?: string; email?: string } | undefined;

    const response = {
      ...newOpp,
      owner_name: ownerRow?.name ?? 'Unknown',
      owner_email: ownerRow?.email ?? 'unknown@example.com',
      sessions: [],
      created_at: newOpp.created_at ? new Date(newOpp.created_at).toISOString() : null,
      updated_at: newOpp.updated_at ? new Date(newOpp.updated_at).toISOString() : null,
      start_date: newOpp.start_date ? new Date(newOpp.start_date).toISOString() : null,
      end_date: newOpp.end_date ? new Date(newOpp.end_date).toISOString() : null,
    };

    return res.status(201).json(response);
  } catch (error: unknown) {
    logger.error('Error in duplicate opportunity handler', {
      errorMessage: error instanceof Error ? error.message : String(error),
      errorType: typeof error,
      errorStack: error instanceof Error ? error.stack : undefined,
      query: req.query,
      url: req.url,
      method: req.method,
    });
    const errorMessage = getErrorMessage(error);
    return res.status(500).json(
      createErrorResponse('Internal server error', errorMessage)
    );
  }
}
