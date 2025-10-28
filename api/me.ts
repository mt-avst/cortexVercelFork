import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/me
 * Get current user from session cookie
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Try to get user from cookie
  const cookies = req.headers.cookie || '';
  const sessionMatch = cookies.match(/adaptalabs_session=([^;]+)/);
  
  if (!sessionMatch) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  try {
    // Parse the session cookie directly (it's JSON string)
    const sessionData = decodeURIComponent(sessionMatch[1]);
    const user = JSON.parse(sessionData);
    res.status(200).json(user);
  } catch (error) {
    console.error('Error parsing session:', error);
    return res.status(401).json({ error: 'Invalid session' });
  }
}

