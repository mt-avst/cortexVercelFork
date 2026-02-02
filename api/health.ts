import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/health
 * Health/readiness check for deployment verification.
 * Returns JSON so smoke tests can confirm API is deployed (not HTML).
 * Does not check DB so it works before DATABASE_URL is set.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  return res.status(200).json({ ok: true });
}
