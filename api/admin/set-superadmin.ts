import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { parseSessionCookie } from '../utils/auth';
import { createErrorResponse, createSafeErrorResponse } from '../utils/errors';
import { adminRateLimit } from '../utils/rateLimit';

/**
 * One-time endpoint to set superadmin role
 * This endpoint allows setting superadmin for nfine@adaptavist.com
 * After first use, it should be disabled or protected
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

    if (await adminRateLimit(req, res)) return;

    const user = parseSessionCookie(req);
    const targetEmail = req.body?.email || 'nfine@adaptavist.com';
    
    // Only allow if user is already admin or if setting for nfine@adaptavist.com
    if (!user) {
      return res.status(401).json(createErrorResponse('Authentication required'));
    }

    // Allow if user is admin, or if they're setting themselves and email matches
    const isAdmin = user.role === 'researcher_admin' || user.role === 'superadmin';
    const isSelf = user.email === targetEmail && user.email === 'nfine@adaptavist.com';
    
    if (!isAdmin && !isSelf) {
      return res.status(403).json(createErrorResponse('Not authorized to set superadmin role'));
    }

    // Update role constraint first
    try {
      await query(`
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
        ALTER TABLE users ADD CONSTRAINT users_role_check 
          CHECK (role IN ('employee', 'researcher_admin', 'superadmin'));
      `);
    } catch (error: any) {
      // Constraint might already exist, that's okay
      console.log('Constraint update note:', error.message);
    }

    // Check if user exists
    const userResult = await query(
      'SELECT id, name, email, role FROM users WHERE email = $1',
      [targetEmail]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json(createErrorResponse(`User with email ${targetEmail} not found`));
    }

    const targetUser = userResult.rows[0];

    // Update role to superadmin
    await query(
      'UPDATE users SET role = $1 WHERE email = $2',
      ['superadmin', targetEmail]
    );

    return res.status(200).json({
      success: true,
      message: `Successfully set ${targetEmail} to superadmin role`,
      user: {
        email: targetUser.email,
        name: targetUser.name,
        previousRole: targetUser.role,
        newRole: 'superadmin'
      },
      note: 'Please log out and log back in to refresh your session'
    });
  } catch (error: unknown) {
    console.error('Error setting superadmin role:', error);
    return res.status(500).json(createSafeErrorResponse(error, { userMessage: 'Failed to set superadmin role' }));
  }
}

