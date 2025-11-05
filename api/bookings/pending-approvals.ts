import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createErrorResponse, getErrorMessage } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * GET /api/bookings/pending-approvals
 * Get pending approval bookings for admin
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }
    
    // Return empty array for now (no bookings yet)
    return res.status(200).json([]);
  } catch (error: unknown) {
    logger.error('Error in pending approvals handler', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    const errorMessage = getErrorMessage(error);
    return res.status(500).json(
      createErrorResponse('Internal server error', errorMessage)
    );
  }
}

