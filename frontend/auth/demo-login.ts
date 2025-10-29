import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/auth/demo-login
 * Demo user login
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const demoUser = {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'Demo User',
    email: 'demo@example.com',
    business_unit: 'Engineering',
    role_title: 'Software Engineer',
    role: 'employee', // CRITICAL: Must be 'employee', NOT 'researcher_admin'
  };

  // Clear any existing session cookies first (including admin cookies)
  // This ensures no stale cookies interfere
  const existingCookies = res.getHeader('Set-Cookie') || [];
  const cookieArray = Array.isArray(existingCookies) ? existingCookies : [existingCookies];
  cookieArray.push(`adaptalabs_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.vercel.app; expires=Thu, 01 Jan 1970 00:00:00 GMT`);
  cookieArray.push(`adaptalabs_session=; HttpOnly; Secure; SameSite=Lax; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`);
  
  // Set new session cookie with proper encoding
  // CRITICAL: JSON must be URL encoded for cookie value
  const sessionCookie = encodeURIComponent(JSON.stringify(demoUser));
  // Domain should match vercel.app to work across all subdomains
  cookieArray.push(`adaptalabs_session=${sessionCookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.vercel.app`);
  res.setHeader('Set-Cookie', cookieArray);
  
  // Redirect to frontend
  const frontendUrl = process.env.FRONTEND_URL || 'https://adapta-labs-p62q.vercel.app';
  res.redirect(frontendUrl);
}

