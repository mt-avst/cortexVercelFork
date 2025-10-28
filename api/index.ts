import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Main API handler for Vercel serverless functions
 * Handles all /api/* routes
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log('API handler called', { method: req.method, url: req.url, query: req.query });
  
  const urlPath = req.url || '';
  const pathParts = urlPath.split('/').filter(p => p && p !== 'api');
  
  console.log('Path parts:', pathParts);
  
  // Handle auth routes
  if (pathParts[0] === 'auth') {
    return handleAuth(req, res, pathParts.slice(1));
  }
  
  // Handle opportunities
  if (pathParts[0] === 'opportunities') {
    return handleOpportunities(req, res, pathParts.slice(1));
  }
  
  // Handle other API routes
  res.status(404).json({ error: 'Not found', path: pathParts });
}

async function handleAuth(req: VercelRequest, res: VercelResponse, path: string[]) {
  const isDemoLogin = path[0] === 'demo-login';
  const isAdminLogin = path[0] === 'admin-login';
  
  if (isDemoLogin || isAdminLogin) {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    
    const user = isAdminLogin ? {
      id: '633608bc-4b0e-4d60-a498-e680ee97c252',
      name: 'Test Admin',
      email: 'admin@test.com',
      business_unit: 'Research',
      role_title: 'Research Manager',
      role: 'researcher_admin',
    } : {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'Demo User',
      email: 'demo@example.com',
      business_unit: 'Engineering',
      role_title: 'Software Engineer',
      role: 'employee',
    };
    
    // Set session cookie
    const sessionCookie = Buffer.from(JSON.stringify(user)).toString('base64');
    res.setHeader('Set-Cookie', `adaptalabs_session=${sessionCookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=${process.env.COOKIE_DOMAIN || 'vercel.app'}`);
    
    // Redirect to frontend
    const frontendUrl = process.env.FRONTEND_URL || 'https://adapta-labs-p62q.vercel.app';
    const redirectPath = isAdminLogin ? '/admin' : '/';
    res.redirect(`${frontendUrl}${redirectPath}`);
    return;
  }
  
  res.status(404).json({ error: 'Auth route not found' });
}

async function handleOpportunities(req: VercelRequest, res: VercelResponse, path: string[]) {
  // Return mock data for now since we don't have a database
  if (req.method === 'GET' && path.length === 0) {
    // Return empty array - the app will show "No studies available"
    return res.status(200).json([]);
  }
  
  res.status(404).json({ error: 'Route not implemented' });
}

