import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/opportunities
 * Returns empty array for now (no database)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  console.log('Opportunities endpoint called');
  
  // Return empty array - the app will show "No studies available"
  res.status(200).json([]);
}

