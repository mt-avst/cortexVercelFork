import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { parseSessionCookie } from '../utils/auth';
import { createErrorResponse, getErrorMessage } from '../utils/errors';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

    const user = parseSessionCookie(req);
    if (!user || user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Superadmin access required'));
    }

    const status = req.query.status as string | undefined;
    let queryStr = `
      SELECT 
        ar.id,
        ar.user_id,
        ar.requested_at,
        ar.status,
        ar.reviewed_by,
        ar.reviewed_at,
        ar.notes,
        u.email,
        u.name
      FROM admin_requests ar
      JOIN users u ON ar.user_id = u.id
    `;
    const params: any[] = [];

    if (status) {
      queryStr += ` WHERE ar.status = $1`;
      params.push(status);
    }

    queryStr += ` ORDER BY ar.requested_at DESC`;

    const result = await query(queryStr, params);

    return res.status(200).json({
      success: true,
      requests: result.rows
    });
  } catch (error: unknown) {
    console.error('Error fetching admin requests:', error);
    return res.status(500).json(createErrorResponse('Failed to fetch admin requests', getErrorMessage(error)));
  }
}

