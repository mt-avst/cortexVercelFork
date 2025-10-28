/**
 * GET /api/me
 * Get current user from session cookie
 */
module.exports = async function handler(req, res) {
  console.log('API /me called');
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Try to get user from cookie
  const cookies = req.headers.cookie || '';
  console.log('Cookies:', cookies);
  const sessionMatch = cookies.match(/adaptalabs_session=([^;]+)/);
  
  if (!sessionMatch) {
    console.log('No session cookie found');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  try {
    // Parse the session cookie - it's already JSON string
    const sessionData = sessionMatch[1];
    console.log('Session data:', sessionData);
    const user = JSON.parse(sessionData);
    console.log('Parsed user:', user);
    return res.status(200).json(user);
  } catch (error) {
    console.error('Error parsing session:', error);
    return res.status(401).json({ error: 'Invalid session', details: String(error) });
  }
};

