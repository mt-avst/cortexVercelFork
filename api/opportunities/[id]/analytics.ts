import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../../db';
import { createErrorResponse, createSafeErrorResponse } from '../../utils/errors';
import { requireAuth } from '../../utils/auth';
import { logger } from '../../utils/logger';

/**
 * GET /api/opportunities/[id]/analytics
 * Get click analytics for an opportunity (M6)
 * Auth: Required (admin only, owner only)
 * 
 * Two-level analytics:
 * - views: How many times users clicked to view the study details
 * - actions: How many times users clicked the action button (Open Poll/Survey, Book Session)
 * 
 * Query params:
 * - period: 7, 14, 30 (days) - default 30
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

    // Get time period from query (default 30 days)
    const periodParam = req.query.period;
    const period = periodParam ? parseInt(String(periodParam), 10) : 30;
    const validPeriods = [7, 14, 30];
    const selectedPeriod = validPeriods.includes(period) ? period : 30;

    // Get opportunity ID from Vercel dynamic route
    let opportunityId: string | undefined;
    
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
    
    // Validate ID format
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
      'SELECT owner_user_id, created_at FROM opportunities WHERE id = $1',
      [opportunityId]
    );

    if (opportunityResult.rows.length === 0) {
      return res.status(404).json(createErrorResponse('Opportunity not found'));
    }

    const opportunity = opportunityResult.rows[0] as { owner_user_id: string; created_at: Date };

    // Only owner or superadmin can view analytics
    if (opportunity.owner_user_id !== user.id && user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Only the opportunity owner can view analytics'));
    }

    // Helper to handle query errors
    const safeQuery = async <T>(queryFn: () => Promise<T>, defaultValue: T): Promise<T> => {
      try {
        return await queryFn();
      } catch (queryError: unknown) {
        const error = queryError as { code?: string; message?: string };
        if (error.code === '42P01') { // Table doesn't exist
          return defaultValue;
        }
        throw queryError;
      }
    };

    // Type for count query results
    type CountRow = { count: number };
    type DateRow = { first_click: Date | null; last_click: Date | null };

    // Get total clicks (views + actions combined)
    const clicks_total = await safeQuery(async () => {
      const result = await query(
        'SELECT COUNT(*)::int as count FROM opportunity_clicks WHERE opportunity_id = $1',
        [opportunityId]
      );
      return (result.rows[0] as CountRow)?.count || 0;
    }, 0);

    // Get views total (click_type = 'view')
    const views_total = await safeQuery(async () => {
      const result = await query(
        `SELECT COUNT(*)::int as count FROM opportunity_clicks 
         WHERE opportunity_id = $1 AND click_type = 'view'`,
        [opportunityId]
      );
      return (result.rows[0] as CountRow)?.count || 0;
    }, 0);

    // Get actions total (click_type = 'action')
    const actions_total = await safeQuery(async () => {
      const result = await query(
        `SELECT COUNT(*)::int as count FROM opportunity_clicks 
         WHERE opportunity_id = $1 AND click_type = 'action'`,
        [opportunityId]
      );
      return (result.rows[0] as CountRow)?.count || 0;
    }, 0);

    // Get clicks in last 24 hours (combined)
    const clicks_24h = await safeQuery(async () => {
      const result = await query(
        `SELECT COUNT(*)::int as count FROM opportunity_clicks 
         WHERE opportunity_id = $1 AND clicked_at >= NOW() - INTERVAL '24 hours'`,
        [opportunityId]
      );
      return (result.rows[0] as CountRow)?.count || 0;
    }, 0);

    // Get views in last 24 hours
    const views_24h = await safeQuery(async () => {
      const result = await query(
        `SELECT COUNT(*)::int as count FROM opportunity_clicks 
         WHERE opportunity_id = $1 AND click_type = 'view' AND clicked_at >= NOW() - INTERVAL '24 hours'`,
        [opportunityId]
      );
      return (result.rows[0] as CountRow)?.count || 0;
    }, 0);

    // Get actions in last 24 hours
    const actions_24h = await safeQuery(async () => {
      const result = await query(
        `SELECT COUNT(*)::int as count FROM opportunity_clicks 
         WHERE opportunity_id = $1 AND click_type = 'action' AND clicked_at >= NOW() - INTERVAL '24 hours'`,
        [opportunityId]
      );
      return (result.rows[0] as CountRow)?.count || 0;
    }, 0);

    // Get clicks in last 7 days (combined)
    const clicks_7d = await safeQuery(async () => {
      const result = await query(
        `SELECT COUNT(*)::int as count FROM opportunity_clicks 
         WHERE opportunity_id = $1 AND clicked_at >= NOW() - INTERVAL '7 days'`,
        [opportunityId]
      );
      return (result.rows[0] as CountRow)?.count || 0;
    }, 0);

    // Get views in last 7 days
    const views_7d = await safeQuery(async () => {
      const result = await query(
        `SELECT COUNT(*)::int as count FROM opportunity_clicks 
         WHERE opportunity_id = $1 AND click_type = 'view' AND clicked_at >= NOW() - INTERVAL '7 days'`,
        [opportunityId]
      );
      return (result.rows[0] as CountRow)?.count || 0;
    }, 0);

    // Get actions in last 7 days
    const actions_7d = await safeQuery(async () => {
      const result = await query(
        `SELECT COUNT(*)::int as count FROM opportunity_clicks 
         WHERE opportunity_id = $1 AND click_type = 'action' AND clicked_at >= NOW() - INTERVAL '7 days'`,
        [opportunityId]
      );
      return (result.rows[0] as CountRow)?.count || 0;
    }, 0);

    // Get unique users who clicked
    const unique_users = await safeQuery(async () => {
      const result = await query(
        `SELECT COUNT(DISTINCT COALESCE(user_id::text, ip_hash))::int as count 
         FROM opportunity_clicks WHERE opportunity_id = $1`,
        [opportunityId]
      );
      return (result.rows[0] as CountRow)?.count || 0;
    }, 0);

    // Get unique users who viewed
    const unique_viewers = await safeQuery(async () => {
      const result = await query(
        `SELECT COUNT(DISTINCT COALESCE(user_id::text, ip_hash))::int as count 
         FROM opportunity_clicks WHERE opportunity_id = $1 AND click_type = 'view'`,
        [opportunityId]
      );
      return (result.rows[0] as CountRow)?.count || 0;
    }, 0);

    // Get unique users who took action
    const unique_actors = await safeQuery(async () => {
      const result = await query(
        `SELECT COUNT(DISTINCT COALESCE(user_id::text, ip_hash))::int as count 
         FROM opportunity_clicks WHERE opportunity_id = $1 AND click_type = 'action'`,
        [opportunityId]
      );
      return (result.rows[0] as CountRow)?.count || 0;
    }, 0);

    // Get first and last click dates
    const clickDates = await safeQuery(async () => {
      const result = await query(
        `SELECT 
          MIN(clicked_at) as first_click,
          MAX(clicked_at) as last_click
         FROM opportunity_clicks WHERE opportunity_id = $1`,
        [opportunityId]
      );
      const row = result.rows[0] as DateRow;
      return {
        first_click: row?.first_click || null,
        last_click: row?.last_click || null
      };
    }, { first_click: null, last_click: null });

    // Types for time series queries
    type DayRow = { date: Date | string; total: number; views: number; actions: number };
    type HourRow = { hour: number; count: number };
    type WeekdayRow = { weekday: number; count: number };

    // Get clicks by day for selected period (with views and actions breakdown)
    const clicks_by_day = await safeQuery(async () => {
      const result = await query(
        `SELECT 
          DATE(clicked_at) as date,
          COUNT(*)::int as total,
          COUNT(*) FILTER (WHERE click_type = 'view')::int as views,
          COUNT(*) FILTER (WHERE click_type = 'action')::int as actions
         FROM opportunity_clicks
         WHERE opportunity_id = $1 
           AND clicked_at >= NOW() - INTERVAL '${selectedPeriod} days'
         GROUP BY DATE(clicked_at)
         ORDER BY date ASC`,
        [opportunityId]
      );

      return result.rows.map((r) => {
        const row = r as DayRow;
        let dateStr: string;
        if (row.date instanceof Date) {
          dateStr = row.date.toISOString().split('T')[0];
        } else if (row.date) {
          dateStr = String(row.date).split('T')[0];
        } else {
          return null;
        }
        return { 
          date: dateStr, 
          count: row.total || 0,
          views: row.views || 0,
          actions: row.actions || 0
        };
      }).filter(Boolean) as Array<{ date: string; count: number; views: number; actions: number }>;
    }, []);

    // Get clicks by hour of day (peak times)
    const clicks_by_hour = await safeQuery(async () => {
      const result = await query(
        `SELECT 
          EXTRACT(HOUR FROM clicked_at)::int as hour,
          COUNT(*)::int as count
         FROM opportunity_clicks
         WHERE opportunity_id = $1
         GROUP BY EXTRACT(HOUR FROM clicked_at)
         ORDER BY hour ASC`,
        [opportunityId]
      );
      return result.rows.map((r) => {
        const row = r as HourRow;
        return {
          hour: row.hour,
          count: row.count || 0
        };
      });
    }, []);

    // Get clicks by day of week
    const clicks_by_weekday = await safeQuery(async () => {
      const result = await query(
        `SELECT 
          EXTRACT(DOW FROM clicked_at)::int as weekday,
          COUNT(*)::int as count
         FROM opportunity_clicks
         WHERE opportunity_id = $1
         GROUP BY EXTRACT(DOW FROM clicked_at)
         ORDER BY weekday ASC`,
        [opportunityId]
      );
      const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return result.rows.map((r) => {
        const row = r as WeekdayRow;
        return {
          weekday: weekdays[row.weekday] || 'Unknown',
          weekday_num: row.weekday,
          count: row.count || 0
        };
      });
    }, []);

    // Calculate week-over-week change
    const previousWeekClicks = await safeQuery(async () => {
      const result = await query(
        `SELECT COUNT(*)::int as count FROM opportunity_clicks 
         WHERE opportunity_id = $1 
           AND clicked_at >= NOW() - INTERVAL '14 days'
           AND clicked_at < NOW() - INTERVAL '7 days'`,
        [opportunityId]
      );
      return (result.rows[0] as CountRow)?.count || 0;
    }, 0);

    const week_over_week_change = previousWeekClicks > 0 
      ? Math.round(((clicks_7d - previousWeekClicks) / previousWeekClicks) * 100)
      : clicks_7d > 0 ? 100 : 0;

    // Calculate average clicks per day (for the selected period)
    const daysWithData = clicks_by_day.length;
    const totalClicksInPeriod = clicks_by_day.reduce((sum, d) => sum + d.count, 0);
    const avg_clicks_per_day = daysWithData > 0 
      ? Math.round((totalClicksInPeriod / daysWithData) * 10) / 10
      : 0;

    // Find peak day
    const peak_day = clicks_by_day.length > 0
      ? clicks_by_day.reduce((max, d) => d.count > max.count ? d : max, clicks_by_day[0])
      : null;

    // Find peak hour
    const peak_hour = clicks_by_hour.length > 0
      ? clicks_by_hour.reduce((max, h) => h.count > max.count ? h : max, clicks_by_hour[0])
      : null;

    // Calculate conversion rate (views to actions)
    const conversion_rate = views_total > 0 
      ? Math.round((actions_total / views_total) * 1000) / 10 
      : 0;

    return res.status(200).json({
      // Combined summary stats
      clicks_total,
      clicks_24h,
      clicks_7d,
      unique_users,
      avg_clicks_per_day,
      week_over_week_change,
      
      // Views (user clicked to view study details)
      views_total,
      views_24h,
      views_7d,
      unique_viewers,
      
      // Actions (user clicked action button - Open Poll/Survey, Book Session)
      actions_total,
      actions_24h,
      actions_7d,
      unique_actors,
      
      // Conversion rate (views -> actions)
      conversion_rate,
      
      // Dates
      first_click: clickDates.first_click,
      last_click: clickDates.last_click,
      opportunity_created: opportunity.created_at,
      
      // Peak info
      peak_day,
      peak_hour: peak_hour ? {
        hour: peak_hour.hour,
        hour_label: `${peak_hour.hour}:00 - ${peak_hour.hour + 1}:00`,
        count: peak_hour.count
      } : null,
      
      // Time series data (with views/actions breakdown)
      clicks_by_day,
      clicks_by_hour,
      clicks_by_weekday,
      
      // Period info
      period: selectedPeriod
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
    
    logger.error('Error in analytics handler', {
      errorMessage: error instanceof Error ? error.message : String(error),
      errorType: typeof error,
      errorStack: error instanceof Error ? error.stack : undefined,
      query: req.query,
      url: req.url,
      method: req.method
    });
    
    return res.status(500).json(createSafeErrorResponse(error, {
      userMessage: 'An error occurred while loading analytics',
    }));
  }
}


