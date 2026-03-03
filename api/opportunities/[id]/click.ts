import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../../db';
import { createErrorResponse, createSafeErrorResponse } from '../../utils/errors';
import { parseSessionCookie } from '../../utils/auth';
import { logger } from '../../utils/logger';
import * as crypto from 'crypto';

/**
 * POST /api/opportunities/[id]/click
 * Track clicks for opportunities (M6)
 * 
 * Two click types:
 * - 'view': User clicked to view the study details (all opportunity types)
 * - 'action': User clicked the action button (Open Poll/Survey link, Book Session)
 * 
 * Body: { click_type?: 'view' | 'action' } - defaults to 'action' for backwards compatibility
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

    // Get click type from body, default to 'action' for backwards compatibility
    const clickType = req.body?.click_type || 'action';
    if (clickType !== 'view' && clickType !== 'action') {
      return res.status(400).json(createErrorResponse('Invalid click_type. Must be "view" or "action"'));
    }

    // Load opportunity to check type and status
    const opportunityResult = await query(
      'SELECT id, type, status FROM opportunities WHERE id = $1',
      [opportunityId]
    );

    if (opportunityResult.rows.length === 0) {
      return res.status(404).json(createErrorResponse('Opportunity not found'));
    }

    const opportunity = opportunityResult.rows[0] as { id: string; type: string; status: string };

    // For 'action' clicks, only allow for poll/survey/unmoderated types (external link clicks) and test/interview (session bookings)
    // For 'view' clicks, allow all opportunity types
    if (clickType === 'action' && opportunity.type !== 'poll' && opportunity.type !== 'survey' && opportunity.type !== 'unmoderated' && opportunity.type !== 'test' && opportunity.type !== 'interview') {
      return res.status(400).json(createErrorResponse('Action click tracking is only available for polls, surveys, unmoderated tests, tests, and interviews'));
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

    // Record the click with type
    await query(
      `INSERT INTO opportunity_clicks (opportunity_id, user_id, click_type, user_agent, ip_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [opportunityId, userId, clickType, userAgent, ipHash]
    );

    return res.status(200).json({ ok: true, click_type: clickType });
  } catch (error: unknown) {
    logger.error('Error in click tracking handler', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      opportunityId: req.query.id,
    });
    return res.status(500).json(createSafeErrorResponse(error, { userMessage: 'Failed to record click' }));
  }
}


