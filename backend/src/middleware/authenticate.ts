import { Request, Response, NextFunction } from 'express';
import { SessionUser } from '../types';
import { pool } from '../config';
import { logger } from '../utils/logger';

// Note: Express Request extension is defined in ../types/index.ts

type AdminRole = SessionUser['role'];

/**
 * Re-read the user's CURRENT role from the database - the liveness fix for #14.
 *
 * The role written into the session at login was the source of truth for every
 * admin gate, and it was never refreshed. Revoking an admin
 * (`DELETE /api/admin/admins`) changed the DB row but left every existing
 * cookie working for up to SESSION_MAX_AGE_MS (24h), so the "revoked
 * successfully" message was untrue when sent. Admin routes are low-volume
 * (writes and admin-only reads - never hot participant paths), so one query per
 * admin request is an acceptable price for the role being live.
 *
 * FAILS CLOSED. On a DB error or a user that no longer exists it writes a
 * response and returns null; the caller must return immediately without calling
 * next(). It never falls through to the session role.
 */
async function currentDbRole(req: Request, res: Response): Promise<AdminRole | null> {
  const userId = req.session!.user!.id;
  try {
    const result = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      // The account was deleted after login. Treat as unauthenticated.
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    return result.rows[0].role as AdminRole;
  } catch (error) {
    logger.error('Failed to verify current role for admin gate', { userId, error });
    res.status(503).json({ error: 'Authorization check failed' });
    return null;
  }
}

// Middleware to require authentication
export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  req.user = req.session.user;
  next();
};

// Middleware to require admin role (researcher_admin or superadmin)
export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Liveness (#14): trust the DB role, not the one snapshotted at login.
  const role = await currentDbRole(req, res);
  if (role === null) {
    return; // response already sent, failing closed
  }

  if (role !== 'researcher_admin' && role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  // Carry the fresh role forward so downstream role checks (e.g. superadmin
  // sub-gates) see the live value, not the stale session one.
  req.user = { ...req.session.user, role };
  next();
};

// Middleware to require superadmin role only
export const requireSuperadmin = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Liveness (#14): trust the DB role, not the one snapshotted at login.
  const role = await currentDbRole(req, res);
  if (role === null) {
    return; // response already sent, failing closed
  }

  if (role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required' });
  }

  req.user = { ...req.session.user, role };
  next();
};

/**
 * Attach the LIVE role to `req.user` without gating on it - the #37 companion
 * to the #14 gates above.
 *
 * `requireAdmin` cannot cover a route that admits non-admins as well. Two
 * bookings routes made their own admin decision inline, from the role
 * `requireAuth` copies straight off the session, so #14's re-read never reached
 * them and a revoked admin kept the admin branch for up to SESSION_MAX_AGE_MS
 * (24h). Chain this after `requireAuth` and the handler's existing
 * `req.user!.role` read is live, with no other change to the handler.
 *
 * FAILS CLOSED, like the gates: on a DB error or a deleted user `currentDbRole`
 * has already answered and this returns without calling next().
 */
export const withLiveRole = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // `liveRole`, not `role`, so the canary has a one-match anchor here that the
  // two identically-shaped gates above cannot answer for.
  const liveRole = await currentDbRole(req, res);
  if (liveRole === null) {
    return; // response already sent, failing closed
  }

  req.user = { ...req.session.user, role: liveRole };
  next();
};

// Optional authentication - attaches user if session exists
export const optionalAuth = (req: Request, res: Response, next: NextFunction) => {
  if (req.session?.user) {
    req.user = req.session.user;
  }
  next();
};
