import { Router, Request, Response } from 'express';
import { pool } from '../config';
import { requireAdmin, optionalAuth } from '../middleware/authenticate';
import { Session, CreateSessionRequest, UpdateSessionRequest } from '../types';
import { getMockOpportunity, addMockOpportunity } from '../../../demo/mock-data';

const router: Router = Router();

// Helper function to check if database is available
const isDatabaseAvailable = async (): Promise<boolean> => {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    console.log('Database not available, using mock data');
    return false;
  }
};

// Helper function to check session ownership
const checkSessionOwnership = async (sessionId: string, userId: string): Promise<boolean> => {
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
  client?: any
): Promise<boolean> => {
  let query = `
    SELECT COUNT(*) as overlap_count
    FROM sessions 
    WHERE opportunity_id = $1 
    AND (
      (start_time < $3 AND end_time > $2)
    )
  `;
  const params: any[] = [opportunityId, startTime, endTime];
  
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

// GET /api/opportunities/:id/sessions - List sessions for an opportunity
router.get('/opportunities/:id/sessions', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { id: opportunityId } = req.params;
    const { from, include_past } = req.query;
    
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      return res.json([]); // Return empty array for mock mode
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
    const isAdmin = req.user?.role === 'researcher_admin';
    
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
    const params: any[] = [opportunityId];
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
    
    // Auto-close opportunity if all sessions are past
    await autoCloseOpportunityIfNeeded(opportunityId);
    
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
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// POST /api/opportunities/:id/sessions - Create sessions for an opportunity
router.post('/opportunities/:id/sessions', requireAdmin, async (req: Request, res: Response) => {
  try {
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      return res.status(503).json({ error: 'Database not available. Please set up PostgreSQL to create sessions.' });
    }
    
    const { id: opportunityId } = req.params;
    const sessionsData = req.body;
    
    // Handle both single session and array of sessions
    const sessions = Array.isArray(sessionsData) ? sessionsData : [sessionsData];
    
    if (sessions.length === 0) {
      return res.status(400).json({ error: 'At least one session is required' });
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
    
    // Optional: Check calendar conflicts if calendar service is available
    try {
      const calendarService = require('../services/calendar').default;
      const timeSlots = sessions.map(session => ({
        start_time: session.start_time,
        end_time: session.end_time
      }));
      
      const conflictsResult = await calendarService.checkTimeSlotAvailability(
        new Date(sessions[0].start_time),
        new Date(sessions[sessions.length - 1].end_time),
        sessions[0].capacity || 30 // Use capacity as duration fallback
      );
      
      if (!conflictsResult.success) {
        console.warn('Calendar conflict check failed:', conflictsResult.error);
        // Continue with session creation even if calendar check fails
      }
    } catch (error) {
      console.warn('Calendar service not available for conflict checking');
      // Continue with session creation
    }
    
    // Create sessions in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Check for overlaps with existing sessions INSIDE the transaction
      // This prevents race conditions where another request creates overlapping sessions
      // between the initial check and the actual creation
      for (const session of sessions) {
        const startTime = new Date(session.start_time);
        const endTime = new Date(session.end_time);
        
        const hasOverlap = await checkSessionOverlaps(opportunityId, startTime, endTime, undefined, client);
        if (hasOverlap) {
          await client.query('ROLLBACK');
          return res.status(409).json({ 
            error: 'Session overlaps with existing sessions' 
          });
        }
      }
      
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
    console.error('Error creating sessions:', error);
    res.status(500).json({ error: 'Failed to create sessions' });
  }
});

// PATCH /api/sessions/:id - Update a session
router.patch('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      return res.status(503).json({ error: 'Database not available. Please set up PostgreSQL to edit sessions.' });
    }
    
    const { id: sessionId } = req.params;
    const data: UpdateSessionRequest = req.body;
    
    // Validate data
    const errors = validateSessionData(data);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    
    // Check session ownership
    const isOwner = await checkSessionOwnership(sessionId, req.user!.id);
    if (!isOwner) {
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
    const values: any[] = [];
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
    console.error('Error updating session:', error);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// DELETE /api/sessions/:id - Delete a session
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      return res.status(503).json({ error: 'Database not available. Please set up PostgreSQL to delete sessions.' });
    }
    
    const { id: sessionId } = req.params;
    
    // Check session ownership
    const isOwner = await checkSessionOwnership(sessionId, req.user!.id);
    if (!isOwner) {
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
    console.error('Error deleting session:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// POST /api/opportunities/:id/duplicate - Duplicate opportunity
router.post('/opportunities/:id/duplicate', requireAdmin, async (req: Request, res: Response) => {
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
      
      // Check ownership
      if (existingOpportunity.owner_user_id !== req.user!.id) {
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
    
    if (ownershipCheck.rows[0].owner_user_id !== req.user!.id) {
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
    console.error('Error duplicating opportunity:', error);
    res.status(500).json({ error: 'Failed to duplicate opportunity' });
  }
});

// POST /api/opportunities/:id/close-if-past - Utility to close opportunity if all sessions are past
router.post('/opportunities/:id/close-if-past', requireAdmin, async (req: Request, res: Response) => {
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
    
    const isOwner = opportunityCheck.rows[0].owner_user_id === req.user!.id;
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the owner can close this opportunity' });
    }
    
    await autoCloseOpportunityIfNeeded(opportunityId);
    
    res.json({ message: 'Opportunity auto-close check completed' });
  } catch (error) {
    console.error('Error checking opportunity auto-close:', error);
    res.status(500).json({ error: 'Failed to check opportunity auto-close' });
  }
});

// DELETE /api/opportunities/:id/sessions - Delete all sessions for an opportunity
router.delete('/opportunities/:id/sessions', requireAdmin, async (req: Request, res: Response) => {
  try {
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      return res.status(503).json({ error: 'Database not available. Please set up PostgreSQL to delete sessions.' });
    }
    
    const { id: opportunityId } = req.params;
    
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
      return res.status(403).json({ error: 'Only the owner can delete sessions for this opportunity' });
    }
    
    // Check if any sessions have bookings
    const sessionsWithBookings = await pool.query(`
      SELECT s.id, s.start_time, s.end_time, s.booked_count
      FROM sessions s
      WHERE s.opportunity_id = $1 AND s.booked_count > 0
    `, [opportunityId]);
    
    if (sessionsWithBookings.rows.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete sessions with existing bookings',
        details: {
          sessions_with_bookings: sessionsWithBookings.rows.length,
          sessions: sessionsWithBookings.rows.map(s => ({
            id: s.id,
            start_time: s.start_time.toISOString(),
            end_time: s.end_time.toISOString(),
            booked_count: s.booked_count
          }))
        }
      });
    }
    
    // Delete all sessions for the opportunity
    const deleteResult = await pool.query(
      'DELETE FROM sessions WHERE opportunity_id = $1 RETURNING id',
      [opportunityId]
    );
    
    res.json({ 
      message: `Successfully deleted ${deleteResult.rows.length} sessions`,
      deleted_count: deleteResult.rows.length
    });
  } catch (error) {
    console.error('Error deleting all sessions:', error);
    res.status(500).json({ error: 'Failed to delete sessions' });
  }
});

export default router;
