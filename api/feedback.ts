import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from './db';
import { createErrorResponse, createSafeErrorResponse } from './utils/errors';
import { requireAuth, parseSessionCookie } from './utils/auth';
import { logger } from './utils/logger';
import { feedbackRateLimit } from './utils/rateLimit';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'POST') {
    return handlePost(req, res);
  } else if (req.method === 'GET') {
    return handleGet(req, res);
  } else {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }
}

// POST /api/feedback - Submit feedback (public, optionally authenticated)
async function handlePost(req: VercelRequest, res: VercelResponse) {
  if (await feedbackRateLimit(req, res)) {
    return; // 429 already sent
  }
  try {
    const { feedback, category, userAgent, url } = req.body;
    
    // Get optional user (don't require auth for feedback submission)
    const user = parseSessionCookie(req);

    const userName = user?.name || 'Anonymous';
    const userEmail = user?.email || 'Not logged in';
    const userId = user?.id || null;

    logger.info('Saving feedback to database', { category, userEmail });

    const pool = getPool();
    
    // Save feedback to database
    await pool.query(
      `INSERT INTO feedback (user_id, user_name, user_email, category, feedback, url, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, userName, userEmail, category, feedback, url || 'Unknown', userAgent || req.headers['user-agent'] || 'Unknown']
    );

    logger.info('Feedback saved to database');

    return res.status(200).json({ success: true });
  } catch (error: unknown) {
    logger.error('Failed to save feedback', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json(createSafeErrorResponse(error, { userMessage: 'Failed to save feedback' }));
  }
}

// GET /api/feedback - List all feedback (admin only)
async function handleGet(req: VercelRequest, res: VercelResponse) {
  try {
    // Require authentication
    const user = requireAuth(req);
    
    // Check admin role
    if (user.role !== 'researcher_admin' && user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Admin access required'));
    }

    const pool = getPool();
    
    const result = await pool.query(
      `SELECT id, user_id, user_name, user_email, category, feedback, url, user_agent, created_at
       FROM feedback
       ORDER BY created_at DESC`
    );

    return res.status(200).json({ success: true, data: result.rows });
  } catch (error: unknown) {
    // Handle auth errors
    if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
      return res.status(401).json(createErrorResponse(
        typeof error === 'object' && 'error' in error 
          ? String(error.error) 
          : 'Not authenticated'
      ));
    }
    
    logger.error('Error fetching feedback', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json(createSafeErrorResponse(error, { userMessage: 'Failed to fetch feedback' }));
  }
}

