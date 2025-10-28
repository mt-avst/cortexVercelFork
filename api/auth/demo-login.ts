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
    role: 'employee',
  };

  // Set session cookie with proper encoding
  const sessionCookie = JSON.stringify(demoUser);
  // Domain should match vercel.app to work across all subdomains
  res.setHeader('Set-Cookie', `adaptalabs_session=${sessionCookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.vercel.app`);
  
  // Redirect to frontend
  const frontendUrl = process.env.FRONTEND_URL || 'https://adapta-labs-p62q.vercel.app';
  res.redirect(frontendUrl);
}

