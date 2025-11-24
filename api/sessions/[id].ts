import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { requireAuth } from '../utils/auth';
import { createErrorResponse, getErrorMessage } from '../utils/errors';

/**
 * DELETE /api/sessions/:id
 * Delete a session by ID
 * 
 * Requires admin authentication
 * Cannot delete sessions with existing bookings
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'DELETE') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    // Require authentication (admin)
    const user = requireAuth(req);
    
    // Check if user is admin
    if (user.role !== 'researcher_admin' && user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Admin access required'));
    }

    // Get session ID from query params (Vercel dynamic routes)
    const sessionId = req.query.id as string;
    
    if (!sessionId) {
      return res.status(400).json(createErrorResponse('Session ID is required'));
    }

    // Check session ownership through opportunity
    const ownershipCheck = await query(
      `SELECT o.owner_user_id 
       FROM sessions s 
       JOIN opportunities o ON s.opportunity_id = o.id 
       WHERE s.id = $1`,
      [sessionId]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(404).json(createErrorResponse('Session not found'));
    }

    // Check if user owns the opportunity
    if (ownershipCheck.rows[0].owner_user_id !== user.id) {
      return res.status(403).json(createErrorResponse('Only the owner can delete this session'));
    }

    // Check if session has bookings
    const sessionCheck = await query(
      'SELECT booked_count FROM sessions WHERE id = $1',
      [sessionId]
    );

    if (sessionCheck.rows[0].booked_count > 0) {
      return res.status(400).json(
        createErrorResponse('Cannot delete session with existing bookings')
      );
    }

    // Delete the session
    await query('DELETE FROM sessions WHERE id = $1', [sessionId]);

    return res.status(204).send();
  } catch (error: unknown) {
    // Handle auth errors
    if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
      return res.status(401).json(createErrorResponse(
        typeof error === 'object' && 'error' in error 
          ? String(error.error) 
          : 'Not authenticated'
      ));
    }

    console.error('Error deleting session:', error);
    const errorMessage = getErrorMessage(error);
    return res.status(500).json(
      createErrorResponse('Failed to delete session', errorMessage)
    );
  }
}
