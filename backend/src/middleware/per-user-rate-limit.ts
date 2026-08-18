import rateLimit from 'express-rate-limit';
import { Request } from 'express';

/**
 * A per-USER limiter, for routes that already require a session.
 *
 * The anonymous limiters in this codebase (`healthLimiter`,
 * `recordedStudyBriefLimiter`) sit at 600 for a reason worth not repeating:
 * behind two proxy hops `trust proxy: 1` resolves `req.ip` to the INGRESS, so
 * an IP-keyed bucket is shared by every external caller, and a tight limit
 * would let one participant 429 the entire estate.
 *
 * That constraint does not apply to an authenticated route. `req.user.id`
 * comes from the server-side session, so no proxy collapses it and no header
 * spoofs it, and the ceiling can be tight enough to matter.
 *
 * MOUNT IT AFTER THE AUTH MIDDLEWARE, never before: mounted first it would
 * spend a bucket on unauthenticated requests, and `req.user` would be absent.
 * The fallback key exists only because TypeScript cannot know the ordering; if
 * it were ever reached it fails restrictive (one shared bucket) rather than
 * open, which is the right direction for a control to fail in.
 *
 * Lives here rather than in a route file because three route files now need
 * it, and the reasoning above is the part that must not be re-derived
 * differently in each - which is exactly how the two mint routes drifted.
 */
export function perUserLimiter(max: number, message: string) {
  return rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => req.user?.id ?? 'unauthenticated',
    message: { error: message }
  });
}
