import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';
import { createErrorResponse, getErrorMessage } from '../utils/errors';
import { requireAuth } from '../utils/auth';
import { logger } from '../utils/logger';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'DELETE') {
    return handleDelete(req, res);
  } else {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }
}

// DELETE /api/feedback/[id] - Delete feedback (superadmin only)
async function handleDelete(req: VercelRequest, res: VercelResponse) {
  try {
    // Require authentication
    const user = requireAuth(req);
    
    // Check superadmin role
    if (user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Superadmin access required'));
    }

    const { id } = req.query;
    
    if (!id || typeof id !== 'string') {
      return res.status(400).json(createErrorResponse('Feedback ID is required'));
    }

    const pool = getPool();
    
    const result = await pool.query(
      `DELETE FROM feedback WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json(createErrorResponse('Feedback not found'));
    }

    logger.info('Feedback deleted', { id });
    return res.status(200).json({ success: true });
  } catch (error: unknown) {
    // Handle auth errors
    if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
      return res.status(401).json(createErrorResponse(
        typeof error === 'object' && 'error' in error 
          ? String(error.error) 
          : 'Not authenticated'
      ));
    }
    
    logger.error('Error deleting feedback', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      id: req.query.id,
    });
    const errorMessage = getErrorMessage(error);
    return res.status(500).json(createErrorResponse('Failed to delete feedback', errorMessage));
  }
}

