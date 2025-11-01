import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../../db';
import { createErrorResponse, getErrorMessage } from '../../utils/errors';
import { parseSessionCookie } from '../../utils/auth';
import * as crypto from 'crypto';

/**
 * POST /api/opportunities/[id]/click
 * Track click for poll/survey opportunities (M6)
 * Auth: Optional (allows both authenticated and unauthenticated users)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    // Get opportunity ID from query params
    let opportunityId = req.query.id as string;
    
    // If not in query, try to parse from URL path
    if (!opportunityId && req.url) {
      const urlMatch = req.url.match(/\/opportunities\/([^\/]+)\/click/);
      if (urlMatch) {
        opportunityId = urlMatch[1];
      }
    }
    
    if (!opportunityId) {
      return res.status(400).json(createErrorResponse('Opportunity ID is required'));
    }

    // Load opportunity to check type and status
    const opportunityResult = await query(
      'SELECT id, type, status FROM opportunities WHERE id = $1',
      [opportunityId]
    );

    if (opportunityResult.rows.length === 0) {
      return res.status(404).json(createErrorResponse('Opportunity not found'));
    }

    const opportunity = opportunityResult.rows[0];

    // Only allow click tracking for poll or survey types
    if (opportunity.type !== 'poll' && opportunity.type !== 'survey') {
      return res.status(400).json(createErrorResponse('Click tracking is only available for polls and surveys'));
    }

    // Only allow tracking for published opportunities
    if (opportunity.status !== 'published') {
      return res.status(404).json(createErrorResponse('Opportunity not published'));
    }

    // Get user ID if authenticated, otherwise null (optional auth)
    const user = parseSessionCookie(req);
    const userId = user?.id || null;

    // Get user agent and IP for tracking (privacy-aware)
    const userAgent = req.headers['user-agent'] || null;
    
    // Get client IP (respects X-Forwarded-For if behind proxy)
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientIp = forwardedFor
      ? (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor.split(',')[0].trim())
      : req.headers['x-real-ip'] || null;
    
    // Hash IP address for privacy
    let ipHash: string | null = null;
    if (clientIp && process.env.SESSION_SECRET) {
      ipHash = crypto
        .createHash('sha256')
        .update(clientIp + process.env.SESSION_SECRET)
        .digest('hex')
        .substring(0, 32); // Store only first 32 chars
    }

    // Record the click
    await query(
      `INSERT INTO opportunity_clicks (opportunity_id, user_id, user_agent, ip_hash)
       VALUES ($1, $2, $3, $4)`,
      [opportunityId, userId, userAgent, ipHash]
    );

    return res.status(200).json({ ok: true });
  } catch (error: unknown) {
    console.error('Error in click tracking handler:', error);
    return res.status(500).json(createErrorResponse(getErrorMessage(error)));
  }
}


