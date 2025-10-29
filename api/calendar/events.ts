import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/calendar/events
 * Get calendar events
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  console.log('Calendar events endpoint called', req.url);
  
  // Return empty array for calendar events (no bookings yet)
  return res.status(200).json([]);
}

