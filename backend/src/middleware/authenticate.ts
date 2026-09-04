import { Request, Response, NextFunction } from 'express';
import { SessionUser, isAdminRole } from '../types';
import { pool } from '../config';
import { resolveEffectiveRole } from '../config/betaAllAdmin';
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
 * successfully" message was untrue when sent.
 *
 * WHO PAYS FOR THE QUERY. FOUR CALLERS, and they differ - `grep -n
 * "currentDbRole(" backend/src/middleware/authenticate.ts`. This is the third
 * revision of this paragraph because the first two tried to describe all of
 * them in one sentence, so it is a list now and each row is measurable.
 *
 * Revision one said the price was fine because admin routes are low-volume -
 * "writes and admin-only reads, never hot participant paths". #45 made that
 * stale by putting the read on `GET /api/opportunities`. Revision two said it
 * "only ever runs for a caller whose session already claims an admin role",
 * which was wrong on arrival: the two gates query FIRST and check the role
 * after, by design, and fetch-then-decide is what makes them live at all.
 *
 *   requireAdmin / requireSuperadmin - EVERY session reaching an admin-gated
 *     route, whatever its role. An `employee` session pays one query and then
 *     gets a 403 (measured). Low-volume by route, so the original
 *     justification still holds for these two.
 *   withLiveRole (#37) - EVERY signed-in session on the three routes that
 *     chain it, none of which is admin-only: `POST /api/bookings/:id/cancel`,
 *     `GET /api/admin/dashboard`, `POST /api/admin/request`. So a participant
 *     cancelling their OWN booking pays one query and gets a 200 (measured).
 *     That is the caller a per-caller ledger most needs to name, and the two
 *     earlier revisions of this block both omitted it.
 *   withLiveRoleIfPresent (#45) - only a session whose stored role is ALREADY
 *     an admin role. That narrowing is what keeps the participant catalogue at
 *     the query count it had; see that function for why it costs no security.
 *
 * So: no signed-out caller ever pays, anywhere. A participant pays exactly
 * where a route decides something from their role without being admin-only -
 * one query for a 403 from a gate, or one query for a 200 on the three
 * `withLiveRole` routes - and never on the `optionalAuth` catalogue.
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
    // Beta switch (temporary): lift an allow-listed `employee` to
    // `researcher_admin` when CORTEX_BETA_ALL_ADMIN is on. Bounded by email
    // domain and never produces `superadmin`, so the superadmin gate below
    // still refuses a lifted employee. The email is the one verified at login.
    return resolveEffectiveRole(result.rows[0].role as AdminRole, req.session!.user!.email);
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

  if (!isAdminRole(role)) {
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

  // Carried for symmetry with `requireAdmin`, but NOT equivalent to it: this
  // gate has already forced `role === 'superadmin'`, so the only caller it can
  // correct is one PROMOTED since login, and no route behind this gate reads
  // `req.user.role` today. Dropping `, role` here therefore passes the whole
  // suite (measured, #38: 1242/1242) - an equivalent mutation, so it gets no
  // mutation-canary entry rather than a false one. `requireAdmin`'s carry two
  // functions up is the load-bearing one and IS pinned.
  //
  // ponytail: unobservable today, kept because the next superadmin-only route
  // to read a role would silently get the stale one.
  //   -> if one ever does, pin it the way admin-gate-carries-live-role-to-the
  //      -handler pins requireAdmin's.
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

/**
 * The `optionalAuth` companion to `withLiveRole` - the #45 member of the family.
 *
 * Five `opportunities.ts` routes are the participant catalogue: they must answer
 * a SIGNED-OUT browser, so they sit on `optionalAuth`, and four of them then
 * branch inline on `req.user?.role` to decide whether the caller sees drafts,
 * `clicks_total`, owner identity and joining links. That branch read the role
 * snapshotted at login, so #14's re-read never reached it and a revoked
 * researcher_admin kept the admin view for up to SESSION_MAX_AGE_MS (24h).
 * `withLiveRole` cannot be chained there: it 401s without a session.
 *
 * NARROWED ON PURPOSE, and the narrowing is the decision #45 asked for. The
 * defect being closed is REVOCATION, so a re-read can only ever take privilege
 * AWAY. A session whose stored role is not already an admin role therefore has
 * nothing to gain from the query, and skipping it keeps `GET /api/opportunities`
 * - a hot participant path - at exactly the query count it had before.
 *
 * THE ACCEPTED TRADE, stated rather than discovered later: a PROMOTION does not
 * take effect until the user's next login. Latency on gaining privilege is
 * accepted; latency on losing it is not. Deliberate asymmetry, not an oversight.
 *
 * ponytail: a freshly-promoted admin gets the participant catalogue for up to
 * SESSION_MAX_AGE_MS (24h), which `POST /api/admin/requests/:id/approve` can
 * actually produce.
 *   -> #55. Refresh the target's stored session role at the point of promotion,
 *      which closes the window without putting a query on any read path.
 *
 * BOTH ADMIN ROLES, and the `superadmin` half is pinned separately. Every arm
 * of the liveness suite drove this with a `researcher_admin` session, so
 * deleting `&& storedRole !== 'superadmin'` passed 1301/1301 - measured by the
 * refute gate on !264 - while re-opening #45 for every superadmin session.
 * Superadmin demotion is real: `admin.ts` deliberately refuses in-API
 * superadmin revocation (#14), so it happens by script or direct SQL, which is
 * exactly the channel this family exists to honour. The suite now drives both
 * roles and `catalogue-live-role-read-covers-superadmin-sessions` is the canary.
 *
 * FAILS CLOSED once it decides to read: on a DB error or a deleted user
 * `currentDbRole` has already answered and this returns without calling next().
 * Before that point it fails OPEN by design - no session, or a non-admin
 * session, is handed straight on, because that is the participant catalogue
 * working as intended.
 *
 * AMENDED (2026-09-04, the day !353 shipped): "stored role is not already an
 * admin role" stopped being the same test as "has nothing to gain from the
 * query" the moment CORTEX_BETA_ALL_ADMIN existed. An allow-listed `employee`
 * can be EFFECTIVELY `researcher_admin` while their session still says
 * `employee` - `requireAdmin` sees that on every write via `currentDbRole`,
 * but this gate's narrowing was reading the pre-lift role, so a beta-lifted
 * researcher could save a draft opportunity and then get `404 Opportunity not
 * found` reading it straight back, on `GET /:id` and filtered out of
 * `GET /api/opportunities` entirely. The narrowing now tests the EFFECTIVE
 * stored role - `resolveEffectiveRole` applied to what the session holds -
 * so a beta-lifted employee is treated as the admin session they actually are,
 * while a non-lifted participant still triggers no query, unchanged.
 */
export const withLiveRoleIfPresent = async (req: Request, res: Response, next: NextFunction) => {
  const rawStoredRole = req.session?.user?.role;
  const storedRole =
    rawStoredRole === undefined
      ? undefined
      : resolveEffectiveRole(rawStoredRole, req.session?.user?.email);
  if (!isAdminRole(storedRole)) {
    return next();
  }

  // `liveAdminRole`, not `liveRole`, so a canary anchor here matches this
  // function only - `withLiveRole` above has the identical call.
  const liveAdminRole = await currentDbRole(req, res);
  if (liveAdminRole === null) {
    return; // response already sent, failing closed
  }

  req.user = { ...req.session!.user!, role: liveAdminRole };
  next();
};

// Optional authentication - attaches user if session exists
export const optionalAuth = (req: Request, res: Response, next: NextFunction) => {
  if (req.session?.user) {
    req.user = req.session.user;
  }
  next();
};
