import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/authenticate';
import { pool } from '../config';
import { resolveEffectiveRole } from '../config/betaAllAdmin';
import { asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { perUserLimiter } from '../middleware/per-user-rate-limit';
import { validateRequest, profileUpdateSchema } from '../validation/schemas';
import opportunitiesRouter from './opportunities';
import sessionsRouter from './sessions';
import bookingsRouter from './bookings';
import bookingArtifactsRouter from './booking-artifacts';
import calendarRouter from './calendar';
import userCalendarRouter from './userCalendar';
import gamificationRouter from './gamification';
import adminRouter from './admin';
import notificationPreferencesRouter from './notificationPreferences';
import feedbackRouter from './feedback';
import statsRouter from './stats';
import firsthandRouter from './firsthand';
import firsthandSessionRouter from './firsthand-session';
import sessionOutputsRouter from './session-outputs';

const router: Router = Router();

// GET /api/me - Get current user information
// Reports the request-effective role so the client renders admin navigation for
// beta-lifted employees (CORTEX_BETA_ALL_ADMIN). Identity when the switch is off.
//
// `req.user` is a SESSION SNAPSHOT taken at login, so it cannot carry
// profile_roles (which the user edits mid-session via PATCH below). We read the
// profile FRESH from the row here, keyed on the session user's id, so an edit is
// visible on the very next /me without a re-login. null column -> [] so the
// client always sees an array ("is my profile empty" is a length check).
router.get('/me', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  // profile_roles is a DISPLAY-ONLY enrichment. Its read must never decide auth:
  // requireAuth is synchronous, so /me could not 5xx for a live session before
  // this query existed. A DB blip enriching a field must not turn a valid session
  // into a 500, which the client treats as logged-out (AuthContext.setUser(null)).
  // So a failed read degrades to an empty profile, never a failed request.
  let profile_roles: string[] = [];
  try {
    const { rows } = await pool.query<{ profile_roles: string[] | null }>(
      'SELECT profile_roles FROM users WHERE id = $1',
      [req.user!.id]
    );
    profile_roles = rows[0]?.profile_roles ?? [];
  } catch (err: unknown) {
    logger.error('profile_roles read failed on /me; serving the session without it', {
      userId: req.user!.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
  res.json({
    ...req.user,
    role: resolveEffectiveRole(req.user!.role, req.user!.email),
    profile_roles,
  });
}));

// PATCH /api/me/profile - the caller updates their OWN roles/skills profile.
//
// Self-only by construction: the row it writes is keyed on req.user!.id from the
// server-side session, never on anything in the body or path, so a caller cannot
// address another user's row. It is not an admin surface and takes no user id.
// Body validated by profileUpdateSchema (targetRolesSchema.nullable(), strict);
// an empty list or null clears the profile (stored NULL). Rate-limited per user
// like the other authenticated writes. Returns the read-back profile (null -> []).
router.patch(
  '/me/profile',
  requireAuth,
  perUserLimiter(30, 'Too many profile updates; please slow down'),
  validateRequest(profileUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const roles = req.body.profile_roles as string[] | null;
    // Empty list means "no profile" - collapse to NULL so absent and cleared read
    // identically, mirroring the target_roles write path.
    const value = roles && roles.length > 0 ? JSON.stringify(roles) : null;
    const { rows } = await pool.query<{ profile_roles: string[] | null }>(
      'UPDATE users SET profile_roles = $1::jsonb WHERE id = $2 RETURNING profile_roles',
      [value, req.user!.id]
    );
    res.json({ profile_roles: rows[0]?.profile_roles ?? [] });
  })
);

// GET /api/me/session-events - Get the current user's own FirstHand session events
router.get('/me/session-events', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { rows } = await pool.query<{
    id: string; opportunity_id: string; opportunity_title: string;
    type: string; firsthand_session_id: string; event_type: string;
    occurred_at: Date; received_at: Date;
  }>(`
    SELECT e.id, e.opportunity_id, o.title AS opportunity_title, o.type,
           e.firsthand_session_id, e.event_type,
           e.occurred_at, e.received_at
    FROM opportunity_session_events e
    JOIN opportunities o ON e.opportunity_id = o.id
    WHERE e.participant_user_id = $1
    ORDER BY e.occurred_at DESC
    LIMIT 50
  `, [userId]);
  return res.json(rows.map(r => ({
    ...r,
    occurred_at: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at,
    received_at: r.received_at instanceof Date ? r.received_at.toISOString() : r.received_at,
  })));
}));

// Mount opportunities routes
router.use('/opportunities', opportunitiesRouter);

// Mount FirstHand session outputs proxy (GET /:id/sessions/:sessionId/outputs)
router.use('/opportunities', sessionOutputsRouter);

// Mount sessions routes
router.use('/sessions', sessionsRouter);

// Mount bookings routes
router.use('/bookings', bookingsRouter);

// Booking artefacts (#79 step 2) - same prefix, researcher-side ingest of
// recordings and transcripts. A second router on one prefix is the house
// pattern (calendar + userCalendar below).
router.use('/bookings', bookingArtifactsRouter);

// Mount calendar routes (admin calendar)
router.use('/calendar', calendarRouter);

// Mount user calendar routes (user personal calendar)
router.use('/calendar', userCalendarRouter);

// Mount AdaptaBits routes
router.use('/gamification', gamificationRouter);

// Mount admin routes
router.use('/admin', adminRouter);

// Mount notification preferences routes
router.use('/notification-preferences', notificationPreferencesRouter);

// Mount feedback routes
router.use('/feedback', feedbackRouter);

// Mount stats routes (public, no auth required)
router.use('/stats', statsRouter);

// Mount the participant runtime API (B4): requireAuth + token->user binding.
// Registered before the broader '/firsthand' so the specific prefix wins
// regardless of what routes firsthandRouter grows later.
router.use('/firsthand/session', firsthandSessionRouter);

// Mount FirstHand studies routes (admin CRUD plus the study-wide results
// reads). The HMAC callback receiver this comment used to name is gone.
router.use('/firsthand', firsthandRouter);

export default router;
