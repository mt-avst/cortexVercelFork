import { Router, Request, Response } from 'express';

import { pool } from '../config';
import { requireAdmin, optionalAuth } from '../middleware/authenticate';
import { getMockOpportunities, getMockOpportunity, addMockOpportunity, updateMockOpportunity, deleteMockOpportunity } from '../../../demo/mock-data';
import { logger } from '../utils/logger';
import { 
  CreateOpportunitySchema, 
  UpdateOpportunitySchema, 
  OpportunityQuerySchema,
  validateRequest,
  validateQuery 
} from '../validation/schemas';
import { AppError, ValidationError, NotFoundError, ForbiddenError, asyncHandler } from '../utils/errorHandler';

import { Opportunity, CreateOpportunityRequest, UpdateOpportunityRequest } from '../types';

const router: Router = Router();

// Helper function to check if database is available
const isDatabaseAvailable = async (): Promise<boolean> => {
  try {
    // Check if DATABASE_URL is set
    if (!process.env.DATABASE_URL) {
      console.log('DATABASE_URL not set, using mock data');
      return false;
    }
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    console.log('Database not available, using mock data:', (error as any).message);
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

const validateOpportunityData = (data: CreateOpportunityRequest | UpdateOpportunityRequest): string[] => {
  const errors: string[] = [];
  
  if ('title' in data && data.title !== undefined) {
    const title = data.title.trim();
    if (title.length < 4 || title.length > 140) {
      errors.push('Title must be between 4 and 140 characters');
    }
  }
  
  if ('purpose_one_liner' in data && data.purpose_one_liner !== undefined) {
    const purpose = data.purpose_one_liner.trim();
    if (purpose.length < 10 || purpose.length > 180) {
      errors.push('Purpose must be between 10 and 180 characters');
    }
  }
  
  if ('default_duration_minutes' in data && data.default_duration_minutes !== undefined) {
    if (data.default_duration_minutes < 5 || data.default_duration_minutes > 240) {
      errors.push('Duration must be between 5 and 240 minutes');
    }
  }
  
  if ('type' in data && data.type !== undefined) {
    if (!['test', 'poll', 'survey'].includes(data.type)) {
      errors.push('Type must be test, poll, or survey');
    }
  }
  
  if ('status' in data && data.status !== undefined) {
    if (!['draft', 'published', 'closed'].includes(data.status)) {
      errors.push('Status must be draft, published, or closed');
    }
  }
  
  if ('external_link_optional' in data && data.external_link_optional !== undefined) {
    if (data.external_link_optional && !validateUrl(data.external_link_optional)) {
      errors.push('External link must be a valid URL');
    }
  }
  
  return errors;
};

// GET /api/opportunities - List opportunities
router.get('/', optionalAuth, (req: Request, res: Response) => {
  try {
    const { type, q, status } = req.query;
    const isAdmin = req.user?.role === 'researcher_admin';
    
    // Check if database is available (synchronously for now)
    const dbAvailable = process.env.DATABASE_URL ? true : false;
    
    if (!dbAvailable) {
      // Use mock data
      const filters: any = {};
      if (type) filters.type = type as string;
      if (q) filters.q = q as string;
      if (status) filters.status = status as string;
      else if (!isAdmin) filters.status = 'published'; // Default to published for non-admin
      
      const opportunities = getMockOpportunities(filters);
      res.json(opportunities);
      return;
    }
    
    // For now, always use mock data since database is not set up
    const filters: any = {};
    if (type) filters.type = type as string;
    if (q) filters.q = q as string;
    if (status) filters.status = status as string;
    else if (!isAdmin) filters.status = 'published'; // Default to published for non-admin
    
    const opportunities = getMockOpportunities(filters);
    res.json(opportunities);
  } catch (error) {
    console.error('Error in opportunities route:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/opportunities/:id - Get opportunity detail
router.get('/:id', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const isAdmin = req.user?.role === 'researcher_admin';
  
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
    const data: CreateOpportunityRequest = req.body;
    
    // Validate required fields
    if (!data.type || !data.title || !data.purpose_one_liner) {
      throw new ValidationError('Type, title, and purpose are required');
    }
    
    // Validate data
    const errors = validateOpportunityData(data);
    if (errors.length > 0) {
      throw new ValidationError('Validation failed', errors);
    }
    
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
  
  // Validate required fields
  if (!data.type || !data.title || !data.purpose_one_liner) {
    throw new ValidationError('Type, title, and purpose are required');
  }
  
  // Validate data
  const errors = validateOpportunityData(data);
  if (errors.length > 0) {
    throw new ValidationError('Validation failed', errors);
  }
  
  // Additional validation for published polls/surveys
  if (data.status === 'published' && ['poll', 'survey'].includes(data.type)) {
    if (!data.external_link_optional || !validateUrl(data.external_link_optional)) {
      throw new ValidationError('External link is required for published polls and surveys');
    }
  }
  
  const query = `
    INSERT INTO opportunities (
      type, title, purpose_one_liner, description_optional, 
      product_optional, default_duration_minutes, status, 
      owner_user_id, external_link_optional, participant_type_required, participant_type_specific_details
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
  `;
  
  const values = [
    data.type,
    data.title.trim(),
    data.purpose_one_liner.trim(),
    data.description_optional?.trim() || null,
    data.product_optional?.trim() || null,
    data.default_duration_minutes || 30,
    data.status || 'draft',
    req.user!.id,
    data.external_link_optional?.trim() || null,
    data.participant_type_required || 'any',
    data.participant_type_specific_details?.trim() || null
  ];
  
  const result = await pool.query(query, values);
  const opportunity = {
    ...result.rows[0],
    created_at: result.rows[0].created_at.toISOString(),
    updated_at: result.rows[0].updated_at.toISOString(),
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
    const { id } = req.params;
    const data: UpdateOpportunityRequest = req.body;
    
    // Validate data
    const errors = validateOpportunityData(data);
    if (errors.length > 0) {
      throw new ValidationError('Validation failed', errors);
    }
    
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
  
  // Validate data
  const errors = validateOpportunityData(data);
  if (errors.length > 0) {
    throw new ValidationError('Validation failed', errors);
  }
  
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
  
  // Additional validation for published polls/surveys
  if (data.status === 'published' && data.type && ['poll', 'survey'].includes(data.type)) {
    if (!data.external_link_optional || !validateUrl(data.external_link_optional)) {
      throw new ValidationError('External link is required for published polls and surveys');
    }
  }
  
  // Build dynamic update query
  const updateFields: string[] = [];
  const values: any[] = [];
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

export default router;
