import { Router, Request, Response } from 'express';
import { pool } from '../config';
import { requireAdmin, optionalAuth } from '../middleware/authenticate';
import { asyncHandler, ValidationError, NotFoundError, ForbiddenError, ConflictError } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { isDatabaseAvailable } from '../utils/database';
import { autoCloseOpportunityIfNeeded } from '../utils/opportunityLifecycle';
import { validateSessionData } from '../validation/schemas';
import { Session, CreateSessionRequest, UpdateSessionRequest } from '../types';
import { getMockOpportunity, addMockSessions, getMockSessions, getAllMockSessions, updateMockSession, deleteMockSession } from '../../../demo/mock-data';
import { isOpportunityOwner } from '../utils/opportunityOwnership';

const router: Router = Router();

// Helper function to check session ownership (superadmin can access any)
const checkSessionOwnership = async (sessionId: string, userId: string, userRole: string): Promise<boolean> => {
  // Superadmins can access any session
  if (userRole === 'superadmin') {
    const result = await pool.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
    return result.rows.length > 0;
  }
  
  const result = await pool.query(`
    SELECT o.owner_user_id 
    FROM sessions s 
    JOIN opportunities o ON s.opportunity_id = o.id 
    WHERE s.id = $1
  `, [sessionId]);
  
  return isOpportunityOwner(result.rows[0], { id: userId });
};

// Helper function to check for overlapping sessions
const checkSessionOverlaps = async (
  opportunityId: string, 
  startTime: Date, 
  endTime: Date, 
  excludeSessionId?: string,
  client?: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }
): Promise<boolean> => {
  let query = `
    SELECT COUNT(*) as overlap_count
    FROM sessions 
    WHERE opportunity_id = $1 
    AND (
      (start_time < $3 AND end_time > $2)
    )
  `;
  const params: (string | Date)[] = [opportunityId, startTime, endTime];
  
  if (excludeSessionId) {
    query += ` AND id != $4`;
    params.push(excludeSessionId);
  }
  
  const result = client ? await client.query(query, params) : await pool.query(query, params);
  return parseInt(result.rows[0].overlap_count) > 0;
};

// Helper function to format time for error messages
const formatTime = (dateString: string): string => {
  return new Date(dateString).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
};

// POST /api/sessions - Create sessions for an opportunity
router.post('/', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { opportunity_id, sessions } = req.body;
  
  if (!opportunity_id) {
    throw new ValidationError('opportunity_id is required');
  }
  
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new ValidationError('sessions array is required and must not be empty');
  }
  
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    const opportunity = getMockOpportunity(opportunity_id);
    if (!opportunity) {
      throw new NotFoundError('Opportunity');
    }
    
    // Check ownership (superadmins can add sessions to any)
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && !isOpportunityOwner(opportunity, req.user)) {
      throw new ForbiddenError('Only the owner can add sessions to this opportunity');
    }
    
    // Validate all sessions
    const validationErrors: string[] = [];
    sessions.forEach((session: CreateSessionRequest, index: number) => {
      const errors = validateSessionData(session);
      errors.forEach(error => validationErrors.push(`Session ${index + 1}: ${error}`));
    });
    
    if (validationErrors.length > 0) {
      throw new ValidationError('Validation failed', validationErrors);
    }
    
    // Create mock sessions
    const createdSessions = addMockSessions(opportunity_id, sessions);
    
    return res.status(201).json(createdSessions);
  }
  
  // Check opportunity ownership
  const opportunityCheck = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [opportunity_id]
  );
  
  if (opportunityCheck.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }
  
  // Check ownership (superadmins can add sessions to any)
  const isOwner = isOpportunityOwner(opportunityCheck.rows[0], req.user);
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOwner) {
    throw new ForbiddenError('Only the owner can add sessions to this opportunity');
  }
  
  // Validate all sessions
  const validationErrors: string[] = [];
  sessions.forEach((session: CreateSessionRequest, index: number) => {
    const errors = validateSessionData(session);
    errors.forEach(error => validationErrors.push(`Session ${index + 1}: ${error}`));
  });
  
  if (validationErrors.length > 0) {
    throw new ValidationError('Validation failed', validationErrors);
  }
  
  // Check for overlapping sessions
  for (const session of sessions) {
    const startTime = new Date(session.start_time);
    const endTime = new Date(session.end_time);
    const hasOverlap = await checkSessionOverlaps(opportunity_id, startTime, endTime);
    if (hasOverlap) {
      throw new ConflictError(`Session overlaps with existing sessions: ${formatTime(session.start_time)} - ${formatTime(session.end_time)}`);
    }
  }
  
  // Insert sessions into database
  const createdSessions = [];
  for (const session of sessions) {
    const result = await pool.query(
      `INSERT INTO sessions (
        opportunity_id,
        start_time,
        end_time,
        capacity,
        booked_count,
        location_or_meet_link_optional
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *, (capacity - booked_count) as remaining`,
      [
        opportunity_id,
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
    });
  }
  
  // Auto-close opportunity if needed
  await autoCloseOpportunityIfNeeded(opportunity_id);
  
  res.status(201).json(createdSessions);
}));

// PATCH /api/sessions/:id - Update a session
router.patch('/:id', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { id: sessionId } = req.params;
  const data: UpdateSessionRequest = req.body;
  
  // Validate data
  const errors = validateSessionData(data);
  if (errors.length > 0) {
    throw new ValidationError('Validation failed', errors);
  }
  
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    const sessions = getAllMockSessions(); // Get all sessions
    const session = sessions.find(s => s.id === sessionId);
    
    if (!session) {
      throw new NotFoundError('Session');
    }
    
    // Check ownership through opportunity (superadmins can edit any)
    const opportunity = getMockOpportunity(session.opportunity_id);
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!opportunity || (!isSuperadmin && !isOpportunityOwner(opportunity, req.user))) {
      throw new ForbiddenError('Only the owner can edit this session');
    }
    
    // Update mock session
    const updatedSession = updateMockSession(sessionId, data);
    if (!updatedSession) {
      throw new NotFoundError('Session');
    }
    
    return res.json(updatedSession);
  }
  
  // Check session ownership (superadmins can edit any)
  const hasAccess = await checkSessionOwnership(sessionId, req.user!.id, req.user!.role);
  if (!hasAccess) {
    throw new ForbiddenError('Only the owner can edit this session');
  }
  
  // Get current session data
  const currentSession = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
  if (currentSession.rows.length === 0) {
    throw new NotFoundError('Session');
  }
  
  const currentSessionData = currentSession.rows[0];
  
  // Check capacity constraint
  if (data.capacity !== undefined && data.capacity < currentSessionData.booked_count) {
    throw new ValidationError(`Cannot reduce capacity below current bookings (${currentSessionData.booked_count})`);
  }
  
  // Use transaction to prevent race conditions during overlap check and update
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check for overlaps if time is being changed (inside transaction)
    if (data.start_time || data.end_time) {
      const startTime = data.start_time ? new Date(data.start_time) : new Date(currentSessionData.start_time);
      const endTime = data.end_time ? new Date(data.end_time) : new Date(currentSessionData.end_time);
      
      const hasOverlap = await checkSessionOverlaps(currentSessionData.opportunity_id, startTime, endTime, sessionId, client);
      if (hasOverlap) {
        await client.query('ROLLBACK');
        throw new ConflictError('Updated session time overlaps with existing sessions');
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
        values.push(value);
      }
    });
    
      if (updateFields.length === 0) {
        await client.query('ROLLBACK');
        throw new ValidationError('No fields to update');
      }
      
      paramCount++;
      values.push(sessionId);
      
      const query = `
        UPDATE sessions 
        SET ${updateFields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING *, (capacity - booked_count) as remaining
      `;
      
      const result = await client.query(query, values);
      
      await client.query('COMMIT');
      
      const updatedSession = {
        ...result.rows[0],
        start_time: result.rows[0].start_time.toISOString(),
        end_time: result.rows[0].end_time.toISOString(),
        created_at: result.rows[0].created_at.toISOString(),
        updated_at: result.rows[0].updated_at.toISOString(),
      };
      
      res.json(updatedSession);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
}));

// DELETE /api/sessions/:id - Delete a session
router.delete('/:id', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { id: sessionId } = req.params;
  
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    const sessions = getAllMockSessions(); // Get all sessions
    const session = sessions.find(s => s.id === sessionId);
    
    if (!session) {
      throw new NotFoundError('Session');
    }
    
    // Check ownership through opportunity (superadmins can delete any)
    const opportunity = getMockOpportunity(session.opportunity_id);
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!opportunity || (!isSuperadmin && !isOpportunityOwner(opportunity, req.user))) {
      throw new ForbiddenError('Only the owner can delete this session');
    }
    
    // Delete mock session
    const deleted = deleteMockSession(sessionId);
    if (!deleted) {
      throw new NotFoundError('Session');
    }
    
    return res.status(204).send();
  }
  
  // Check session ownership (superadmins can delete any)
  const hasAccess = await checkSessionOwnership(sessionId, req.user!.id, req.user!.role);
  if (!hasAccess) {
    throw new ForbiddenError('Only the owner can delete this session');
  }
  
  // Check if session has bookings
  const sessionCheck = await pool.query('SELECT booked_count FROM sessions WHERE id = $1', [sessionId]);
  if (sessionCheck.rows.length === 0) {
    throw new NotFoundError('Session');
  }
  
  if (sessionCheck.rows[0].booked_count > 0) {
    throw new ValidationError('Cannot delete session with existing bookings');
  }
  
  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  
  res.status(204).send();
}));

// POST /api/sessions/sync-booked-counts - Sync booked_count with actual bookings (admin only)
router.post('/sync-booked-counts', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  logger.info('Starting booked_count sync');
  
  // Get all sessions
  const sessionsResult = await pool.query('SELECT id FROM sessions');
  
  let syncedCount = 0;
  
  for (const session of sessionsResult.rows) {
    // Count actual active bookings for this session
    const bookingsResult = await pool.query(
      'SELECT COUNT(*) as count FROM bookings WHERE session_id = $1 AND status = $2',
      [session.id, 'booked']
    );
    
    const actualCount = parseInt(bookingsResult.rows[0].count);
    
    // Update booked_count to match actual bookings
    await pool.query(
      'UPDATE sessions SET booked_count = $1 WHERE id = $2',
      [actualCount, session.id]
    );
    
    syncedCount++;
  }
  
  logger.info(`Sync complete: ${syncedCount} sessions updated`);
  res.json({ 
    message: `Successfully synced booked_count for ${syncedCount} sessions`,
    synced_count: syncedCount
  });
}));

export default router;
