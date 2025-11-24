import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../../../db';
import { parseSessionCookie } from '../../../utils/auth';
import { createErrorResponse, getErrorMessage } from '../../../utils/errors';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

    const user = parseSessionCookie(req);
    if (!user || user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Superadmin access required'));
    }

    const requestId = req.query.id as string;
    if (!requestId) {
      return res.status(400).json(createErrorResponse('Request ID required'));
    }

    // Get the request
    const requestResult = await query(
      `SELECT user_id, requested_role, status FROM admin_requests WHERE id = $1`,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json(createErrorResponse('Admin request not found'));
    }

    if (requestResult.rows[0].status !== 'pending') {
      return res.status(400).json(createErrorResponse('Request has already been processed'));
    }

    const userId = requestResult.rows[0].user_id;
    const requestedRole = requestResult.rows[0].requested_role;

    // Update user role to the requested role
    await query(
      `UPDATE users SET role = $1 WHERE id = $2`,
      [requestedRole, userId]
    );

    // Update request status
    await query(
      `UPDATE admin_requests 
       SET status = 'approved', reviewed_by = $1, reviewed_at = NOW()
       WHERE id = $2`,
      [user.id, requestId]
    );

    const roleName = requestedRole === 'superadmin' ? 'superadmin' : 'admin';
    return res.status(200).json({
      success: true,
      message: `${roleName.charAt(0).toUpperCase() + roleName.slice(1)} request approved successfully`
    });
  } catch (error: unknown) {
    console.error('Error approving admin request:', error);
    return res.status(500).json(createErrorResponse('Failed to approve admin request', getErrorMessage(error)));
  }
}

