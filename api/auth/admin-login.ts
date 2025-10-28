import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/auth/admin-login
 * Admin login
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const demoAdmin = {
    id: '633608bc-4b0e-4d60-a498-e680ee97c252',
    name: 'Test Admin',
    email: 'admin@test.com',
    business_unit: 'Research',
    role_title: 'Research Manager',
    role: 'researcher_admin',
  };

  // Set session cookie
  const sessionCookie = Buffer.from(JSON.stringify(demoAdmin)).toString('base64');
  res.setHeader('Set-Cookie', `adaptalabs_session=${sessionCookie}; HttpOnly; Secure; SameSite=Lax; Path=/`);
  
  // Redirect to admin dashboard
  const frontendUrl = process.env.FRONTEND_URL || 'https://adapta-labs-p62q.vercel.app';
  res.redirect(`${frontendUrl}/admin`);
}

