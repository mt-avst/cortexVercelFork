import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/opportunities
 * Returns empty array for now (no database)
 * POST /api/opportunities
 * Creates a new opportunity
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    console.log('Opportunities endpoint called - GET');
    
    // Return empty array - the app will show "No studies available"
    return res.status(200).json([]);
  }
  
  if (req.method === 'POST') {
    console.log('Opportunities endpoint called - POST', req.body);
    
    // Generate a temporary ID for the opportunity
    const opportunity = {
      id: `temp-${Date.now()}`,
      ...req.body,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    
    // Return the created opportunity
    return res.status(201).json(opportunity);
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}

