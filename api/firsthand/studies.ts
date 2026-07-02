import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createErrorResponse } from '../utils/errors';
import { parseSessionCookie } from '../utils/auth';
import { isFirstHandConfigured, firstHandGet } from '../utils/firsthand';
import { FirstHandStudy } from '../../shared/types';

/**
 * GET /api/firsthand/studies
 * Proxy the FirstHand study list for the Cortex study picker.
 * Auth: admin only.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  const user = parseSessionCookie(req);
  if (!user) {
    return res.status(401).json(createErrorResponse('Authentication required'));
  }
  if (user.role !== 'researcher_admin' && user.role !== 'superadmin') {
    return res.status(403).json(createErrorResponse('Admin access required'));
  }

  if (!isFirstHandConfigured()) {
    return res.status(503).json({ error: 'firsthand_not_configured', studies: [] });
  }

  try {
    const data = await firstHandGet<{ studies: FirstHandStudy[] }>('/api/studies');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json(createErrorResponse('Failed to fetch studies from FirstHand'));
  }
}
