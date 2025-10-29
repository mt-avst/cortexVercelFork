/**
 * GET /api/auth/admin-login
 * Admin login
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const demoAdmin = {
    id: '633608bc-4b0e-4d60-a498-e680ee97c252',
    name: 'Test Admin',
    email: 'admin@test.com',
    business_unit: 'Research',
    role_title: 'Research Manager',
    role: 'researcher_admin', // CRITICAL: Must be 'researcher_admin', NOT 'employee'
  };

  // Clear any existing session cookies first (including demo user cookies)
  // This ensures no stale cookies interfere
  const existingCookies = res.getHeader('Set-Cookie') || [];
  const cookieArray = Array.isArray(existingCookies) ? existingCookies : [existingCookies];
  cookieArray.push(`adaptalabs_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.vercel.app; expires=Thu, 01 Jan 1970 00:00:00 GMT`);
  cookieArray.push(`adaptalabs_session=; HttpOnly; Secure; SameSite=None; Path=/; Domain=.vercel.app; expires=Thu, 01 Jan 1970 00:00:00 GMT`);
  cookieArray.push(`adaptalabs_session=; HttpOnly; Secure; SameSite=Lax; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`);
  cookieArray.push(`adaptalabs_session=; HttpOnly; Secure; SameSite=None; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`);

  // Set new session cookie without domain restriction
  // CRITICAL: JSON must be URL encoded for cookie value to handle special characters
  const sessionCookie = encodeURIComponent(JSON.stringify(demoAdmin));
  cookieArray.push(`adaptalabs_session=${sessionCookie}; HttpOnly; Secure; SameSite=None; Path=/`);
  res.setHeader('Set-Cookie', cookieArray);
  
  // Redirect to admin dashboard
  const frontendUrl = process.env.FRONTEND_URL || 'https://adapta-labs-p62q.vercel.app';
  res.redirect(`${frontendUrl}/admin`);
};

