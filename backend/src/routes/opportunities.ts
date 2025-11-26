import { Router, Request, Response } from 'express';
import crypto from 'crypto';

import { pool } from '../config';
import { requireAdmin, optionalAuth } from '../middleware/authenticate';
import { getMockOpportunities, getMockOpportunity, addMockOpportunity, updateMockOpportunity, deleteMockOpportunity, addMockSessions, getMockSessions } from '../../../demo/mock-data';
import { logger } from '../utils/logger';
import { 
  CreateOpportunitySchema, 
  UpdateOpportunitySchema, 
  OpportunityQuerySchema,
  validateRequest,
  validateQuery 
} from '../validation/schemas';
import { AppError, ValidationError, NotFoundError, ForbiddenError, asyncHandler } from '../utils/errorHandler';

import { Opportunity, CreateOpportunityRequest, UpdateOpportunityRequest, Session, CreateSessionRequest } from '../types';

const router: Router = Router();

// Helper function to check if database is available
const isDatabaseAvailable = async (): Promise<boolean> => {
  try {
    // Check if DATABASE_URL is set
    if (!process.env.DATABASE_URL) {
      logger.info('DATABASE_URL not set, using mock data');
      return false;
    }
    // Test both connection and that the opportunities table exists
    await pool.query('SELECT 1 FROM opportunities LIMIT 1');
    return true;
  } catch (error) {
    logger.warn('Database not available, using mock data', { error: (error as Error).message });
    return false;
  }
};

// Validation helpers
const validateUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

// Helper function to validate session data
const validateSessionData = (data: CreateSessionRequest): string[] => {
  const errors: string[] = [];
  
  if (data.start_time !== undefined) {
    const startTime = new Date(data.start_time);
    if (isNaN(startTime.getTime())) {
      errors.push('Start time must be a valid ISO date string');
    }
  }
  
  if (data.end_time !== undefined) {
    const endTime = new Date(data.end_time);
    if (isNaN(endTime.getTime())) {
      errors.push('End time must be a valid ISO date string');
    }
  }
  
  if (data.start_time && data.end_time) {
    const startTime = new Date(data.start_time);
    const endTime = new Date(data.end_time);
    if (startTime >= endTime) {
      errors.push('End time must be after start time');
    }
  }
  
  if (data.capacity !== undefined) {
    if (data.capacity < 1 || data.capacity > 100) {
      errors.push('Capacity must be between 1 and 100');
    }
  }
  
  return errors;
};

// GET /api/opportunities - List opportunities
router.get('/', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { type, q, status } = req.query;
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
    
    // Use database
    let query = `
      SELECT o.*, u.name as owner_name, u.email as owner_email
      FROM opportunities o
      JOIN users u ON o.owner_user_id = u.id
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
    
    if (status) {
      conditions.push(`o.status = $${params.length + 1}`);
      params.push(status);
    } else if (!isAdmin) {
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
        `SELECT *, (capacity - booked_count) as remaining, opportunity_id
         FROM sessions 
         WHERE opportunity_id = ANY($1::uuid[])
         ORDER BY opportunity_id, start_time ASC`,
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
  
  // Use database
  let query = `
    SELECT o.*, u.name as owner_name, u.email as owner_email
    FROM opportunities o
    JOIN users u ON o.owner_user_id = u.id
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
  
  // Get sessions for this opportunity
  const sessionsResult = await pool.query(`
    SELECT *, (capacity - booked_count) as remaining
    FROM sessions 
    WHERE opportunity_id = $1
    ORDER BY start_time ASC
  `, [id]);
  
  const opportunity = {
    ...result.rows[0],
    created_at: result.rows[0].created_at.toISOString(),
    updated_at: result.rows[0].updated_at.toISOString(),
    start_date: result.rows[0].start_date ? result.rows[0].start_date.toISOString() : null,
    end_date: result.rows[0].end_date ? result.rows[0].end_date.toISOString() : null,
    sessions: sessionsResult.rows.map(session => ({
      ...session,
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
  
  // Additional validation for published polls/surveys/unmoderated (M6 requirement)
  if (data.status === 'published' && (data.type === 'poll' || data.type === 'survey' || data.type === 'unmoderated')) {
    if (!data.external_link_optional || !validateUrl(data.external_link_optional)) {
      throw new ValidationError('External link is required for published polls, surveys, and unmoderated tests');
    }
  }
  
  const query = `
    INSERT INTO opportunities (
      type, title, purpose_one_liner, description_optional, 
      product_optional, meeting_location_optional, default_duration_minutes, status, 
      owner_user_id, external_link_optional, participant_type_required, participant_type_specific_details,
      start_date, end_date
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
    data.participant_type_required || 'any',
    data.participant_type_specific_details?.trim() || null,
    data.start_date || null,
    data.end_date || null
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
    
    // Check ownership
    if (existingOpportunity.owner_user_id !== req.user!.id) {
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
  
  const isOwner = ownershipCheck.rows[0].owner_user_id === req.user!.id;
  if (!isOwner) {
    throw new ForbiddenError('Only the owner can edit this opportunity');
  }
  
  // Get existing opportunity to check type when status is being changed
  const existingOpp = await pool.query(
    'SELECT type, external_link_optional FROM opportunities WHERE id = $1',
    [id]
  );
  const existingType = data.type || existingOpp.rows[0].type;
  const existingLink = existingOpp.rows[0].external_link_optional;
  const newLink = data.external_link_optional !== undefined ? data.external_link_optional : existingLink;
  
  // Additional validation for published polls/surveys (M6 requirement)
  if (data.status === 'published' && (existingType === 'poll' || existingType === 'survey')) {
    if (!newLink || !validateUrl(newLink)) {
      throw new ValidationError('External link is required for published polls and surveys');
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
    
    // Check ownership
    if (existingOpportunity.owner_user_id !== req.user!.id) {
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
  
  const isOwner = ownershipCheck.rows[0].owner_user_id === req.user!.id;
  if (!isOwner) {
    throw new ForbiddenError('Only the owner can delete this opportunity');
  }
  
  await pool.query('DELETE FROM opportunities WHERE id = $1', [id]);
  
  res.status(204).send();
}));

// GET /api/opportunities/:id/sessions - Get sessions for an opportunity
router.get('/:id/sessions', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id: opportunityId } = req.params;
    const { from, include_past } = req.query;
    
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
    
    // Check if opportunity exists and user has access
    const opportunityCheck = await pool.query(`
      SELECT o.*, u.name as owner_name, u.email as owner_email
      FROM opportunities o
      JOIN users u ON o.owner_user_id = u.id
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
    
    // Build query for sessions
    let query = `
      SELECT *, (capacity - booked_count) as remaining
      FROM sessions 
      WHERE opportunity_id = $1
    `;
    const params: string[] = [opportunityId];
    let paramCount = 1;
    
    // Filter by start time if provided
    if (from) {
      paramCount++;
      query += ` AND start_time >= $${paramCount}`;
      params.push(from);
    }
    
    // Filter out past sessions unless explicitly requested
    if (include_past !== 'true') {
      query += ` AND end_time >= NOW()`;
    }
    
    query += ` ORDER BY start_time ASC`;
    
    const result = await pool.query(query, params);
    
    // Serialize dates for API response
    const sessions = result.rows.map(session => ({
      ...session,
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
      
      // Check ownership
      if (opportunity.owner_user_id !== req.user!.id) {
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
    
    const isOwner = opportunityCheck.rows[0].owner_user_id === req.user!.id;
    if (!isOwner) {
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
      
      // Check ownership
      if (opportunity.owner_user_id !== req.user!.id) {
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
    
    const isOwner = opportunityCheck.rows[0].owner_user_id === req.user!.id;
    if (!isOwner) {
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

    // Only allow click tracking for poll or survey types
    if (opportunity.type !== 'poll' && opportunity.type !== 'survey') {
      throw new ValidationError('Click tracking is only available for polls and surveys');
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
