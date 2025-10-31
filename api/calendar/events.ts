import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createErrorResponse } from '../utils/errors';

/**
 * GET /api/calendar/events
 * Get calendar events
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }
    
    // Return empty array for calendar events (no bookings yet)
    return res.status(200).json([]);
  } catch (error: unknown) {
    console.error('Error in calendar events handler:', error);
    return res.status(500).json(createErrorResponse('Internal server error'));
  }
}

