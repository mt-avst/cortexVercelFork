import { Router, Request, Response } from 'express';
import crypto from 'crypto';

import { pool } from '../config';
import { requireAdmin, optionalAuth } from '../middleware/authenticate';
import { getMockOpportunities, getMockOpportunity, addMockOpportunity, updateMockOpportunity, deleteMockOpportunity, addMockSessions, getMockSessions } from '../../../demo/mock-data';
import { logger } from '../utils/logger';
import { isDatabaseAvailable } from '../utils/database';
import { 
  CreateOpportunitySchema, 
  UpdateOpportunitySchema, 
  CreateSessionsSchema,
  validateRequest,
  validateSessionData
} from '../validation/schemas';
import { AppError, ValidationError, NotFoundError, ForbiddenError, asyncHandler } from '../utils/errorHandler';
import { isFirstHandConfigured, firstHandPost } from '../utils/firsthand-client';

import { Opportunity, CreateOpportunityRequest, UpdateOpportunityRequest, Session, CreateSessionRequest } from '../types';

const router: Router = Router();

// Validation helper
const validateUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

// GET /api/opportunities - List opportunities
router.get('/', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  try {
    const type = req.query.type as string | undefined;
    const q = req.query.q as string | undefined;
    const status = req.query.status as string | undefined;
    const isAdmin = req.user?.role === 'researcher_admin' || req.user?.role === 'superadmin';
    
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    
    if (!dbAvailable) {
      // Use mock data
      interface OpportunityFilters {
        type?: string;
        q?: string;
        status?: string;
      }
      const filters: OpportunityFilters = {};
      if (type) filters.type = type as string;
      if (q) filters.q = q as string;
      if (status) filters.status = status as string;
      else if (!isAdmin) filters.status = 'published'; // Default to published for non-admin
      
      const opportunities = getMockOpportunities(filters);
      res.json(opportunities);
      return;
    }
    
    // Use database - LEFT JOIN so opportunities show even when owner not in users (e.g. demo/session-only)
    let query = `
      SELECT o.*, u.name as owner_name, u.email as owner_email
      FROM opportunities o
      LEFT JOIN users u ON o.owner_user_id = u.id
    `;
    const params: (string | number)[] = [];
    const conditions: string[] = [];
    
    // Add filters
    if (type) {
      conditions.push(`o.type = $${params.length + 1}`);
      params.push(type);
    }
    
    if (q) {
      conditions.push(`(o.title ILIKE $${params.length + 1} OR o.purpose_one_liner ILIKE $${params.length + 1})`);
      params.push(`%${q}%`);
    }
    
    // Admins can filter by status; non-admins always get only published
    if (isAdmin && status) {
      conditions.push(`o.status = $${params.length + 1}`);
      params.push(status);
    } else if (!isAdmin) {
      // Non-admins may only ever see published studies, regardless of any status query param
      conditions.push(`o.status = 'published'`);
    }
    
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    query += ` ORDER BY o.created_at DESC`;
    
    const result = await pool.query(query, params);
    
    // Performance optimization: Batch load all sessions and click counts in single queries
    // instead of N+1 queries per opportunity
    const opportunityIds = result.rows.map(opp => opp.id);
    
    // Get all sessions for all opportunities in one query
    let allSessionsMap: Map<string, any[]> = new Map();
    try {
      const sessionsResult = await pool.query(
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
          booked_count: session.actual_booked_count, // Use calculated value
          remaining: session.capacity - (session.actual_booked_count || 0), // Calculate from actual bookings
          start_time: session.start_time.toISOString(),
          end_time: session.end_time.toISOString(),
          created_at: session.created_at.toISOString(),
          updated_at: session.updated_at.toISOString(),
        });
      }
    } catch (sessionError: any) {
      logger.error('Error loading sessions batch:', { error: sessionError });
      // Continue with empty sessions map - opportunities will have empty sessions array
    }

    // Get all click counts for poll/survey opportunities in one query (only if admin)
    let clicksMap: Map<string, number> = new Map();
    if (isAdmin) {
      try {
        const pollSurveyOppIds = result.rows
          .filter(opp => opp.type === 'poll' || opp.type === 'survey' || opp.type === 'unmoderated')
          .map(opp => opp.id);
        
        if (pollSurveyOppIds.length > 0) {
          const clicksResult = await pool.query(
            `SELECT opportunity_id, COUNT(*)::int as count 
             FROM opportunity_clicks 
             WHERE opportunity_id = ANY($1::uuid[])
             GROUP BY opportunity_id`,
            [pollSurveyOppIds]
          );
          
          // Map click counts by opportunity_id
          for (const row of clicksResult.rows) {
            clicksMap.set(row.opportunity_id, parseInt(row.count || '0', 10));
          }
        }
      } catch (clickError: any) {
        logger.error('Error loading click counts batch:', { error: clickError });
        // Continue with empty clicks map
      }
    }

    // Combine results
    const opportunities = result.rows.map(opportunity => {
      const sessions = allSessionsMap.get(opportunity.id) || [];
      const clicks_total = ((opportunity.type === 'poll' || opportunity.type === 'survey' || opportunity.type === 'unmoderated') && isAdmin)
        ? (clicksMap.get(opportunity.id) ?? 0)
        : undefined;

      return {
        ...opportunity,
        owner_name: opportunity.owner_name || 'Unknown',
        owner_email: opportunity.owner_email || 'unknown@example.com',
        created_at: opportunity.created_at.toISOString(),
        updated_at: opportunity.updated_at.toISOString(),
        start_date: opportunity.start_date ? opportunity.start_date.toISOString() : null,
        end_date: opportunity.end_date ? opportunity.end_date.toISOString() : null,
        sessions,
        clicks_total,
      };
    });
    
    res.json(opportunities);
  } catch (error) {
    logger.error('Error in opportunities route', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
}));

// GET /api/opportunities/:id - Get opportunity detail
router.get('/:id', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const isAdmin = req.user?.role === 'researcher_admin' || req.user?.role === 'superadmin';
  
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  
  if (!dbAvailable) {
    // Use mock data
    const opportunity = getMockOpportunity(id);
    if (!opportunity) {
      throw new NotFoundError('Opportunity');
    }
    
    // Non-admin users can only see published opportunities
    if (!isAdmin && opportunity.status !== 'published') {
      throw new NotFoundError('Opportunity');
    }
    
    res.json(opportunity);
    return;
  }
  
  // Use database - LEFT JOIN so opportunities show even when owner not in users (e.g. demo/session-only)
  let query = `
    SELECT o.*, u.name as owner_name, u.email as owner_email
    FROM opportunities o
    LEFT JOIN users u ON o.owner_user_id = u.id
    WHERE o.id = $1
  `;
  const params = [id];
  
  // Non-admin users can only see published opportunities
  if (!isAdmin) {
    query += ` AND o.status = 'published'`;
  }
  
  const result = await pool.query(query, params);
  
  if (result.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }
  
  // Get sessions for this opportunity with dynamic booked_count calculation
  const sessionsResult = await pool.query(`
    SELECT s.*,
           COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)::int as actual_booked_count
    FROM sessions s
    LEFT JOIN bookings b ON s.id = b.session_id
    WHERE s.opportunity_id = $1
    GROUP BY s.id, s.opportunity_id, s.start_time, s.end_time, s.capacity,
             s.location_or_meet_link_optional, s.created_at, s.updated_at, s.booked_count
    ORDER BY s.start_time ASC
  `, [id]);

  const row = result.rows[0];
  const opportunity = {
    ...row,
    owner_name: row.owner_name || 'Unknown',
    owner_email: row.owner_email || 'unknown@example.com',
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    start_date: row.start_date ? row.start_date.toISOString() : null,
    end_date: row.end_date ? row.end_date.toISOString() : null,
    sessions: sessionsResult.rows.map(session => ({
      ...session,
      booked_count: session.actual_booked_count, // Use calculated value
      remaining: session.capacity - (session.actual_booked_count || 0), // Calculate from actual bookings
      start_time: session.start_time.toISOString(),
      end_time: session.end_time.toISOString(),
      created_at: session.created_at.toISOString(),
      updated_at: session.updated_at.toISOString(),
    }))
  };
  
  res.json(opportunity);
}));

// POST /api/opportunities - Create opportunity
router.post('/', requireAdmin, validateRequest(CreateOpportunitySchema), asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    // Note: Data is already validated by validateRequest(CreateOpportunitySchema) middleware
    const data: CreateOpportunityRequest = req.body;
    
    // Create mock opportunity
    const mockOpportunity = {
      id: `mock-${Date.now()}`,
      type: data.type,
      title: data.title.trim(),
      purpose_one_liner: data.purpose_one_liner.trim(),
      description_optional: data.description_optional?.trim() || null,
      product_optional: data.product_optional?.trim() || null,
      default_duration_minutes: data.default_duration_minutes || 30,
      status: data.status || 'draft',
      owner_user_id: req.user!.id,
      external_link_optional: data.external_link_optional?.trim() || null,
      participant_type_required: data.participant_type_required || 'any',
      participant_type_specific_details: data.participant_type_specific_details?.trim() || null,
      start_date: data.start_date || null,
      end_date: data.end_date || null,
      created_at: new Date(),
      updated_at: new Date(),
      owner_name: req.user!.name,
      owner_email: req.user!.email,
      sessions: []
    };
    
    // Add to dynamic mock data
    addMockOpportunity(mockOpportunity);
    
    return res.status(201).json(mockOpportunity);
  }
  
  const data: CreateOpportunityRequest = req.body;
  // Note: Data is already validated by validateRequest(CreateOpportunitySchema) middleware
  
  // Additional validation for published polls/surveys/unmoderated
  if (data.status === 'published' && (data.type === 'poll' || data.type === 'survey' || data.type === 'unmoderated')) {
    const isFirstHandBacked = data.type === 'unmoderated' && data.firsthand_study_id;
    if (!isFirstHandBacked && (!data.external_link_optional || !validateUrl(data.external_link_optional))) {
      throw new ValidationError('External link is required for published polls, surveys, and unmoderated tests without a FirstHand study');
    }
  }

  // Ensure session user exists in DB (demo/session-only users may not be persisted)
  await pool.query(
    `INSERT INTO users (id, name, email, business_unit, role_title, role)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
       business_unit = EXCLUDED.business_unit, role_title = EXCLUDED.role_title, role = EXCLUDED.role`,
    [
      req.user!.id,
      req.user!.name,
      req.user!.email,
      req.user!.business_unit || null,
      req.user!.role_title || null,
      req.user!.role,
    ]
  );

  // Only superadmins can set display_width - default to 'single' otherwise
  const isSuperadmin = req.user!.role === 'superadmin';
  const finalDisplayWidth = isSuperadmin && (data as any).display_width ? (data as any).display_width : 'single';

  const query = `
    INSERT INTO opportunities (
      type, title, purpose_one_liner, description_optional,
      product_optional, meeting_location_optional, default_duration_minutes, status,
      owner_user_id, external_link_optional, firsthand_study_id, participant_type_required,
      participant_type_specific_details, start_date, end_date, display_width
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    RETURNING *
  `;

  const values = [
    data.type,
    data.title.trim(),
    data.purpose_one_liner.trim(),
    data.description_optional?.trim() || null,
    data.product_optional?.trim() || null,
    data.meeting_location_optional?.trim() || null,
    data.default_duration_minutes || 30,
    data.status || 'draft',
    req.user!.id,
    data.external_link_optional?.trim() || null,
    data.firsthand_study_id?.trim() || null,
    data.participant_type_required || 'any',
    data.participant_type_specific_details?.trim() || null,
    data.start_date || null,
    data.end_date || null,
    finalDisplayWidth
  ];
  
  const result = await pool.query(query, values);
  const opportunity = {
    ...result.rows[0],
    created_at: result.rows[0].created_at.toISOString(),
    updated_at: result.rows[0].updated_at.toISOString(),
    start_date: result.rows[0].start_date ? result.rows[0].start_date.toISOString() : null,
    end_date: result.rows[0].end_date ? result.rows[0].end_date.toISOString() : null,
    sessions: []
  };
  
  res.status(201).json(opportunity);
}));

// PATCH /api/opportunities/:id - Update opportunity
router.patch('/:id', requireAdmin, validateRequest(UpdateOpportunitySchema), asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    // Note: Data is already validated by validateRequest(UpdateOpportunitySchema) middleware
    const { id } = req.params;
    const data: UpdateOpportunityRequest = req.body;
    
    // Check if opportunity exists
    const existingOpportunity = getMockOpportunity(id);
    if (!existingOpportunity) {
      throw new NotFoundError('Opportunity');
    }
    
    // Check ownership (superadmins can edit any)
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && existingOpportunity.owner_user_id !== req.user!.id) {
      throw new ForbiddenError('Only the owner can edit this opportunity');
    }
    
    // Update the opportunity
    const updatedOpportunity = updateMockOpportunity(id, {
      ...data,
      updated_at: new Date()
    });
    
    if (!updatedOpportunity) {
      throw new NotFoundError('Opportunity');
    }
    
    return res.json(updatedOpportunity);
  }
  
  const { id } = req.params;
  const data: UpdateOpportunityRequest = req.body;
  // Note: Data is already validated by validateRequest(UpdateOpportunitySchema) middleware
  
  // Check ownership (only owner or global admin can edit)
  const ownershipCheck = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [id]
  );
  
  if (ownershipCheck.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }
  
  // Check ownership (superadmins can edit any)
  const isOwner = ownershipCheck.rows[0].owner_user_id === req.user!.id;
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOwner) {
    throw new ForbiddenError('Only the owner can edit this opportunity');
  }
  
  // Get existing opportunity to check type when status is being changed
  const existingOpp = await pool.query(
    'SELECT type, external_link_optional, firsthand_study_id FROM opportunities WHERE id = $1',
    [id]
  );
  const existingType = data.type || existingOpp.rows[0].type;
  const existingLink = existingOpp.rows[0].external_link_optional;
  const existingFirstHandStudyId = existingOpp.rows[0].firsthand_study_id;
  const newLink = data.external_link_optional !== undefined ? data.external_link_optional : existingLink;
  const newFirstHandStudyId = data.firsthand_study_id !== undefined ? data.firsthand_study_id : existingFirstHandStudyId;

  // Additional validation for published polls/surveys/unmoderated
  if (data.status === 'published' && (existingType === 'poll' || existingType === 'survey' || existingType === 'unmoderated')) {
    const isFirstHandBacked = existingType === 'unmoderated' && newFirstHandStudyId;
    if (!isFirstHandBacked && (!newLink || !validateUrl(newLink))) {
      throw new ValidationError('External link is required for published polls, surveys, and unmoderated tests without a FirstHand study');
    }
  }
  
  // Build dynamic update query
  const updateFields: string[] = [];
  const values: (string | number | Date | null)[] = [];
  let paramCount = 0;
  
  Object.entries(data).forEach(([key, value]) => {
    if (value !== undefined) {
      paramCount++;
      updateFields.push(`${key} = $${paramCount}`);
      values.push(typeof value === 'string' ? value.trim() : value);
    }
  });
  
  if (updateFields.length === 0) {
    throw new ValidationError('No fields to update');
  }
  
  paramCount++;
  values.push(id);
  
  const query = `
    UPDATE opportunities 
    SET ${updateFields.join(', ')}
    WHERE id = $${paramCount}
    RETURNING *
  `;
  
  const result = await pool.query(query, values);
  const opportunity = {
    ...result.rows[0],
    created_at: result.rows[0].created_at.toISOString(),
    updated_at: result.rows[0].updated_at.toISOString(),
    start_date: result.rows[0].start_date ? result.rows[0].start_date.toISOString() : null,
    end_date: result.rows[0].end_date ? result.rows[0].end_date.toISOString() : null,
    sessions: []
  };
  
  res.json(opportunity);
}));

// POST /api/opportunities/:id/firsthand-handoff - Create a FirstHand session for this opportunity
router.post('/:id/firsthand-handoff', asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!isFirstHandConfigured()) {
    return res.status(503).json({ error: 'FirstHand integration not configured' });
  }

  const { id } = req.params;
  const dbAvailable = await isDatabaseAvailable();

  let studyId: string | null = null;
  if (dbAvailable) {
    const result = await pool.query(
      'SELECT firsthand_study_id, status FROM opportunities WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      throw new NotFoundError('Opportunity');
    }
    if (result.rows[0].status !== 'published') {
      return res.status(403).json({ error: 'Opportunity is not published' });
    }
    studyId = result.rows[0].firsthand_study_id;
  }

  if (!studyId) {
    return res.status(400).json({ error: 'Opportunity has no FirstHand study linked' });
  }

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
  const returnUrl = `${frontendUrl}/opportunities/${id}?completed=1`;
  const callbackUrl = `${backendUrl}/api/firsthand/callbacks`;

  const session = await firstHandPost<{ session_url: string }>('/api/sessions', {
    study_id: studyId,
    participant: {
      participant_id: req.user.id,
      display_name: req.user.name,
      email: req.user.email,
      external_ref: id,
    },
    callback_url: callbackUrl,
    return_url: returnUrl,
  });

  res.json({ session_url: session.session_url });
}));

// GET /api/opportunities/:id/session-events - List FirstHand session events for an opportunity
router.get('/:id/session-events', asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { id } = req.params;
  const dbAvailable = await isDatabaseAvailable();

  if (!dbAvailable) {
    return res.json([]);
  }

  const firsthandBaseUrl = process.env.FIRSTHAND_BASE_URL || '';

  const result = await pool.query(
    `SELECT
       e.id,
       e.opportunity_id,
       e.participant_user_id,
       e.firsthand_session_id,
       e.event_type,
       e.occurred_at,
       e.payload,
       e.received_at,
       u.name AS participant_name,
       u.email AS participant_email
     FROM opportunity_session_events e
     LEFT JOIN users u ON u.id = e.participant_user_id
     WHERE e.opportunity_id = $1
     ORDER BY e.occurred_at DESC`,
    [id]
  );

  const events = result.rows.map((row) => ({
    ...row,
    firsthand_review_url: firsthandBaseUrl
      ? `${firsthandBaseUrl}/review/session/${row.firsthand_session_id}`
      : null
  }));

  res.json(events);
}));

// DELETE /api/opportunities/:id - Delete opportunity
router.delete('/:id', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    const { id } = req.params;
    
    // Check if opportunity exists
    const existingOpportunity = getMockOpportunity(id);
    if (!existingOpportunity) {
      throw new NotFoundError('Opportunity');
    }
    
    // Check ownership (superadmins can delete any)
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && existingOpportunity.owner_user_id !== req.user!.id) {
      throw new ForbiddenError('Only the owner can delete this opportunity');
    }
    
    // Delete the opportunity
    const deleted = deleteMockOpportunity(id);
    if (!deleted) {
      throw new NotFoundError('Opportunity');
    }
    
    return res.status(204).send();
  }
  
  const { id } = req.params;
  
  // Check ownership
  const ownershipCheck = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [id]
  );
  
  if (ownershipCheck.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }
  
  // Check ownership (superadmins can delete any)
  const isOwner = ownershipCheck.rows[0].owner_user_id === req.user!.id;
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOwner) {
    throw new ForbiddenError('Only the owner can delete this opportunity');
  }
  
  await pool.query('DELETE FROM opportunities WHERE id = $1', [id]);

  res.status(204).send();
}));

// POST /api/opportunities/:id/duplicate - Duplicate opportunity
router.post('/:id/duplicate', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    const { id } = req.params;

    // Check if opportunity exists
    const existingOpportunity = getMockOpportunity(id);
    if (!existingOpportunity) {
      throw new NotFoundError('Opportunity');
    }

    // Check ownership (superadmins can duplicate any)
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && existingOpportunity.owner_user_id !== req.user!.id) {
      throw new ForbiddenError('Only the owner can duplicate this opportunity');
    }

    // Create duplicate as draft
    const duplicateOpportunity = {
      id: `mock-${Date.now()}`,
      type: existingOpportunity.type,
      title: `${existingOpportunity.title} (copy)`,
      purpose_one_liner: existingOpportunity.purpose_one_liner,
      description_optional: existingOpportunity.description_optional,
      product_optional: existingOpportunity.product_optional,
      default_duration_minutes: existingOpportunity.default_duration_minutes,
      status: 'draft' as const,
      owner_user_id: req.user!.id,
      external_link_optional: existingOpportunity.external_link_optional,
      participant_type_required: existingOpportunity.participant_type_required,
      participant_type_specific_details: existingOpportunity.participant_type_specific_details,
      created_at: new Date(),
      updated_at: new Date(),
      owner_name: req.user!.name,
      owner_email: req.user!.email,
      sessions: []
    };

    addMockOpportunity(duplicateOpportunity);

    return res.status(201).json(duplicateOpportunity);
  }

  const { id } = req.params;

  // Check ownership
  const ownershipCheck = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [id]
  );

  if (ownershipCheck.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }

  // Check ownership (superadmins can duplicate any)
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && ownershipCheck.rows[0].owner_user_id !== req.user!.id) {
    throw new ForbiddenError('Only the owner can duplicate this opportunity');
  }

  // Get the original opportunity
  const original = await pool.query('SELECT * FROM opportunities WHERE id = $1', [id]);
  if (original.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }

  const opp = original.rows[0];

  // Create duplicate as draft
  const query = `
    INSERT INTO opportunities (
      type, title, purpose_one_liner, description_optional,
      product_optional, default_duration_minutes, status,
      owner_user_id, external_link_optional, participant_type_required, participant_type_specific_details
    ) VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10)
    RETURNING *
  `;

  const values = [
    opp.type,
    `${opp.title} (copy)`,
    opp.purpose_one_liner,
    opp.description_optional,
    opp.product_optional,
    opp.default_duration_minutes,
    req.user!.id,
    opp.external_link_optional,
    opp.participant_type_required,
    opp.participant_type_specific_details
  ];

  const result = await pool.query(query, values);
  const duplicatedOpportunity = result.rows[0];

  // Add empty sessions array for consistency with frontend
  duplicatedOpportunity.sessions = [];

  res.status(201).json(duplicatedOpportunity);
}));

// GET /api/opportunities/:id/sessions - Get sessions for an opportunity
router.get('/:id/sessions', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id: opportunityId } = req.params;
    const from = req.query.from as string | undefined;
    const include_past = req.query.include_past as string | undefined;
    
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      // Use mock data for development
      const opportunity = getMockOpportunity(opportunityId);
      if (!opportunity) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      
      const isAdmin = req.user?.role === 'researcher_admin' || req.user?.role === 'superadmin';
      
      // Non-admin users can only see published opportunities
      if (!isAdmin && opportunity.status !== 'published') {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      
      // Get mock sessions for this opportunity
      const mockSessions = getMockSessions(opportunityId);
      
      // Apply filters similar to database query
      let filteredSessions = mockSessions;
      
      // Filter by start time if provided
      if (from) {
        const fromDate = new Date(from as string);
        filteredSessions = filteredSessions.filter(session => 
          new Date(session.start_time) >= fromDate
        );
      }
      
      // Filter out past sessions unless explicitly requested
      if (include_past !== 'true') {
        const now = new Date();
        filteredSessions = filteredSessions.filter(session => 
          new Date(session.end_time) >= now
        );
      }
      
      // Sort by start time
      filteredSessions.sort((a, b) => 
        new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
      );
      
      return res.json(filteredSessions);
    }
    
    // Check if opportunity exists and user has access - LEFT JOIN for demo/session-only owners
    const opportunityCheck = await pool.query(`
      SELECT o.*, u.name as owner_name, u.email as owner_email
      FROM opportunities o
      LEFT JOIN users u ON o.owner_user_id = u.id
      WHERE o.id = $1
    `, [opportunityId]);
    
    if (opportunityCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    
    const opportunity = opportunityCheck.rows[0];
    const isAdmin = req.user?.role === 'researcher_admin' || req.user?.role === 'superadmin';
    
    // Non-admin users can only see published opportunities
    if (!isAdmin && opportunity.status !== 'published') {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    
    // Build query for sessions with dynamic booked_count calculation
    let query = `
      SELECT s.*,
             COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)::int as actual_booked_count
      FROM sessions s
      LEFT JOIN bookings b ON s.id = b.session_id
      WHERE s.opportunity_id = $1
    `;
    const params: string[] = [opportunityId];
    let paramCount = 1;

    // Filter by start time if provided
    if (from) {
      paramCount++;
      query += ` AND s.start_time >= $${paramCount}`;
      params.push(from);
    }

    // Filter out past sessions unless explicitly requested
    if (include_past !== 'true') {
      query += ` AND s.end_time >= NOW()`;
    }

    query += ` GROUP BY s.id, s.opportunity_id, s.start_time, s.end_time, s.capacity,
               s.location_or_meet_link_optional, s.created_at, s.updated_at, s.booked_count`;
    query += ` ORDER BY s.start_time ASC`;

    const result = await pool.query(query, params);

    // Serialize dates for API response
    const sessions = result.rows.map(session => ({
      ...session,
      booked_count: session.actual_booked_count, // Use calculated value
      remaining: session.capacity - (session.actual_booked_count || 0), // Calculate from actual bookings
      start_time: session.start_time.toISOString(),
      end_time: session.end_time.toISOString(),
      created_at: session.created_at.toISOString(),
      updated_at: session.updated_at.toISOString(),
    }));
    
    res.json(sessions);
  } catch (error) {
    logger.error('Error fetching sessions', { error });
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
}));

// POST /api/opportunities/:id/sessions - Create sessions for an opportunity
router.post('/:id/sessions', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id: opportunityId } = req.params;
    const sessionsData = req.body;
    
    // Handle both single session and array of sessions
    const sessions = Array.isArray(sessionsData) ? sessionsData : [sessionsData];
    
    if (sessions.length === 0) {
      return res.status(400).json({ error: 'At least one session is required' });
    }
    
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      // Use mock data for development
      const opportunity = getMockOpportunity(opportunityId);
      if (!opportunity) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      
      // Check ownership (superadmins can add sessions to any)
      const isSuperadmin = req.user!.role === 'superadmin';
      if (!isSuperadmin && opportunity.owner_user_id !== req.user!.id) {
        return res.status(403).json({ error: 'Only the owner can add sessions to this opportunity' });
      }
      
      // Validate all sessions
      const validationErrors: string[] = [];
      sessions.forEach((session, index) => {
        const errors = validateSessionData(session);
        errors.forEach(error => validationErrors.push(`Session ${index + 1}: ${error}`));
      });
      
      if (validationErrors.length > 0) {
        return res.status(400).json({ error: 'Validation failed', details: validationErrors });
      }
      
      // Create mock sessions
      const createdSessions = addMockSessions(opportunityId, sessions);
      
      return res.status(201).json(createdSessions);
    }
    
    // Check opportunity ownership
    const opportunityCheck = await pool.query(
      'SELECT owner_user_id FROM opportunities WHERE id = $1',
      [opportunityId]
    );
    
    if (opportunityCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    
    // Check ownership (superadmins can add sessions to any)
    const isOwner = opportunityCheck.rows[0].owner_user_id === req.user!.id;
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && !isOwner) {
      return res.status(403).json({ error: 'Only the owner can add sessions to this opportunity' });
    }
    
    // Validate all sessions
    const validationErrors: string[] = [];
    sessions.forEach((session, index) => {
      const errors = validateSessionData(session);
      errors.forEach(error => validationErrors.push(`Session ${index + 1}: ${error}`));
    });
    
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors });
    }
    
    // Check for overlaps within the batch
    for (let i = 0; i < sessions.length; i++) {
      for (let j = i + 1; j < sessions.length; j++) {
        const session1 = sessions[i];
        const session2 = sessions[j];
        const start1 = new Date(session1.start_time);
        const end1 = new Date(session1.end_time);
        const start2 = new Date(session2.start_time);
        const end2 = new Date(session2.end_time);
        
        if ((start1 < end2) && (start2 < end1)) {
          return res.status(409).json({ 
            error: `Sessions ${i + 1} and ${j + 1} overlap in time` 
          });
        }
      }
    }
    
    // Create sessions in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const createdSessions: Session[] = [];
      
      for (const session of sessions) {
        const query = `
          INSERT INTO sessions (
            opportunity_id, start_time, end_time, capacity, 
            location_or_meet_link_optional
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING *, (capacity - booked_count) as remaining
        `;
        
        const values = [
          opportunityId,
          session.start_time,
          session.end_time,
          session.capacity,
          session.location_or_meet_link_optional || null
        ];
        
        const result = await client.query(query, values);
        const createdSession = {
          ...result.rows[0],
          start_time: result.rows[0].start_time.toISOString(),
          end_time: result.rows[0].end_time.toISOString(),
          created_at: result.rows[0].created_at.toISOString(),
          updated_at: result.rows[0].updated_at.toISOString(),
        };
        createdSessions.push(createdSession);
      }
      
      await client.query('COMMIT');
      
      res.status(201).json(createdSessions);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Error creating sessions', { error });
    res.status(500).json({ error: 'Failed to create sessions' });
  }
}));

// DELETE /api/opportunities/:id/sessions - Delete all sessions for an opportunity
router.delete('/:id/sessions', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id: opportunityId } = req.params;
    
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      // Use mock data for development
      const opportunity = getMockOpportunity(opportunityId);
      if (!opportunity) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      
      // Check ownership (superadmins can delete sessions from any)
      const isSuperadmin = req.user!.role === 'superadmin';
      if (!isSuperadmin && opportunity.owner_user_id !== req.user!.id) {
        return res.status(403).json({ error: 'Only the owner can delete sessions from this opportunity' });
      }
      
      // Get all sessions for this opportunity
      const sessions = getMockSessions(opportunityId);
      
      // Check if any sessions have bookings
      const sessionsWithBookings = sessions.filter(session => session.booked_count > 0);
      if (sessionsWithBookings.length > 0) {
        return res.status(400).json({ 
          error: `Cannot delete sessions with existing bookings. ${sessionsWithBookings.length} session(s) have bookings.` 
        });
      }
      
      // Delete all sessions (this would need to be implemented in mock-data.ts)
      // For now, return success
      return res.json({ 
        message: 'All sessions deleted successfully', 
        deleted_count: sessions.length 
      });
    }
    
    // Check opportunity ownership
    const opportunityCheck = await pool.query(
      'SELECT owner_user_id FROM opportunities WHERE id = $1',
      [opportunityId]
    );
    
    if (opportunityCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    
    // Check ownership (superadmins can delete sessions from any)
    const isOwner = opportunityCheck.rows[0].owner_user_id === req.user!.id;
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && !isOwner) {
      return res.status(403).json({ error: 'Only the owner can delete sessions from this opportunity' });
    }
    
    // Check if any sessions have bookings
    const sessionsCheck = await pool.query(
      'SELECT s.id FROM sessions s WHERE s.opportunity_id = $1 AND EXISTS (SELECT 1 FROM bookings b WHERE b.session_id = s.id AND b.status = \'booked\')',
      [opportunityId]
    );
    
    if (sessionsCheck.rows.length > 0) {
      return res.status(400).json({ 
        error: `Cannot delete sessions with existing bookings. ${sessionsCheck.rows.length} session(s) have bookings.` 
      });
    }
    
    // Delete all bookings first (ON DELETE CASCADE should handle this, but explicit is safer)
    await pool.query(
      'DELETE FROM bookings WHERE session_id IN (SELECT id FROM sessions WHERE opportunity_id = $1)',
      [opportunityId]
    );
    
    // Delete all sessions for this opportunity
    const deleteResult = await pool.query(
      'DELETE FROM sessions WHERE opportunity_id = $1',
      [opportunityId]
    );
    
    res.json({ 
      message: 'All sessions deleted successfully', 
      deleted_count: deleteResult.rowCount 
    });
  } catch (error) {
    logger.error('Error deleting sessions', { error });
    res.status(500).json({ error: 'Failed to delete sessions' });
  }
}));

// POST /api/opportunities/:id/click - Track click for poll/survey
router.post('/:id/click', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id: opportunityId } = req.params;
  
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // In demo mode, just return success
    return res.json({ ok: true });
  }

  try {
    // Load opportunity to check type and status
    const opportunityResult = await pool.query(
      'SELECT id, type, status FROM opportunities WHERE id = $1',
      [opportunityId]
    );

    if (opportunityResult.rows.length === 0) {
      throw new NotFoundError('Opportunity');
    }

    const opportunity = opportunityResult.rows[0];

    // Only allow click tracking for poll, survey, or unmoderated types
    if (opportunity.type !== 'poll' && opportunity.type !== 'survey' && opportunity.type !== 'unmoderated') {
      throw new ValidationError('Click tracking is only available for polls, surveys, and unmoderated tests');
    }

    // Only allow tracking for published opportunities
    if (opportunity.status !== 'published') {
      throw new NotFoundError('Opportunity not published');
    }

    // Get user ID if authenticated, otherwise null
    const userId = req.user?.id || null;

    // Get user agent and IP for tracking (privacy-aware)
    const userAgent = req.headers['user-agent'] || null;
    const clientIp = req.ip || req.socket.remoteAddress || null;
    
    // Hash IP address for privacy
    let ipHash = null;
    if (clientIp && process.env.SESSION_SECRET) {
      ipHash = crypto
        .createHash('sha256')
        .update(clientIp + process.env.SESSION_SECRET)
        .digest('hex')
        .substring(0, 32); // Store only first 32 chars
    }

    // Record the click
    await pool.query(
      `INSERT INTO opportunity_clicks (opportunity_id, user_id, user_agent, ip_hash)
       VALUES ($1, $2, $3, $4)`,
      [opportunityId, userId, userAgent, ipHash]
    );

    res.json({ ok: true });
  } catch (error) {
    throw error;
  }
}));

// GET /api/opportunities/:id/analytics - Get click analytics for admin
router.get('/:id/analytics', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { id: opportunityId } = req.params;
  const userId = req.user!.id;

  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    return res.json({
      clicks_total: 0,
      clicks_24h: 0,
      clicks_by_day: []
    });
  }

  try {
    // Check opportunity ownership
    const opportunityResult = await pool.query(
      'SELECT owner_user_id FROM opportunities WHERE id = $1',
      [opportunityId]
    );

    if (opportunityResult.rows.length === 0) {
      throw new NotFoundError('Opportunity');
    }

    const opportunity = opportunityResult.rows[0];

    // Only owner or superadmin can view analytics
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && opportunity.owner_user_id !== userId) {
      throw new ForbiddenError('Only the opportunity owner can view analytics');
    }

    // Get total clicks
    const totalResult = await pool.query(
      'SELECT COUNT(*) as count FROM opportunity_clicks WHERE opportunity_id = $1',
      [opportunityId]
    );
    const clicks_total = parseInt(totalResult.rows[0].count, 10);

    // Get clicks in last 24 hours
    const hours24Result = await pool.query(
      `SELECT COUNT(*) as count FROM opportunity_clicks 
       WHERE opportunity_id = $1 AND clicked_at >= NOW() - INTERVAL '24 hours'`,
      [opportunityId]
    );
    const clicks_24h = parseInt(hours24Result.rows[0].count, 10);

    // Get clicks by day for last 30 days
    const dailyResult = await pool.query(
      `SELECT 
        DATE(clicked_at) as date,
        COUNT(*)::int as count
       FROM opportunity_clicks
       WHERE opportunity_id = $1 
         AND clicked_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(clicked_at)
       ORDER BY date ASC`,
      [opportunityId]
    );

    const clicks_by_day = dailyResult.rows.map(row => ({
      date: row.date.toISOString().split('T')[0], // Format as YYYY-MM-DD
      count: parseInt(row.count, 10)
    }));

    res.json({
      clicks_total,
      clicks_24h,
      clicks_by_day
    });
  } catch (error) {
    throw error;
  }
}));

export default router;
