import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/authenticate';
import { pool } from '../config';
import { asyncHandler } from '../utils/errorHandler';
import opportunitiesRouter from './opportunities';
import sessionsRouter from './sessions';
import bookingsRouter from './bookings';
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
router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// GET /api/me/session-events - Get the current user's own FirstHand session events
router.get('/me/session-events', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { rows } = await pool.query<{
    id: string; opportunity_id: string; opportunity_title: string;
    firsthand_session_id: string; event_type: string;
    occurred_at: Date; received_at: Date;
  }>(`
    SELECT e.id, e.opportunity_id, o.title AS opportunity_title,
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
