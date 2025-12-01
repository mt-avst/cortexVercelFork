import { Router } from 'express';
import { requireAuth } from '../middleware/authenticate';
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

const router: Router = Router();

// GET /api/me - Get current user information
router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// Mount opportunities routes
router.use('/opportunities', opportunitiesRouter);

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

export default router;
