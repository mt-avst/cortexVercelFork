import { Router, Request, Response } from 'express';
import { pool } from '../config';
import { requireAuth, optionalAuth } from '../middleware/authenticate';
import { Booking, BookingWithDetails, RescheduleBookingRequest } from '../types';
// import calendarService from '../services/calendar';
import emailService, { EmailService } from '../services/email';
import { AppError, ValidationError, NotFoundError, ForbiddenError, ConflictError, asyncHandler } from '../utils/errorHandler';

const router: Router = Router();

// Helper function to check if database is available
const isDatabaseAvailable = async (): Promise<boolean> => {
  try {
    // Check if DATABASE_URL is set
    if (!process.env.DATABASE_URL) {
      console.log('DATABASE_URL not set, using mock data');
      return false;
    }
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    console.log('Database not available, using mock data:', (error as any).message);
    return false;
  }
};

// Helper function to check session ownership for admin operations
const checkSessionOwnership = async (sessionId: string, userId: string): Promise<boolean> => {
  const result = await pool.query(`
    SELECT o.owner_user_id 
    FROM sessions s 
    JOIN opportunities o ON s.opportunity_id = o.id 
    WHERE s.id = $1
  `, [sessionId]);
  
  return result.rows.length > 0 && result.rows[0].owner_user_id === userId;
};

// POST /api/bookings/sessions/:id/book - Book a session
router.post('/sessions/:id/book', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    throw new AppError('Database not available. Please set up PostgreSQL to book sessions.', 503);
  }

  const { id: sessionId } = req.params;
  const userId = req.user!.id;

  // Start transaction for atomic booking
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock session row for update to prevent race conditions
    const sessionResult = await client.query(`
      SELECT s.*, o.status as opportunity_status, o.title as opportunity_title,
             o.owner_user_id, u.name as owner_name, u.email as owner_email
      FROM sessions s
      JOIN opportunities o ON s.opportunity_id = o.id
      JOIN users u ON o.owner_user_id = u.id
      WHERE s.id = $1
      FOR UPDATE NOWAIT
    `, [sessionId]);

    if (sessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Session');
    }

    const session = sessionResult.rows[0];

    // Guardrails
    if (session.opportunity_status !== 'published') {
      await client.query('ROLLBACK');
      throw new NotFoundError('Opportunity not published');
    }

    if (new Date(session.end_time) <= new Date()) {
      await client.query('ROLLBACK');
      throw new ValidationError('Cannot book past sessions');
    }

    // Check if already booked by this user (only active bookings)
    const existingBooking = await client.query(
      'SELECT id FROM bookings WHERE user_id = $1 AND session_id = $2 AND status = $3',
      [userId, sessionId, 'booked']
    );

    console.log(`Checking existing booking for user ${userId}, session ${sessionId}:`, existingBooking.rows.length > 0);
    console.log(`Session capacity: ${session.capacity}, booked_count: ${session.booked_count}`);
    
    // Also check for any cancelled bookings for debugging
    const cancelledBooking = await client.query(
      'SELECT id, status, cancelled_at FROM bookings WHERE user_id = $1 AND session_id = $2 AND status = $3',
      [userId, sessionId, 'cancelled']
    );
    if (cancelledBooking.rows.length > 0) {
      console.log(`Found cancelled booking:`, cancelledBooking.rows[0]);
    }

    if (existingBooking.rows.length > 0) {
      await client.query('ROLLBACK');
      throw new ConflictError('Already booked for this session');
    }

    // Check capacity (double-check after lock)
    if (session.booked_count >= session.capacity) {
      await client.query('ROLLBACK');
      throw new ConflictError('Session is full');
    }

    // Create booking
    const bookingResult = await client.query(`
      INSERT INTO bookings (user_id, session_id, status)
      VALUES ($1, $2, 'booked')
      RETURNING *
    `, [userId, sessionId]);

    // Increment booked_count atomically
    await client.query(`
      UPDATE sessions 
      SET booked_count = booked_count + 1
      WHERE id = $1
    `, [sessionId]);

    await client.query('COMMIT');

    const booking = bookingResult.rows[0];

    // Calendar integration (after transaction commit)
    let calendarResult = { success: true, eventId: 'demo-event-' + Date.now() };
    try {
      // Mock calendar integration - in production this would call calendarService.createEvent
    } catch (calendarError) {
      console.error('Calendar integration failed:', calendarError);
      calendarResult = { success: false, eventId: undefined as any };
    }

    // Email notifications (after transaction commit)
    try {
      // Send confirmation email to participant
      const confirmationTemplate = EmailService.getBookingConfirmationTemplate(
        session.opportunity_title,
        req.user!.name,
        new Date(session.start_time),
        new Date(session.end_time),
        session.location_or_meet_link_optional,
        session.owner_name,
        session.owner_email
      );

      await emailService.sendEmail(
        { email: req.user!.email, name: req.user!.name },
        confirmationTemplate
      );

      // Send notification to researcher (if enabled)
      // Note: Researcher notification preferences will be implemented in a future release
      const adminTemplate = EmailService.getAdminNotificationTemplate(
        session.opportunity_title,
        req.user!.name,
        req.user!.email,
        new Date(session.start_time),
        new Date(session.end_time),
        'booked'
      );

      await emailService.sendEmail(
        { email: session.owner_email, name: session.owner_name },
        adminTemplate
      );
    } catch (emailError) {
      console.error('Email notification failed:', emailError);
      // Don't fail the booking if email fails
    }

    res.status(201).json({
      id: booking.id,
      session_id: booking.session_id,
      status: booking.status,
      calendar: calendarResult.success ? 'success' : 'error',
      calendarEventId: calendarResult.eventId
    });

  } catch (error) {
    await client.query('ROLLBACK');
    
    // Handle lock timeout specifically
    if ((error as any).code === '55P03') { // Lock not available
      throw new ConflictError('Session is being booked by another user. Please try again.');
    }
    
    throw error;
  } finally {
    client.release();
  }
}));

// POST /api/bookings/:id/cancel - Cancel a booking
router.post('/:id/cancel', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    throw new AppError('Database not available. Please set up PostgreSQL to cancel bookings.', 503);
  }

  const { id: bookingId } = req.params;
  const userId = req.user!.id;
  const isAdmin = req.user!.role === 'researcher_admin';

  // Load booking with session and opportunity details
  const bookingResult = await pool.query(`
    SELECT b.*, s.end_time, s.opportunity_id, o.owner_user_id, o.title as opportunity_title,
           u.name as owner_name, u.email as owner_email
    FROM bookings b
    JOIN sessions s ON b.session_id = s.id
    JOIN opportunities o ON s.opportunity_id = o.id
    JOIN users u ON o.owner_user_id = u.id
    WHERE b.id = $1
  `, [bookingId]);

  if (bookingResult.rows.length === 0) {
    throw new NotFoundError('Booking');
  }

  const booking = bookingResult.rows[0];

  // Authorization check
  const canCancel = booking.user_id === userId || 
                   (isAdmin && booking.owner_user_id === userId);
  
  if (!canCancel) {
    throw new ForbiddenError('Not authorized to cancel this booking');
  }

  // State checks
  if (booking.status === 'cancelled') {
    return res.status(200).json({ message: 'Booking already cancelled' });
  }

  if (new Date(booking.end_time) <= new Date()) {
    throw new ValidationError('Cannot cancel past sessions');
  }

  // Start transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update booking status
    await client.query(`
      UPDATE bookings 
      SET status = 'cancelled', cancelled_at = NOW()
      WHERE id = $1
    `, [bookingId]);

    // Decrement session booked_count (with safeguard to prevent negative values)
    await client.query(`
      UPDATE sessions 
      SET booked_count = GREATEST(booked_count - 1, 0)
      WHERE id = $1
    `, [booking.session_id]);

    await client.query('COMMIT');

    // Calendar cancellation (after transaction commit)
    if (booking.gcal_event_id) {
      try {
        // Mock calendar integration - in production this would call calendarService.deleteEvent
      } catch (calendarError) {
        console.error('Calendar cancellation failed:', calendarError);
        // Don't fail the cancellation if calendar fails
      }
    }

    // Email notifications (after transaction commit)
    try {
      // Send cancellation email to participant
      const cancellationTemplate = EmailService.getBookingCancellationTemplate(
        booking.opportunity_title,
        req.user!.name,
        new Date(booking.end_time),
        new Date(booking.end_time),
        req.user!.name // cancelled by self
      );

      await emailService.sendEmail(
        { email: req.user!.email, name: req.user!.name },
        cancellationTemplate
      );

      // Send notification to researcher (if enabled)
      const adminTemplate = EmailService.getAdminNotificationTemplate(
        booking.opportunity_title,
        req.user!.name,
        req.user!.email,
        new Date(booking.end_time),
        new Date(booking.end_time),
        'cancelled'
      );

      await emailService.sendEmail(
        { email: booking.owner_email, name: booking.owner_name },
        adminTemplate
      );
    } catch (emailError) {
      console.error('Email notification failed:', emailError);
      // Don't fail the cancellation if email fails
    }

    res.json({ message: 'Booking cancelled successfully' });

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

// POST /api/bookings/:id/reschedule - Reschedule a booking
router.post('/:id/reschedule', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    throw new AppError('Database not available. Please set up PostgreSQL to reschedule bookings.', 503);
  }

  const { id: bookingId } = req.params;
  const { target_session_id }: RescheduleBookingRequest = req.body;
  const userId = req.user!.id;

  if (!target_session_id) {
    throw new ValidationError('target_session_id is required');
  }

  // Start transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load booking with current session details
    const bookingResult = await client.query(`
      SELECT b.*, s.opportunity_id as current_opportunity_id
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      WHERE b.id = $1 AND b.user_id = $2 AND b.status = 'booked'
    `, [bookingId, userId]);

    if (bookingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Active booking');
    }

    const booking = bookingResult.rows[0];

    // Load target session with opportunity details
    const targetSessionResult = await client.query(`
      SELECT s.*, o.status as opportunity_status
      FROM sessions s
      JOIN opportunities o ON s.opportunity_id = o.id
      WHERE s.id = $1
      FOR UPDATE NOWAIT
    `, [target_session_id]);

    if (targetSessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Target session');
    }

    const targetSession = targetSessionResult.rows[0];

    // Guardrails
    if (targetSession.opportunity_id !== booking.current_opportunity_id) {
      await client.query('ROLLBACK');
      throw new ValidationError('Target session must be from the same opportunity');
    }

    if (targetSession.opportunity_status !== 'published') {
      await client.query('ROLLBACK');
      throw new ValidationError('Target opportunity not published');
    }

    if (new Date(targetSession.end_time) <= new Date()) {
      await client.query('ROLLBACK');
      throw new ValidationError('Cannot reschedule to past sessions');
    }

    if (targetSession.booked_count >= targetSession.capacity) {
      await client.query('ROLLBACK');
      throw new ConflictError('Target session is full');
    }

    // Lock current session for update
    await client.query(`
      SELECT * FROM sessions WHERE id = $1 FOR UPDATE
    `, [booking.session_id]);

    // Move booking to target session
    await client.query(`
      UPDATE bookings 
      SET session_id = $1
      WHERE id = $2
    `, [target_session_id, bookingId]);

    // Update booked counts atomically (with safeguards)
    await client.query(`
      UPDATE sessions 
      SET booked_count = GREATEST(booked_count - 1, 0)
      WHERE id = $1
    `, [booking.session_id]);

    await client.query(`
      UPDATE sessions 
      SET booked_count = booked_count + 1
      WHERE id = $1
    `, [target_session_id]);

    await client.query('COMMIT');

    // Calendar update (after transaction commit)
    if (booking.gcal_event_id) {
      try {
        const updatedEvent = {
          title: `${targetSession.opportunity_title} with ${req.user!.name}`,
          description: `Research session: ${targetSession.opportunity_title}\n\nPurpose: ${targetSession.opportunity_title}\n\nParticipant: ${req.user!.name} (${req.user!.email})\n\nManage booking: ${process.env.FRONTEND_URL || 'http://localhost:3000'}/my-bookings`,
          startTime: new Date(targetSession.start_time),
          endTime: new Date(targetSession.end_time),
          attendees: [
            { email: req.user!.email, name: req.user!.name },
            { email: targetSession.owner_email, name: targetSession.owner_name }
          ],
          location: targetSession.location_or_meet_link_optional,
          meetLink: true
        };

        // Mock calendar integration - in production this would call calendarService.updateEvent
      } catch (calendarError) {
        console.error('Calendar update failed:', calendarError);
        // Don't fail the reschedule if calendar fails
      }
    }

    // Email notifications (after transaction commit)
    try {
      // Send updated confirmation email to participant
      const confirmationTemplate = EmailService.getBookingConfirmationTemplate(
        targetSession.opportunity_title,
        req.user!.name,
        new Date(targetSession.start_time),
        new Date(targetSession.end_time),
        targetSession.location_or_meet_link_optional,
        targetSession.owner_name,
        targetSession.owner_email
      );

      await emailService.sendEmail(
        { email: req.user!.email, name: req.user!.name },
        confirmationTemplate
      );
    } catch (emailError) {
      console.error('Email notification failed:', emailError);
      // Don't fail the reschedule if email fails
    }

    res.json({ message: 'Booking rescheduled successfully' });

  } catch (error) {
    await client.query('ROLLBACK');
    
    // Handle lock timeout specifically
    if ((error as any).code === '55P03') { // Lock not available
      throw new ConflictError('Session is being modified by another user. Please try again.');
    }
    
    throw error;
  } finally {
    client.release();
  }
}));

// POST /api/bookings/cleanup-cancelled - Clean up cancelled bookings for a user (debug endpoint)
router.post('/cleanup-cancelled', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    
    // Find all cancelled bookings for this user
    const cancelledBookings = await pool.query(`
      SELECT b.*, s.start_time, s.end_time, o.title as opportunity_title
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      WHERE b.user_id = $1 AND b.status = 'cancelled'
    `, [userId]);
    
    console.log(`Found ${cancelledBookings.rows.length} cancelled bookings for user ${userId}`);
    
    // Optionally delete cancelled bookings (uncomment if needed)
    // await pool.query('DELETE FROM bookings WHERE user_id = $1 AND status = $2', [userId, 'cancelled']);
    
    res.json({
      message: `Found ${cancelledBookings.rows.length} cancelled bookings`,
      cancelled_bookings: cancelledBookings.rows.map(booking => ({
        id: booking.id,
        session_id: booking.session_id,
        opportunity_title: booking.opportunity_title,
        cancelled_at: booking.cancelled_at?.toISOString(),
        created_at: booking.created_at.toISOString()
      }))
    });
  } catch (error) {
    console.error('Error cleaning up cancelled bookings:', error);
    res.status(500).json({ error: 'Failed to clean up cancelled bookings' });
  }
});

// GET /api/my/bookings/debug - Debug endpoint to see all bookings (including cancelled)
router.get('/my/bookings/debug', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    
    // Get ALL bookings for this user (including cancelled)
    const allBookingsResult = await pool.query(`
      SELECT b.*, s.start_time as session_start_time, s.end_time as session_end_time,
             o.title as opportunity_title, o.type as opportunity_type
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC
    `, [userId]);
    
    res.json({
      user_id: userId,
      total_bookings: allBookingsResult.rows.length,
      bookings: allBookingsResult.rows.map(booking => ({
        id: booking.id,
        session_id: booking.session_id,
        status: booking.status,
        created_at: booking.created_at.toISOString(),
        cancelled_at: booking.cancelled_at ? booking.cancelled_at.toISOString() : null,
        opportunity_title: booking.opportunity_title,
        opportunity_type: booking.opportunity_type,
        session_start_time: booking.session_start_time.toISOString(),
        session_end_time: booking.session_end_time.toISOString()
      }))
    });
  } catch (error) {
    console.error('Error fetching debug bookings:', error);
    res.status(500).json({ error: 'Failed to fetch debug bookings' });
  }
});

// GET /api/my/bookings - Get user's bookings
router.get('/my/bookings', requireAuth, async (req: Request, res: Response) => {
  try {
    // Check if DATABASE_URL is set - if not, return empty bookings
    if (!process.env.DATABASE_URL) {
      console.log('DATABASE_URL not set, returning empty bookings');
      return res.json({ upcoming: [], past: [] });
    }

    // Check if database is available
    console.log('Checking database availability...');
    const dbAvailable = await isDatabaseAvailable();
    console.log('Database available:', dbAvailable);
    if (!dbAvailable) {
      console.log('Database not available, returning empty bookings');
      return res.json({ upcoming: [], past: [] });
    }

    const userId = req.user!.id;
    const now = new Date();

    // Get upcoming bookings (only active bookings for future sessions)
    const upcomingResult = await pool.query(`
      SELECT b.*, s.start_time as session_start_time, s.end_time as session_end_time, s.capacity as session_capacity,
             s.location_or_meet_link_optional as session_location,
             o.title as opportunity_title, o.type as opportunity_type,
             o.purpose_one_liner as opportunity_purpose,
             u.name as owner_name, u.email as owner_email
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      JOIN users u ON o.owner_user_id = u.id
      WHERE b.user_id = $1 AND b.status = 'booked' AND s.end_time > $2
      ORDER BY s.start_time ASC
    `, [userId, now]);

    // Get past bookings (cancelled bookings OR completed sessions)
    const pastResult = await pool.query(`
      SELECT b.*, s.start_time as session_start_time, s.end_time as session_end_time, s.capacity as session_capacity,
             s.location_or_meet_link_optional as session_location,
             o.title as opportunity_title, o.type as opportunity_type,
             o.purpose_one_liner as opportunity_purpose,
             u.name as owner_name, u.email as owner_email
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      JOIN users u ON o.owner_user_id = u.id
      WHERE b.user_id = $1 AND (b.status = 'cancelled' OR s.end_time <= $2)
      ORDER BY s.start_time DESC
    `, [userId, now]);

    // Serialize dates for API response
    const serializeBooking = (booking: any) => ({
      ...booking,
      session_start_time: booking.session_start_time.toISOString(),
      session_end_time: booking.session_end_time.toISOString(),
      cancelled_at: booking.cancelled_at ? booking.cancelled_at.toISOString() : undefined,
      created_at: booking.created_at.toISOString(),
      updated_at: booking.updated_at.toISOString(),
    });

    res.json({
      upcoming: upcomingResult.rows.map(serializeBooking),
      past: pastResult.rows.map(serializeBooking)
    });

  } catch (error) {
    console.error('Error fetching user bookings:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// GET /api/opportunities/:id/bookings - Get bookings for an opportunity (admin only)
router.get('/opportunities/:id/bookings', requireAuth, async (req: Request, res: Response) => {
  try {
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      return res.json([]);
    }

    const { id: opportunityId } = req.params;
    const userId = req.user!.id;
    const isAdmin = req.user!.role === 'researcher_admin';

    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Check opportunity ownership
    const opportunityCheck = await pool.query(
      'SELECT owner_user_id FROM opportunities WHERE id = $1',
      [opportunityId]
    );

    if (opportunityCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    const isOwner = opportunityCheck.rows[0].owner_user_id === userId;
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the owner can view bookings for this opportunity' });
    }

    // Get bookings with participant details
    const result = await pool.query(`
      SELECT b.*, s.start_time, s.end_time,
             u.name as participant_name, u.email as participant_email,
             u.business_unit, u.role_title
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN users u ON b.user_id = u.id
      WHERE s.opportunity_id = $1
      ORDER BY s.start_time ASC, u.name ASC
    `, [opportunityId]);

    // Serialize dates for API response
    const bookings = result.rows.map(booking => ({
      ...booking,
      session_start_time: booking.session_start_time.toISOString(),
      session_end_time: booking.session_end_time.toISOString(),
      cancelled_at: booking.cancelled_at ? booking.cancelled_at.toISOString() : undefined,
      created_at: booking.created_at.toISOString(),
      updated_at: booking.updated_at.toISOString(),
    }));

    res.json(bookings);

  } catch (error) {
    console.error('Error fetching opportunity bookings:', error);
    res.status(500).json({ error: 'Failed to fetch opportunity bookings' });
  }
});

export default router;
