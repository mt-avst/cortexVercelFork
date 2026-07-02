import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query, getPool } from '../db';
import { requireAuth, requireAdmin, assertOwnerOrSuperadmin, handleAuthError } from '../utils/auth';
import { createErrorResponse, createSafeErrorResponse } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * PATCH /api/sessions/:id
 * Update a session's start_time, end_time, capacity and/or
 * location_or_meet_link_optional.
 *
 * Requires admin authentication; only the opportunity owner (or a
 * superadmin) may edit. Capacity cannot be reduced below the current
 * booked_count, and a time change that overlaps another session in the
 * same opportunity is rejected (409).
 *
 * Request body (all fields optional, at least one required):
 *   { start_time?: string; end_time?: string; capacity?: number; location_or_meet_link_optional?: string | null }
 * Response: the updated session, serialized like GET/POST /api/opportunities/:id/sessions
 *   (dates as ISO strings, plus a computed `remaining` field).
 *
 * DELETE /api/sessions/:id
 * Delete a session by ID
 *
 * Requires admin authentication
 * Cannot delete sessions with existing bookings
 */

interface SessionRow {
  id: string;
  opportunity_id: string;
  start_time: Date;
  end_time: Date;
  capacity: number;
  booked_count: number;
  location_or_meet_link_optional?: string | null;
  created_at: Date;
  updated_at: Date;
}

// Mirrors shared/constants SESSION_CAPACITY (MIN/MAX) used by the Express reference validation.
const SESSION_CAPACITY_MIN = 1;
const SESSION_CAPACITY_MAX = 500;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'DELETE' && req.method !== 'PATCH') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  // Get session ID from query params (Vercel dynamic routes)
  const sessionId = req.query.id as string;

  if (!sessionId) {
    return res.status(400).json(createErrorResponse('Session ID is required'));
  }

  if (req.method === 'PATCH') {
    return handlePatch(req, res, sessionId);
  }

  return handleDelete(req, res, sessionId);
}

async function handlePatch(req: VercelRequest, res: VercelResponse, sessionId: string) {
  try {
    // Require authentication (admin)
    let user;
    try {
      user = requireAdmin(req);
    } catch (authErr) {
      if (handleAuthError(res, authErr)) return;
      throw authErr;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    const hasStartTime = body.start_time !== undefined;
    const hasEndTime = body.end_time !== undefined;
    const hasCapacity = body.capacity !== undefined;
    const hasLocation = body.location_or_meet_link_optional !== undefined;

    const startTimeInput = hasStartTime ? String(body.start_time) : undefined;
    const endTimeInput = hasEndTime ? String(body.end_time) : undefined;
    const capacityInput = hasCapacity ? Number(body.capacity) : undefined;
    const locationInput = hasLocation
      ? (body.location_or_meet_link_optional as string | null)
      : undefined;

    // Validate data (mirrors validateSessionData in backend/src/validation/schemas.ts)
    const errors: string[] = [];

    if (hasStartTime && isNaN(new Date(startTimeInput as string).getTime())) {
      errors.push('Start time must be a valid ISO date string');
    }
    if (hasEndTime && isNaN(new Date(endTimeInput as string).getTime())) {
      errors.push('End time must be a valid ISO date string');
    }
    if (
      hasStartTime &&
      hasEndTime &&
      !isNaN(new Date(startTimeInput as string).getTime()) &&
      !isNaN(new Date(endTimeInput as string).getTime()) &&
      new Date(startTimeInput as string) >= new Date(endTimeInput as string)
    ) {
      errors.push('End time must be after start time');
    }
    if (
      hasCapacity &&
      (!Number.isInteger(capacityInput) ||
        (capacityInput as number) < SESSION_CAPACITY_MIN ||
        (capacityInput as number) > SESSION_CAPACITY_MAX)
    ) {
      errors.push(`Capacity must be an integer between ${SESSION_CAPACITY_MIN} and ${SESSION_CAPACITY_MAX}`);
    }

    if (errors.length > 0) {
      return res.status(400).json(createErrorResponse('Validation failed', errors));
    }

    if (!hasStartTime && !hasEndTime && !hasCapacity && !hasLocation) {
      return res.status(400).json(createErrorResponse('No fields to update'));
    }

    // Check session ownership through opportunity (superadmin may edit any)
    const ownershipCheck = await query(
      `SELECT o.owner_user_id
       FROM sessions s
       JOIN opportunities o ON s.opportunity_id = o.id
       WHERE s.id = $1`,
      [sessionId]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(404).json(createErrorResponse('Session not found'));
    }

    try {
      const ownerId = (ownershipCheck.rows[0] as { owner_user_id: string }).owner_user_id;
      assertOwnerOrSuperadmin(user, ownerId);
    } catch (authErr) {
      if (handleAuthError(res, authErr)) return;
      throw authErr;
    }

    // Use a transaction to prevent race conditions during the overlap check and update
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const currentResult = await client.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
      if (currentResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json(createErrorResponse('Session not found'));
      }
      const current = currentResult.rows[0] as SessionRow;

      if (hasCapacity && (capacityInput as number) < current.booked_count) {
        await client.query('ROLLBACK');
        return res.status(400).json(
          createErrorResponse(`Cannot reduce capacity below current bookings (${current.booked_count})`)
        );
      }

      // Check for overlaps if the time is being changed (inside the transaction)
      if (hasStartTime || hasEndTime) {
        const newStart = hasStartTime ? new Date(startTimeInput as string) : new Date(current.start_time);
        const newEnd = hasEndTime ? new Date(endTimeInput as string) : new Date(current.end_time);

        const overlapResult = await client.query(
          `SELECT COUNT(*) as overlap_count
           FROM sessions
           WHERE opportunity_id = $1
             AND id != $2
             AND (start_time < $4 AND end_time > $3)`,
          [current.opportunity_id, sessionId, newStart, newEnd]
        );
        const overlapCount = parseInt(
          String((overlapResult.rows[0] as { overlap_count: string }).overlap_count),
          10
        );
        if (overlapCount > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json(
            createErrorResponse('Updated session time overlaps with existing sessions')
          );
        }
      }

      // Build dynamic update query from only the known, allowed fields
      const updateFields: string[] = [];
      const values: unknown[] = [];
      let paramCount = 0;

      if (hasStartTime) {
        paramCount++;
        updateFields.push(`start_time = $${paramCount}`);
        values.push(startTimeInput);
      }
      if (hasEndTime) {
        paramCount++;
        updateFields.push(`end_time = $${paramCount}`);
        values.push(endTimeInput);
      }
      if (hasCapacity) {
        paramCount++;
        updateFields.push(`capacity = $${paramCount}`);
        values.push(capacityInput);
      }
      if (hasLocation) {
        paramCount++;
        updateFields.push(`location_or_meet_link_optional = $${paramCount}`);
        values.push(locationInput);
      }

      paramCount++;
      values.push(sessionId);

      const updateResult = await client.query(
        `UPDATE sessions SET ${updateFields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
        values
      );

      await client.query('COMMIT');

      const updated = updateResult.rows[0] as SessionRow;
      return res.status(200).json({
        ...updated,
        start_time: updated.start_time.toISOString(),
        end_time: updated.end_time.toISOString(),
        created_at: updated.created_at.toISOString(),
        updated_at: updated.updated_at.toISOString(),
        remaining: updated.capacity - updated.booked_count,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    logger.error('Error updating session', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      sessionId,
    });
    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Failed to update session' })
    );
  }
}

async function handleDelete(req: VercelRequest, res: VercelResponse, sessionId: string) {
  try {
    // Require authentication (admin)
    const user = requireAuth(req);

    // Check if user is admin
    if (user.role !== 'researcher_admin' && user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Admin access required', undefined, 'ADMIN_REQUIRED'));
    }

    // Check session ownership through opportunity
    const ownershipCheck = await query(
      `SELECT o.owner_user_id
       FROM sessions s
       JOIN opportunities o ON s.opportunity_id = o.id
       WHERE s.id = $1`,
      [sessionId]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(404).json(createErrorResponse('Session not found'));
    }

    // Only the opportunity owner (or superadmin) can delete the session
    const ownerId = ownershipCheck.rows[0].owner_user_id as string;
    if (ownerId !== user.id && user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Only the owner can delete this session', undefined, 'OWNER_ONLY'));
    }

    // Check if session has bookings
    const sessionCheck = await query(
      'SELECT booked_count FROM sessions WHERE id = $1',
      [sessionId]
    );

    if (sessionCheck.rows[0].booked_count > 0) {
      return res.status(400).json(
        createErrorResponse('Cannot delete session with existing bookings')
      );
    }

    // Delete the session
    await query('DELETE FROM sessions WHERE id = $1', [sessionId]);

    return res.status(204).send();
  } catch (error: unknown) {
    // Handle auth errors
    if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
      return res.status(401).json(createErrorResponse(
        typeof error === 'object' && 'error' in error
          ? String(error.error)
          : 'Not authenticated'
      ));
    }

    logger.error('Error deleting session', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      sessionId,
    });
    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Failed to delete session' })
    );
  }
}
