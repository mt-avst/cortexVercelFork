import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { parseSessionCookie } from '../utils/auth';
import { createErrorResponse, getErrorMessage } from '../utils/errors';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const user = parseSessionCookie(req);
    if (!user || user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Superadmin access required'));
    }

    if (req.method === 'GET') {
      // Get all admins (researcher_admin and superadmin)
      const result = await query(
        `SELECT id, email, name, role, created_at
         FROM users
         WHERE role IN ('researcher_admin', 'superadmin')
         ORDER BY created_at DESC`
      );

      return res.status(200).json({
        success: true,
        admins: result.rows
      });
    } else if (req.method === 'DELETE') {
      // Revoke admin access
      const adminId = req.query.id as string;
      if (!adminId) {
        return res.status(400).json(createErrorResponse('Admin ID required'));
      }

      // Prevent revoking superadmin or self
      const adminResult = await query(
        `SELECT role FROM users WHERE id = $1`,
        [adminId]
      );

      if (adminResult.rows.length === 0) {
        return res.status(404).json(createErrorResponse('Admin not found'));
      }

      if (adminResult.rows[0].role === 'superadmin') {
        return res.status(400).json(createErrorResponse('Cannot revoke superadmin access'));
      }

      if (adminId === user.id) {
        return res.status(400).json(createErrorResponse('Cannot revoke your own admin access'));
      }

      // Revoke admin role
      await query(
        `UPDATE users SET role = 'employee' WHERE id = $1`,
        [adminId]
      );

      return res.status(200).json({
        success: true,
        message: 'Admin access revoked successfully'
      });
    } else {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }
  } catch (error: unknown) {
    console.error('Error managing admins:', error);
    return res.status(500).json(createErrorResponse('Failed to manage admins', getErrorMessage(error)));
  }
}

