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

    // Determine requested role based on current role
    let requestedRole: 'researcher_admin' | 'superadmin';
    if (user.role === 'employee') {
      requestedRole = 'researcher_admin';
    } else if (user.role === 'researcher_admin') {
      requestedRole = 'superadmin';
    } else {
      return res.status(400).json(createErrorResponse('You already have the highest privilege level'));
    }

    // Check if user already has a pending request for this role
    const existingRequest = await query(
      `SELECT id FROM admin_requests 
       WHERE user_id = $1 AND requested_role = $2 AND status = 'pending'`,
      [user.id, requestedRole]
    );

    if (existingRequest.rows.length > 0) {
      const roleName = requestedRole === 'superadmin' ? 'superadmin' : 'admin';
      return res.status(400).json(createErrorResponse(`You already have a pending ${roleName} request`));
    }

    // Create new request
    const result = await query(
      `INSERT INTO admin_requests (user_id, requested_at, requested_role, status)
       VALUES ($1, NOW(), $2, 'pending')
       RETURNING id, requested_at, requested_role, status`,
      [user.id, requestedRole]
    );

    const roleName = requestedRole === 'superadmin' ? 'superadmin' : 'admin';
    return res.status(201).json({
      success: true,
      request: result.rows[0],
      message: `${roleName.charAt(0).toUpperCase() + roleName.slice(1)} request submitted successfully`
    });
  } catch (error: unknown) {
    console.error('Error creating admin request:', error);
    return res.status(500).json(createErrorResponse('Failed to submit admin request', getErrorMessage(error)));
  }
}

