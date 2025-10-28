import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
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

  // Set session cookie
  res.setHeader('Set-Cookie', `adaptalabs_session=${JSON.stringify(demoUser)}; HttpOnly; Secure; SameSite=Lax; Path=/`);

  // Redirect to frontend (production URL)
  const frontendUrl = process.env.FRONTEND_URL || 'https://adapta-labs-p62q.vercel.app';
  res.redirect(frontendUrl);
}

