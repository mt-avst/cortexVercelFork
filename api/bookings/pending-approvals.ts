import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/bookings/pending-approvals
 * Get pending approval bookings for admin
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  console.log('Pending approvals endpoint called');
  
  // Return empty array for now (no bookings yet)
  return res.status(200).json([]);
}

