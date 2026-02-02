import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';
import { parseSessionCookie } from '../utils/auth';
import { createErrorResponse } from '../utils/errors';

/** Names to keep (case-insensitive match). All other users are deleted. */
const KEEP_USER_NAMES = ['Nick Fine', 'Greta Baisch'];

/**
 * POST /api/admin/reset-keep-two-users
 * - Deletes all bookings, sessions, and opportunities (studies reset to blank).
 * - Deletes all users except those whose name is "Nick Fine" or "Greta Baisch".
 * Requires superadmin authentication.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    const user = parseSessionCookie(req);
    if (!user) {
      return res.status(401).json(createErrorResponse('Authentication required'));
    }
    if (user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Superadmin access required'));
    }

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Delete all bookings
      const delBookings = await client.query('DELETE FROM bookings');
      console.log('Deleted bookings:', delBookings.rowCount);

      // 2. Delete all sessions
      const delSessions = await client.query('DELETE FROM sessions');
      console.log('Deleted sessions:', delSessions.rowCount);

      // 3. Delete all opportunities (studies) – opportunity_clicks CASCADE
      const delOpps = await client.query('DELETE FROM opportunities');
      console.log('Deleted opportunities:', delOpps.rowCount);

      // 4. Delete all users except Nick Fine and Greta Baisch (match by name, case-insensitive)
      const keepResult = await client.query(
        `SELECT id FROM users WHERE name ILIKE ANY($1::text[])`,
        [KEEP_USER_NAMES]
      );
      const keepIds = keepResult.rows.map((r: { id: string }) => r.id);

      let deletedUsers = 0;
      if (keepIds.length > 0) {
        const delUsers = await client.query(
          'DELETE FROM users WHERE NOT (id = ANY($1::uuid[]))',
          [keepIds]
        );
        deletedUsers = delUsers.rowCount ?? 0;
      } else {
        const delUsers = await client.query('DELETE FROM users');
        deletedUsers = delUsers.rowCount ?? 0;
      }
      console.log('Deleted users (kept Nick Fine & Greta Baisch):', deletedUsers);

      await client.query('COMMIT');

      return res.status(200).json({
        success: true,
        message: 'Reset complete: all studies removed; only Nick Fine and Greta Baisch kept as users.',
        stats: {
          bookingsDeleted: delBookings.rowCount ?? 0,
          sessionsDeleted: delSessions.rowCount ?? 0,
          opportunitiesDeleted: delOpps.rowCount ?? 0,
          usersDeleted: deletedUsers,
          usersKept: keepIds.length,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Reset keep-two-users failed:', error);
    return res.status(500).json(createErrorResponse('Reset failed', message));
  }
}
