import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../../db';
import { createErrorResponse, getErrorMessage } from '../../utils/errors';
import { requireAuth } from '../../utils/auth';
import { logger } from '../../utils/logger';

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
    if (user.role !== 'researcher_admin' && user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Admin access required'));
    }

    // Get opportunity ID from Vercel dynamic route
    // For nested routes like /api/opportunities/[id]/analytics.ts, 
    // Vercel puts the [id] parameter in req.query.id
    let opportunityId: string | undefined;
    
    // First try query.id (Vercel dynamic route parameter)
    if (req.query.id) {
      if (Array.isArray(req.query.id)) {
        opportunityId = req.query.id[0];
      } else {
        opportunityId = req.query.id as string;
      }
    }
    
    // Fallback: try to parse from URL path
    if (!opportunityId && req.url) {
      const urlMatch = req.url.match(/\/opportunities\/([^\/\?]+)\/analytics/);
      if (urlMatch && urlMatch[1]) {
        opportunityId = urlMatch[1];
      }
    }
    
    // Validate ID format (UUID should be 36 chars with hyphens)
    if (!opportunityId || opportunityId.length < 10) {
      logger.error('Analytics: Invalid opportunity ID', { 
        id: opportunityId, 
        query: req.query,
        url: req.url 
      });
      return res.status(400).json(createErrorResponse('Valid opportunity ID is required'));
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

    // Get total clicks (handle case where table might not exist)
    let clicks_total = 0;
    try {
      const totalResult = await query(
        'SELECT COUNT(*)::text as count FROM opportunity_clicks WHERE opportunity_id = $1',
        [opportunityId]
      );
      clicks_total = parseInt(String(totalResult.rows[0]?.count || '0'), 10);
    } catch (queryError: unknown) {
      const error = queryError as { code?: string; message?: string };
      logger.error('Error querying total clicks', {
        error: error.message || String(queryError),
        code: error.code,
      });
      // If table doesn't exist, return 0
      if (error.code === '42P01') { // Table doesn't exist
        clicks_total = 0;
      } else {
        throw queryError;
      }
    }

    // Get clicks in last 24 hours
    let clicks_24h = 0;
    try {
      const hours24Result = await query(
        `SELECT COUNT(*)::text as count FROM opportunity_clicks 
         WHERE opportunity_id = $1 AND clicked_at >= NOW() - INTERVAL '24 hours'`,
        [opportunityId]
      );
      clicks_24h = parseInt(String(hours24Result.rows[0]?.count || '0'), 10);
    } catch (queryError: unknown) {
      const error = queryError as { code?: string; message?: string };
      logger.error('Error querying 24h clicks', {
        error: error.message || String(queryError),
        code: error.code,
      });
      if (error.code === '42P01') { // Table doesn't exist
        clicks_24h = 0;
      } else {
        throw queryError;
      }
    }

    // Get clicks by day for last 30 days
    let clicks_by_day: Array<{ date: string; count: number }> = [];
    try {
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

      clicks_by_day = dailyResult.rows.map(row => {
        let dateStr: string;
        if (row.date instanceof Date) {
          dateStr = row.date.toISOString().split('T')[0];
        } else if (row.date) {
          // If it's already a string, use it directly
          dateStr = String(row.date).split('T')[0];
        } else {
          // Skip invalid dates
          return null;
        }
        
        return {
          date: dateStr,
          count: parseInt(String(row.count || '0'), 10)
        };
      }).filter(Boolean) as Array<{ date: string; count: number }>;
    } catch (queryError: unknown) {
      const error = queryError as { code?: string; message?: string };
      logger.error('Error querying daily clicks', {
        error: error.message || String(queryError),
        code: error.code,
      });
      if (error.code === '42P01') { // Table doesn't exist
        clicks_by_day = [];
      } else {
        throw queryError;
      }
    }

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
    
    // Log full error details for debugging
    logger.error('Error in analytics handler', {
      errorMessage: error instanceof Error ? error.message : String(error),
      errorType: typeof error,
      errorStack: error instanceof Error ? error.stack : undefined,
      query: req.query,
      url: req.url,
      method: req.method
    });
    
    const errorMessage = getErrorMessage(error);
    return res.status(500).json(createErrorResponse(
      errorMessage || 'An error occurred while loading analytics'
    ));
  }
}


