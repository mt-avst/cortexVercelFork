import { Router } from 'express';
import { requireAuth } from '../middleware/authenticate';
import opportunitiesRouter from './opportunities';
import sessionsRouter from './sessions';
import bookingsRouter from './bookings';
import calendarRouter from './calendar';

const router: Router = Router();

// GET /api/me - Get current user information
router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// Mount opportunities routes
router.use('/opportunities', opportunitiesRouter);

// Mount sessions routes
router.use('/', sessionsRouter);

// Mount bookings routes
router.use('/bookings', bookingsRouter);

// Mount calendar routes
router.use('/calendar', calendarRouter);

export default router;
