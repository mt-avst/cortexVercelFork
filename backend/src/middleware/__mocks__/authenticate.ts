import { Request, Response, NextFunction } from 'express';

/**
 * Manual mock of the auth middleware for ROUTE integration suites.
 *
 * The real `requireAdmin`/`requireSuperadmin` re-read the live role from the
 * database on every request (the #14 liveness fix). Route suites drive the
 * handlers with a positionally-sequenced `pool.query` mock and inject a session
 * user directly, so the extra leading role query would consume the first queued
 * result and shift every subsequent one. Those suites test route behaviour, not
 * auth liveness - that is covered by `authenticate.test.ts` and the
 * `admin-gate-rereads-live-role-from-db` mutation canary.
 *
 * This double preserves the exact role-GATING contract the suites assert
 * (401 when unauthenticated, 403 on the wrong role, otherwise `req.user` set and
 * `next()`), reading the role straight off the injected session - i.e. the
 * pre-#14 behaviour, with no database call. Opt in per suite with
 * `jest.mock('../../middleware/authenticate')`.
 */

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.user = req.session.user;
  next();
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.session.user.role !== 'researcher_admin' && req.session.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.user = req.session.user;
  next();
};

export const requireSuperadmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.session.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required' });
  }
  req.user = req.session.user;
  next();
};

export const optionalAuth = (req: Request, _res: Response, next: NextFunction) => {
  if (req.session?.user) {
    req.user = req.session.user;
  }
  next();
};
