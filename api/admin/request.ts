import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { parseSessionCookie } from '../utils/auth';
import { createErrorResponse, getErrorMessage } from '../utils/errors';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

    const user = parseSessionCookie(req);
    if (!user) {
      return res.status(401).json(createErrorResponse('Authentication required'));
    }

    // Check if user already has admin role
    if (user.role === 'researcher_admin' || user.role === 'superadmin') {
      return res.status(400).json(createErrorResponse('User already has admin access'));
    }

    // Check if user already has a pending request
    const existingRequest = await query(
      `SELECT id FROM admin_requests 
       WHERE user_id = $1 AND status = 'pending'`,
      [user.id]
    );

    if (existingRequest.rows.length > 0) {
      return res.status(400).json(createErrorResponse('You already have a pending admin request'));
    }

    // Create new request
    const result = await query(
      `INSERT INTO admin_requests (user_id, requested_at, status)
       VALUES ($1, NOW(), 'pending')
       RETURNING id, requested_at, status`,
      [user.id]
    );

    return res.status(201).json({
      success: true,
      request: result.rows[0],
      message: 'Admin request submitted successfully'
    });
  } catch (error: unknown) {
    console.error('Error creating admin request:', error);
    return res.status(500).json(createErrorResponse('Failed to submit admin request', getErrorMessage(error)));
  }
}

