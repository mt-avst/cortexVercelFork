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

    const notes = req.body?.notes as string | undefined;

    // Get the request
    const requestResult = await query(
      `SELECT user_id, status FROM admin_requests WHERE id = $1`,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json(createErrorResponse('Admin request not found'));
    }

    const adminRequest = requestResult.rows[0] as { status: string; user_id: string };

    if (adminRequest.status !== 'pending') {
      return res.status(400).json(createErrorResponse('Request has already been processed'));
    }

    // Update request status to denied
    await query(
      `UPDATE admin_requests 
       SET status = 'denied', reviewed_by = $1, reviewed_at = NOW(), notes = $2
       WHERE id = $3`,
      [user.id, notes || null, requestId]
    );

    return res.status(200).json({
      success: true,
      message: 'Admin request denied successfully'
    });
  } catch (error: unknown) {
    console.error('Error denying admin request:', error);
    return res.status(500).json(createErrorResponse('Failed to deny admin request', getErrorMessage(error)));
  }
}

