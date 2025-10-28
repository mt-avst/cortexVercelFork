import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
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
  res.setHeader('Set-Cookie', `adaptalabs_session=${JSON.stringify(demoAdmin)}; HttpOnly; Secure; SameSite=Lax; Path=/`);

  // Redirect to admin dashboard (production URL)
  const frontendUrl = process.env.FRONTEND_URL || 'https://adapta-labs-p62q.vercel.app';
  res.redirect(`${frontendUrl}/admin`);
}

