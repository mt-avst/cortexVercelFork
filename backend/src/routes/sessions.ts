import { Router, Request, Response } from 'express';
import { pool } from '../config';
import { requireAdmin, optionalAuth } from '../middleware/authenticate';
import { asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { Session, CreateSessionRequest, UpdateSessionRequest } from '../types';
import { getMockOpportunity, addMockOpportunity, addMockSessions, getMockSessions, getAllMockSessions, updateMockSession, deleteMockSession } from '../../../demo/mock-data';

const router: Router = Router();

// Helper function to check if database is available
const isDatabaseAvailable = async (): Promise<boolean> => {
  try {
    // Check if DATABASE_URL is set
    if (!process.env.DATABASE_URL) {
      logger.info('DATABASE_URL not set, using mock data');
      return false;
    }
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    logger.warn('Database not available, using mock data', { error: (error as Error).message });
    return false;
  }
};

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
  
  return result.rows.length > 0 && result.rows[0].owner_user_id === userId;
};

// Helper function to validate session data
const validateSessionData = (data: CreateSessionRequest | UpdateSessionRequest): string[] => {
  const errors: string[] = [];
  
  if ('start_time' in data && data.start_time !== undefined) {
    const startTime = new Date(data.start_time);
    if (isNaN(startTime.getTime())) {
      errors.push('Start time must be a valid ISO date string');
    }
  }
  
  if ('end_time' in data && data.end_time !== undefined) {
    const endTime = new Date(data.end_time);
    if (isNaN(endTime.getTime())) {
      errors.push('End time must be a valid ISO date string');
    }
  }
  
  if ('start_time' in data && 'end_time' in data && 
      data.start_time !== undefined && data.end_time !== undefined) {
    const startTime = new Date(data.start_time);
    const endTime = new Date(data.end_time);
    if (startTime >= endTime) {
      errors.push('End time must be after start time');
    }
  }
  
  if ('capacity' in data && data.capacity !== undefined) {
    if (!Number.isInteger(data.capacity) || data.capacity < 1 || data.capacity > 500) {
      errors.push('Capacity must be an integer between 1 and 500');
    }
  }
  
  return errors;
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

// Helper function to auto-close opportunity if all sessions are past
const autoCloseOpportunityIfNeeded = async (opportunityId: string): Promise<void> => {
  const result = await pool.query(`
    SELECT COUNT(*) as total_sessions,
           COUNT(CASE WHEN end_time < NOW() THEN 1 END) as past_sessions,
           status
    FROM sessions s
    JOIN opportunities o ON s.opportunity_id = o.id
    WHERE s.opportunity_id = $1
    GROUP BY o.status
  `, [opportunityId]);
  
  if (result.rows.length > 0) {
    const { total_sessions, past_sessions, status } = result.rows[0];
    if (total_sessions > 0 && past_sessions == total_sessions && status === 'published') {
      await pool.query(
        'UPDATE opportunities SET status = $1 WHERE id = $2',
        ['closed', opportunityId]
      );
    }
  }
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
  try {
    const { opportunity_id, sessions } = req.body;
    
    if (!opportunity_id) {
      return res.status(400).json({ error: 'opportunity_id is required' });
    }
    
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return res.status(400).json({ error: 'sessions array is required and must not be empty' });
    }
    
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      // Use mock data for development
      const opportunity = getMockOpportunity(opportunity_id);
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
      sessions.forEach((session: CreateSessionRequest, index: number) => {
        const errors = validateSessionData(session);
        errors.forEach(error => validationErrors.push(`Session ${index + 1}: ${error}`));
      });
      
      if (validationErrors.length > 0) {
        return res.status(400).json({ error: 'Validation failed', details: validationErrors });
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
    sessions.forEach((session: CreateSessionRequest, index: number) => {
      const errors = validateSessionData(session);
      errors.forEach(error => validationErrors.push(`Session ${index + 1}: ${error}`));
    });
    
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors });
    }
    
    // Check for overlapping sessions
    for (const session of sessions) {
      const startTime = new Date(session.start_time);
      const endTime = new Date(session.end_time);
      const hasOverlap = await checkSessionOverlaps(opportunity_id, startTime, endTime);
      if (hasOverlap) {
        return res.status(409).json({ 
          error: `Session overlaps with existing sessions: ${formatTime(session.start_time)} - ${formatTime(session.end_time)}` 
        });
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
    
    return res.status(201).json(createdSessions);
  } catch (error) {
    logger.error('Error creating sessions', { error });
    res.status(500).json({ error: 'Failed to create sessions' });
  }
}));

// PATCH /api/sessions/:id - Update a session
router.patch('/:id', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id: sessionId } = req.params;
    const data: UpdateSessionRequest = req.body;
    
    // Validate data
    const errors = validateSessionData(data);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      // Use mock data for development
      const sessions = getAllMockSessions(); // Get all sessions
      const session = sessions.find(s => s.id === sessionId);
      
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      // Check ownership through opportunity (superadmins can edit any)
      const opportunity = getMockOpportunity(session.opportunity_id);
      const isSuperadmin = req.user!.role === 'superadmin';
      if (!opportunity || (!isSuperadmin && opportunity.owner_user_id !== req.user!.id)) {
        return res.status(403).json({ error: 'Only the owner can edit this session' });
      }
      
      // Update mock session
      const updatedSession = updateMockSession(sessionId, data);
      if (!updatedSession) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      return res.json(updatedSession);
    }
    
    // Check session ownership (superadmins can edit any)
    const hasAccess = await checkSessionOwnership(sessionId, req.user!.id, req.user!.role);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Only the owner can edit this session' });
    }
    
    // Get current session data
    const currentSession = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    if (currentSession.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const currentSessionData = currentSession.rows[0];
    
    // Check capacity constraint
    if (data.capacity !== undefined && data.capacity < currentSessionData.booked_count) {
      return res.status(400).json({ 
        error: `Cannot reduce capacity below current bookings (${currentSessionData.booked_count})` 
      });
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
          return res.status(409).json({ 
            error: 'Updated session time overlaps with existing sessions' 
          });
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
        return res.status(400).json({ error: 'No fields to update' });
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
  } catch (error) {
    logger.error('Error updating session', { error });
    res.status(500).json({ error: 'Failed to update session' });
  }
}));

// DELETE /api/sessions/:id - Delete a session
router.delete('/:id', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id: sessionId } = req.params;
    
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      // Use mock data for development
      const sessions = getAllMockSessions(); // Get all sessions
      const session = sessions.find(s => s.id === sessionId);
      
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      // Check ownership through opportunity (superadmins can delete any)
      const opportunity = getMockOpportunity(session.opportunity_id);
      const isSuperadmin = req.user!.role === 'superadmin';
      if (!opportunity || (!isSuperadmin && opportunity.owner_user_id !== req.user!.id)) {
        return res.status(403).json({ error: 'Only the owner can delete this session' });
      }
      
      // Delete mock session
      const deleted = deleteMockSession(sessionId);
      if (!deleted) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      return res.status(204).send();
    }
    
    // Check session ownership (superadmins can delete any)
    const hasAccess = await checkSessionOwnership(sessionId, req.user!.id, req.user!.role);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Only the owner can delete this session' });
    }
    
    // Check if session has bookings
    const sessionCheck = await pool.query('SELECT booked_count FROM sessions WHERE id = $1', [sessionId]);
    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    if (sessionCheck.rows[0].booked_count > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete session with existing bookings' 
      });
    }
    
    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    
    res.status(204).send();
  } catch (error) {
    logger.error('Error deleting session', { error });
    res.status(500).json({ error: 'Failed to delete session' });
  }
}));

// POST /api/opportunities/:id/duplicate - Duplicate opportunity
router.post('/opportunities/:id/duplicate', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  try {
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      // Use mock data for development
      const { id } = req.params;
      
      // Check if opportunity exists
      const existingOpportunity = getMockOpportunity(id);
      if (!existingOpportunity) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      
      // Check ownership (superadmins can duplicate any)
      const isSuperadmin = req.user!.role === 'superadmin';
      if (!isSuperadmin && existingOpportunity.owner_user_id !== req.user!.id) {
        return res.status(403).json({ error: 'Only the owner can duplicate this opportunity' });
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
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    
    // Check ownership (superadmins can duplicate any)
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && ownershipCheck.rows[0].owner_user_id !== req.user!.id) {
      return res.status(403).json({ error: 'Only the owner can duplicate this opportunity' });
    }
    
    // Get the original opportunity
    const original = await pool.query('SELECT * FROM opportunities WHERE id = $1', [id]);
    if (original.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
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
    
  } catch (error) {
    logger.error('Error duplicating opportunity', { error });
    res.status(500).json({ error: 'Failed to duplicate opportunity' });
  }
}));

// POST /api/opportunities/:id/close-if-past - Utility to close opportunity if all sessions are past
router.post('/opportunities/:id/close-if-past', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id: opportunityId } = req.params;
    
    // Check opportunity ownership
    const opportunityCheck = await pool.query(
      'SELECT owner_user_id FROM opportunities WHERE id = $1',
      [opportunityId]
    );
    
    if (opportunityCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    
    // Check ownership (superadmins can close any)
    const isOwner = opportunityCheck.rows[0].owner_user_id === req.user!.id;
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && !isOwner) {
      return res.status(403).json({ error: 'Only the owner can close this opportunity' });
    }
    
    await autoCloseOpportunityIfNeeded(opportunityId);
    
    res.json({ message: 'Opportunity auto-close check completed' });
  } catch (error) {
    logger.error('Error checking opportunity auto-close', { error });
    res.status(500).json({ error: 'Failed to check opportunity auto-close' });
  }
}));

// POST /api/sessions/sync-booked-counts - Sync booked_count with actual bookings (admin only)
router.post('/sync-booked-counts', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  try {
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
  } catch (error) {
    logger.error('Error syncing booked_count', { error });
    res.status(500).json({ error: 'Failed to sync booked_count' });
  }
}));

export default router;
