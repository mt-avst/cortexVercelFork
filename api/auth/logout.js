/**
 * POST /api/auth/logout
 * Logout - clear session cookie
 */
module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

  console.log('Logout endpoint called');
  
  // Clear the session cookie
  res.setHeader('Set-Cookie', 'adaptalabs_session=; HttpOnly; Secure; SameSite=None; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT');
  
  // Return success
  return res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error in logout handler:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

