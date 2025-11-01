import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../../db';
import { createErrorResponse, getErrorMessage } from '../../utils/errors';
import { requireAuth } from '../../utils/auth';

/**
 * GET /api/opportunities/[id]/analytics
 * Get click analytics for an opportunity (M6)
 * Auth: Required (admin only, owner only)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    // Require authentication
    const user = requireAuth(req);
    
    // Check if user is admin
    if (user.role !== 'researcher_admin') {
      return res.status(403).json(createErrorResponse('Admin access required'));
    }

    // Get opportunity ID from query params
    let opportunityId = req.query.id as string;
    
    // If not in query, try to parse from URL path
    if (!opportunityId && req.url) {
      const urlMatch = req.url.match(/\/opportunities\/([^\/]+)\/analytics/);
      if (urlMatch) {
        opportunityId = urlMatch[1];
      }
    }
    
    if (!opportunityId) {
      return res.status(400).json(createErrorResponse('Opportunity ID is required'));
    }

    // Check opportunity ownership
    const opportunityResult = await query(
      'SELECT owner_user_id FROM opportunities WHERE id = $1',
      [opportunityId]
    );

    if (opportunityResult.rows.length === 0) {
      return res.status(404).json(createErrorResponse('Opportunity not found'));
    }

    const opportunity = opportunityResult.rows[0];

    // Only owner can view analytics
    if (opportunity.owner_user_id !== user.id) {
      return res.status(403).json(createErrorResponse('Only the opportunity owner can view analytics'));
    }

    // Get total clicks
    const totalResult = await query(
      'SELECT COUNT(*) as count FROM opportunity_clicks WHERE opportunity_id = $1',
      [opportunityId]
    );
    const clicks_total = parseInt(totalResult.rows[0]?.count || '0', 10);

    // Get clicks in last 24 hours
    const hours24Result = await query(
      `SELECT COUNT(*) as count FROM opportunity_clicks 
       WHERE opportunity_id = $1 AND clicked_at >= NOW() - INTERVAL '24 hours'`,
      [opportunityId]
    );
    const clicks_24h = parseInt(hours24Result.rows[0]?.count || '0', 10);

    // Get clicks by day for last 30 days
    const dailyResult = await query(
      `SELECT 
        DATE(clicked_at) as date,
        COUNT(*)::int as count
       FROM opportunity_clicks
       WHERE opportunity_id = $1 
         AND clicked_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(clicked_at)
       ORDER BY date ASC`,
      [opportunityId]
    );

    const clicks_by_day = dailyResult.rows.map(row => ({
      date: row.date.toISOString().split('T')[0], // Format as YYYY-MM-DD
      count: parseInt(row.count, 10)
    }));

    return res.status(200).json({
      clicks_total,
      clicks_24h,
      clicks_by_day
    });
  } catch (error: unknown) {
    // Handle auth errors
    if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
      return res.status(401).json(createErrorResponse(
        typeof error === 'object' && 'error' in error 
          ? String(error.error) 
          : 'Not authenticated'
      ));
    }
    
    console.error('Error in analytics handler:', error);
    return res.status(500).json(createErrorResponse(getErrorMessage(error)));
  }
}


