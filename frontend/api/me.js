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
  
  // Parse all cookies to find the session cookie
  // Look for the LAST occurrence in case there are multiple (prefer most recently set)
  const cookiePairs = cookies.split(';').map(c => c.trim());
  let sessionData = null;
  
  // Find session cookie (check from end to get most recent)
  for (let i = cookiePairs.length - 1; i >= 0; i--) {
    const pair = cookiePairs[i];
    if (pair.startsWith('adaptalabs_session=')) {
      sessionData = pair.substring('adaptalabs_session='.length);
      break;
    }
  }
  
  if (!sessionData) {
    console.log('No session cookie found');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  try {
    // Parse the session cookie - it's already JSON string
    // URL decode in case it was encoded
    const decodedData = decodeURIComponent(sessionData);
    console.log('Session data (raw):', sessionData);
    console.log('Session data (decoded):', decodedData);
    const user = JSON.parse(decodedData);
    console.log('Parsed user:', user);
    
    // Validate role to prevent accidental admin assignment
    if (!user.role || typeof user.role !== 'string') {
      console.error('Invalid user role:', user.role);
      return res.status(401).json({ error: 'Invalid session - missing role' });
    }
    
    return res.status(200).json(user);
  } catch (error) {
    console.error('Error parsing session:', error);
    return res.status(401).json({ error: 'Invalid session', details: String(error) });
  }
};

