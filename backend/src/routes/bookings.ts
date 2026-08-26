import { Router, Request, Response } from 'express';
import { pool } from '../config';
import { requireAuth, requireAdmin, optionalAuth, withLiveRole } from '../middleware/authenticate';
import { Booking, BookingWithDetails, RescheduleBookingRequest } from '../types';
import calendarService from '../services/calendar';
import { userCalendarService } from '../services/userCalendar';
import { CalendarEvent } from '../../../shared/types';
import emailService, { EmailService } from '../services/email';
import { AppError, ValidationError, NotFoundError, ForbiddenError, ConflictError, asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { isDatabaseAvailable } from '../utils/database';
import { awardPoints, awardPointsAfterApproval } from '../services/gamification';
import { isOpportunityOwner } from '../utils/opportunityOwnership';

const router: Router = Router();

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
             o.owner_user_id, o.purpose_one_liner, o.id as opportunity_id
      FROM sessions s
      JOIN opportunities o ON s.opportunity_id = o.id
      WHERE s.id = $1
      FOR UPDATE NOWAIT
    `, [sessionId]);

    if (sessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Session');
    }

    const session = sessionResult.rows[0];

    // Get owner user details if they exist
    let ownerName = 'Unknown User';
    let ownerEmail = 'unknown@example.com';
    if (session.owner_user_id) {
      const ownerResult = await client.query(
        'SELECT name, email FROM users WHERE id = $1',
        [session.owner_user_id]
      );
      if (ownerResult.rows.length > 0) {
        ownerName = ownerResult.rows[0].name;
        ownerEmail = ownerResult.rows[0].email;
      }
    }

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

    logger.debug('Checking existing booking', {
      userId,
      sessionId,
      hasExistingBooking: existingBooking.rows.length > 0,
      sessionCapacity: session.capacity,
      bookedCount: session.booked_count
    });
    
    // Also check for any cancelled bookings
    const cancelledBooking = await client.query(
      'SELECT id, status, cancelled_at FROM bookings WHERE user_id = $1 AND session_id = $2 AND status = $3',
      [userId, sessionId, 'cancelled']
    );
    if (cancelledBooking.rows.length > 0) {
      logger.debug('Found cancelled booking', { bookingId: cancelledBooking.rows[0].id });
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
    let calendarResult: { success: boolean; eventId?: string; error?: string } = { success: false };
    try {
      const appBaseUrl = process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'http://localhost:3000';
      const opportunityUrl = `${appBaseUrl}/opportunities/${session.opportunity_id}`;
      
      // Build calendar event description
      const description = `Research session: ${session.opportunity_title}\n\n` +
        `Purpose: ${session.purpose_one_liner || 'Research participation'}\n\n` +
        `Participant: ${req.user!.name} (${req.user!.email})\n\n` +
        `Manage booking: ${appBaseUrl}/my-bookings\n\n` +
        `View opportunity: ${opportunityUrl}`;

      // Create calendar event
      const calendarEvent: CalendarEvent = {
        id: '', // Will be set by calendar service
        title: `${session.opportunity_title} with ${req.user!.name}`,
        start: session.start_time,
        end: session.end_time,
        startTime: new Date(session.start_time),
        endTime: new Date(session.end_time),
        description: description,
        status: 'confirmed',
        location: session.location_or_meet_link_optional || undefined,
        meetLink: !session.location_or_meet_link_optional ? '' : undefined, // Add Meet link if no location provided
        attendees: [
          {
            email: req.user!.email,
            name: req.user!.name,
            responseStatus: 'needsAction'
          },
          {
            email: ownerEmail,
            name: ownerName,
            responseStatus: 'needsAction'
          }
        ]
      };

      const createResult = await calendarService.createEvent(calendarEvent);
      calendarResult = createResult;
      
      // If calendar event was created successfully, update booking with event ID
      if (calendarResult.success && calendarResult.eventId) {
        await pool.query(
          'UPDATE bookings SET gcal_event_id = $1 WHERE id = $2',
          [calendarResult.eventId, booking.id]
        );
        logger.info('Calendar event created and saved', {
          eventId: calendarResult.eventId,
          bookingId: booking.id
        });
      } else {
        logger.warn('Calendar event creation failed', {
          bookingId: booking.id,
          error: createResult.error || 'Unknown error'
        });
      }

      // Note: User calendar events are added via email links (Google Calendar link or .ics file)
      // This avoids requiring write permissions and Google verification
    } catch (calendarError) {
      logger.error('Calendar integration failed', { error: calendarError });
      calendarResult = { success: false, eventId: undefined };
      // Don't fail the booking if calendar fails - booking is already committed
    }

    // Email notifications (after transaction commit)
    try {
      logger.info('📧 Attempting to send booking confirmation email', {
        participantEmail: req.user!.email,
        participantName: req.user!.name,
        opportunityTitle: session.opportunity_title,
      });
      
      // Send confirmation email to participant
      const confirmationTemplate = EmailService.getBookingConfirmationTemplate(
        session.opportunity_title,
        req.user!.name,
        new Date(session.start_time),
        new Date(session.end_time),
        session.location_or_meet_link_optional,
        ownerName,
        ownerEmail
      );

      const emailResult = await emailService.sendEmail(
        { email: req.user!.email, name: req.user!.name },
        confirmationTemplate
      );
      
      logger.info('📧 Email sending result:', {
        success: emailResult.success,
        messageId: emailResult.messageId,
        error: emailResult.error,
      });

      // Send notification to researcher (if enabled in preferences)
      try {
        const prefsResult = await pool.query(
          `SELECT on_book_email FROM notification_preferences WHERE user_id = $1`,
          [session.owner_user_id]
        );
        
        const shouldNotify = prefsResult.rows.length === 0 || prefsResult.rows[0].on_book_email === true;
        
        if (shouldNotify) {
          const adminTemplate = EmailService.getAdminNotificationTemplate(
            session.opportunity_title,
            req.user!.name,
            req.user!.email,
            new Date(session.start_time),
            new Date(session.end_time),
            'booked'
          );

          await emailService.sendEmail(
            { email: ownerEmail, name: ownerName },
            adminTemplate
          );
        }
      } catch (prefError) {
        logger.error('Error checking notification preferences', { error: prefError });
        // Default to sending notification if preference check fails
        try {
          const adminTemplate = EmailService.getAdminNotificationTemplate(
            session.opportunity_title,
            req.user!.name,
            req.user!.email,
            new Date(session.start_time),
            new Date(session.end_time),
            'booked'
          );
          await emailService.sendEmail(
            { email: ownerEmail, name: ownerName },
            adminTemplate
          );
        } catch (emailError) {
          logger.error('Fallback email notification failed', { error: emailError });
        }
      }
    } catch (emailError) {
      logger.error('Email notification failed', { 
        error: emailError instanceof Error ? emailError.message : String(emailError),
        stack: emailError instanceof Error ? emailError.stack : undefined,
      });
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
    
    // Log the specific error for debugging
    interface DatabaseError extends Error {
      code?: string;
      constraint?: string;
      detail?: string;
    }
    const dbError = error as DatabaseError;
    logger.error('Booking error details', {
      error,
      message: dbError.message,
      code: dbError.code,
      constraint: dbError.constraint,
      detail: dbError.detail,
      sessionId,
      userId
    });
    
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
// `withLiveRole` because `isAdmin` below decides whether the caller may cancel
// somebody ELSE out of a session, and `requireAuth` alone would compute it from
// the role stamped into the session at login (#37). The route cannot move to
// `requireAdmin`: it also serves the participant cancelling their own booking.
router.post('/:id/cancel', requireAuth, withLiveRole, asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    throw new AppError('Database not available. Please set up PostgreSQL to cancel bookings.', 503);
  }

  const { id: bookingId } = req.params;
  const userId = req.user!.id;
  const isAdmin = req.user!.role === 'researcher_admin' || req.user!.role === 'superadmin';

  // Load booking with session and opportunity details.
  //
  // TWO JOINS ONTO `users`, AND THE SECOND ONE IS THE FIX. This query joined
  // only `o.owner_user_id` - the OWNER, aliased owner_name/owner_email - and
  // never `b.user_id`. So the participant's identity was never in scope, and
  // `req.user` was the only identity the email block below could reach: the
  // cancellation notice went to whoever pressed the button. When the
  // participant cancelled their own booking that looked right and hid the
  // defect; when a researcher cancelled somebody out of a session, the
  // participant was never told, and the owner's copy named the researcher as
  // the person who had booked.
  //
  // Three documents described behaviour this query could not perform, which is
  // what a missing join costs: a test docblock and a canary `why` both said the
  // handler emails the participant, and neither was wrong about the intent.
  //
  // INNER JOIN, deliberately. `bookings.user_id` is NOT NULL and cascades on
  // user delete, so it cannot drop a row that would otherwise have been found -
  // a LEFT JOIN here would only add a null branch that cannot occur, and would
  // make the 404 below unreachable-looking for the wrong reason.
  //
  // `s.start_time` is selected for a second defect in the same block: both
  // template arguments were `booking.end_time`, so the notice read
  // "Date & Time: 15:00 - 15:00". Nobody had noticed because nobody who did not
  // already know the time was receiving it.
  const bookingResult = await pool.query(`
    SELECT b.*, s.start_time, s.end_time, s.opportunity_id, o.owner_user_id,
           o.title as opportunity_title,
           u.name as owner_name, u.email as owner_email,
           pu.name as participant_name, pu.email as participant_email
    FROM bookings b
    JOIN sessions s ON b.session_id = s.id
    JOIN opportunities o ON s.opportunity_id = o.id
    JOIN users u ON o.owner_user_id = u.id
    JOIN users pu ON b.user_id = pu.id
    WHERE b.id = $1
  `, [bookingId]);

  if (bookingResult.rows.length === 0) {
    throw new NotFoundError('Booking');
  }

  const booking = bookingResult.rows[0];

  // Authorization check
  const canCancel = booking.user_id === userId || 
                   (isAdmin && isOpportunityOwner(booking, req.user));
  
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

    // Cancel and decrement ATOMICALLY, and only on the real booked->cancelled
    // transition. The pre-transaction status read above is a fast path, not a
    // guard: two concurrent cancels of the same booking both saw 'booked'
    // there and both reached this block, and the decrement below was
    // unconditional, so a single cancellation subtracted TWO from booked_count.
    // The GREATEST(...,0) floor kept the number non-negative, not correct - a
    // session at 2 booked dropped to 0, discarding a second participant's slot
    // and letting the session be booked past capacity.
    //
    // The conditional UPDATE is itself the lock. It takes a row-level write
    // lock on the booking; under READ COMMITTED the loser of the race blocks,
    // then re-evaluates its WHERE against the winner's committed row where
    // status is no longer 'booked', so it matches zero rows. rowCount then
    // gates the decrement to exactly the transaction that performed the
    // transition. `status` is an enum of only ('booked','cancelled'), so
    // `= 'booked'` is the whole of "not already cancelled".
    const cancelUpdate = await client.query(`
      UPDATE bookings
      SET status = 'cancelled', cancelled_at = NOW()
      WHERE id = $1 AND status = 'booked'
      RETURNING session_id
    `, [bookingId]);

    const didCancel = cancelUpdate.rowCount === 1;

    if (didCancel) {
      // Decrement the session the booking is CURRENTLY on, read back from the
      // locked UPDATE above via RETURNING - NOT booking.session_id from the
      // unlocked pre-transaction read at the top of the handler. A reschedule
      // committing in the window between that read and this transaction moves
      // the booking S_old -> S_new while leaving status 'booked', so the stale
      // id decremented S_old (double-counting it) and left S_new with a phantom
      // slot until sync-booked-counts ran (cto/AdaptaLabs#31). The conditional
      // UPDATE takes the booking's row-level write lock: a racing reschedule's
      // UPDATE of the same row blocks it, and once that reschedule commits this
      // statement re-reads the committed row, so RETURNING yields the session
      // the booking actually holds now.
      //
      // GREATEST(...,0) is retained defensively; the booked_count >= 0 CHECK
      // constraint would otherwise abort the transaction on an underflow.
      const currentSessionId = cancelUpdate.rows[0].session_id;
      await client.query(`
        UPDATE sessions
        SET booked_count = GREATEST(booked_count - 1, 0)
        WHERE id = $1
      `, [currentSessionId]);
    }

    await client.query('COMMIT');

    // Lost the race: another request cancelled this booking first. It has
    // already decremented the count and sent the notices, so return the same
    // idempotent success the pre-transaction check returns, without sending a
    // second set of emails.
    if (!didCancel) {
      return res.status(200).json({ message: 'Booking already cancelled' });
    }

    // Calendar cancellation (after transaction commit)
    if (booking.gcal_event_id) {
      try {
        const deleteResult = await calendarService.deleteEvent(booking.gcal_event_id);
        
        if (deleteResult.success) {
          logger.info('Calendar event deleted', { eventId: booking.gcal_event_id, bookingId });
        } else {
          // Handle 404 as success (event might already be deleted)
          if (deleteResult.error?.includes('404') || deleteResult.error?.includes('Not Found')) {
            logger.info('Calendar event not found (already deleted)', { eventId: booking.gcal_event_id });
          } else {
            logger.warn('Calendar event deletion failed', { eventId: booking.gcal_event_id, error: deleteResult.error || 'Unknown error' });
          }
        }
      } catch (calendarError) {
        logger.error('Calendar cancellation failed', { bookingId, error: calendarError });
        // Don't fail the cancellation if calendar fails - booking is already cancelled
      }
    }

    // Note: User calendar events are managed via email links (Google Calendar link or .ics file)
    // Users need to manually delete events from their calendars when cancelling
    // This avoids requiring write permissions and Google verification

    // Email notifications (after transaction commit)
    try {
      // Send cancellation email to participant.
      //
      // THE PARTICIPANT, not the caller. `getBookingCancellationTemplate` has
      // always taken `participantName` and `cancelledBy` as SEPARATE
      // parameters - the shape was designed for a third-party cancellation and
      // both arguments were `req.user!.name`, which made the two collapse into
      // one and the "// cancelled by self" comment true only on the
      // participant's own path. The template needed no change; the caller did.
      const cancellationTemplate = EmailService.getBookingCancellationTemplate(
        booking.opportunity_title,
        booking.participant_name,
        new Date(booking.start_time),
        new Date(booking.end_time),
        req.user!.name
      );

      // The RESULT is read, which it was not before. `sendEmail` catches
      // internally and returns `{ success: false, error }` rather than
      // throwing, so the surrounding try/catch never fires on a delivery
      // failure and the handler logged nothing at all - it answered
      // "Booking cancelled successfully" either way. The `book` handler two
      // hundred lines above already does this correctly.
      //
      // That default was survivable while the mail went to the person who
      // pressed the button, since they could see it had not arrived. It is not
      // survivable now: the whole point of this change is that somebody who is
      // NOT in the room has to be told, and a silent failure is exactly the
      // outcome it exists to prevent.
      const cancellationResult = await emailService.sendEmail(
        { email: booking.participant_email, name: booking.participant_name },
        cancellationTemplate
      );

      if (!cancellationResult.success) {
        logger.error('Participant cancellation email failed', {
          bookingId,
          participantUserId: booking.user_id,
          error: cancellationResult.error
        });
      }

      // Send notification to researcher (if enabled in preferences)
      try {
        const prefsResult = await pool.query(
          `SELECT on_cancel_email FROM notification_preferences WHERE user_id = $1`,
          [booking.owner_user_id]
        );
        
        const shouldNotify = prefsResult.rows.length === 0 || prefsResult.rows[0].on_cancel_email === true;
        
        if (shouldNotify) {
          // The owner's copy names the PARTICIPANT, which is the whole
          // content of a "participant cancelled" notice. It named
          // `req.user` too, so an owner cancelling on somebody's behalf was
          // told that they themselves had booked and cancelled.
          const adminTemplate = EmailService.getAdminNotificationTemplate(
            booking.opportunity_title,
            booking.participant_name,
            booking.participant_email,
            new Date(booking.start_time),
            new Date(booking.end_time),
            'cancelled'
          );

          await emailService.sendEmail(
            { email: booking.owner_email, name: booking.owner_name },
            adminTemplate
          );
        }
      } catch (prefError) {
        logger.error('Error checking notification preferences', { error: prefError });
        // Default to sending notification if preference check fails
        try {
          // Same arguments as the preferred path above, for the same reason.
          const adminTemplate = EmailService.getAdminNotificationTemplate(
            booking.opportunity_title,
            booking.participant_name,
            booking.participant_email,
            new Date(booking.start_time),
            new Date(booking.end_time),
            'cancelled'
          );
          await emailService.sendEmail(
            { email: booking.owner_email, name: booking.owner_name },
            adminTemplate
          );
        } catch (emailError) {
          logger.error('Fallback email notification failed', { error: emailError });
        }
      }
    } catch (emailError) {
      logger.error('Email notification failed', { error: emailError });
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

    // Load booking with current session details, TAKING THE BOOKING ROW LOCK.
    //
    // FOR UPDATE OF b, not a bare FOR UPDATE. `OF b` locks only the bookings row;
    // the joined sessions/opportunities rows are read but not locked, so this
    // does NOT reintroduce the blocking session-row wait that #34 removed - the
    // old and target sessions are still locked further down with FOR UPDATE
    // NOWAIT, and this statement holds nothing but the booking row while it runs.
    //
    // Without the lock this SELECT is unlocked, so a cancel committing in the
    // window after it read status='booked' would flip the row to 'cancelled'
    // while the guardless `UPDATE bookings SET session_id ... WHERE id` below
    // still moved it - moving a CANCELLED booking, decrementing the old session
    // twice and leaving the target with a phantom slot (cto/AdaptaLabs#36). It
    // also made the old-session decrement read a stale session_id when two
    // reschedules of one booking raced. Locking the booking row here serialises
    // reschedule against cancel and against other reschedules on that booking:
    // the loser blocks, then re-reads the committed row, and if status is no
    // longer 'booked' the WHERE matches zero rows and the 404 below fires.
    const bookingResult = await client.query(`
      SELECT b.*, s.opportunity_id as current_opportunity_id, o.title as opportunity_title
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      WHERE b.id = $1 AND b.user_id = $2 AND b.status = 'booked'
      FOR UPDATE OF b
    `, [bookingId, userId]);

    if (bookingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Active booking');
    }

    const booking = bookingResult.rows[0];
    const oldSessionId = booking.session_id; // Store old session ID before update

    // Load target session with opportunity details
    const targetSessionResult = await client.query(`
      SELECT s.*, o.status as opportunity_status, o.title as opportunity_title,
             o.purpose_one_liner, o.id as opportunity_id, o.owner_user_id
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

    // Lock the current (old) session too. NOWAIT, like the target lock above,
    // so a reschedule never holds one session lock while WAITING on another -
    // that is what keeps it out of a deadlock cycle with the sync-booked-counts
    // sweep and delete-sessions, both of which lock many session rows at once
    // (cto/AdaptaLabs#34). A contended old session fails fast as a retryable 409
    // via the 55P03 handler below, rather than blocking.
    await client.query(`
      SELECT * FROM sessions WHERE id = $1 FOR UPDATE NOWAIT
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

    // Get owner user details for the target session
    let targetOwnerName = 'Unknown User';
    let targetOwnerEmail = 'unknown@example.com';
    if (targetSession.owner_user_id) {
      const ownerResult = await pool.query(
        'SELECT name, email FROM users WHERE id = $1',
        [targetSession.owner_user_id]
      );
      if (ownerResult.rows.length > 0) {
        targetOwnerName = ownerResult.rows[0].name;
        targetOwnerEmail = ownerResult.rows[0].email;
      }
    }

    // Calendar update (after transaction commit)
    if (booking.gcal_event_id) {
      try {
        const appBaseUrl = process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'http://localhost:3000';
        const opportunityUrl = `${appBaseUrl}/opportunities/${targetSession.opportunity_id}`;
        
        // Build calendar event description
        const description = `Research session: ${targetSession.opportunity_title}\n\n` +
          `Purpose: ${targetSession.purpose_one_liner || 'Research participation'}\n\n` +
          `Participant: ${req.user!.name} (${req.user!.email})\n\n` +
          `Manage booking: ${appBaseUrl}/my-bookings\n\n` +
          `View opportunity: ${opportunityUrl}`;

        // Build calendar event for update
        const calendarEvent: CalendarEvent = {
          id: booking.gcal_event_id,
          title: `${targetSession.opportunity_title} with ${req.user!.name}`,
          start: targetSession.start_time,
          end: targetSession.end_time,
          startTime: new Date(targetSession.start_time),
          endTime: new Date(targetSession.end_time),
          description: description,
          status: 'confirmed',
          location: targetSession.location_or_meet_link_optional || undefined,
          meetLink: !targetSession.location_or_meet_link_optional ? '' : undefined, // Add Meet link if no location provided
          attendees: [
            {
              email: req.user!.email,
              name: req.user!.name,
              responseStatus: 'needsAction'
            },
            {
              email: targetOwnerEmail,
              name: targetOwnerName,
              responseStatus: 'needsAction'
            }
          ]
        };

        // Try to update the existing event
        const updateResult = await calendarService.updateEvent(booking.gcal_event_id, calendarEvent);
        
        if (updateResult.success) {
          logger.info('Calendar event updated', { eventId: booking.gcal_event_id, bookingId });
        } else {
          // If update fails, delete old event and create new one
          logger.warn('Calendar event update failed, attempting delete+create', {
            eventId: booking.gcal_event_id,
            bookingId,
            error: updateResult.error || 'Unknown error'
          });
          
          // Delete old event (ignore 404 errors)
          const deleteResult = await calendarService.deleteEvent(booking.gcal_event_id);
          if (!deleteResult.success && !deleteResult.error?.includes('404') && !deleteResult.error?.includes('Not Found')) {
            logger.warn('Could not delete old calendar event', { eventId: booking.gcal_event_id, error: deleteResult.error });
          }
          
          // Create new event
          const createResult = await calendarService.createEvent(calendarEvent);
          
          if (createResult.success && createResult.eventId) {
            // Update booking with new event ID
            await pool.query(
              'UPDATE bookings SET gcal_event_id = $1 WHERE id = $2',
              [createResult.eventId, bookingId]
            );
            logger.info('Calendar event recreated', { newEventId: createResult.eventId, bookingId });
          } else {
            logger.warn('Calendar event recreation failed', { bookingId, error: createResult.error || 'Unknown error' });
          }
        }
      } catch (calendarError) {
        logger.error('Calendar update failed', { bookingId, error: calendarError });
        // Don't fail the reschedule if calendar fails - booking is already rescheduled
      }
    }

    // Note: User calendar events are managed via email links (Google Calendar link or .ics file)
    // Users need to manually update their calendars when rescheduling
    // This avoids requiring write permissions and Google verification

    // Email notifications (after transaction commit)
    try {
      // Send updated confirmation email to participant
      // `targetOwnerName` / `targetOwnerEmail`, not `targetSession.owner_*`.
      //
      // THE SAME DEFECT CLASS THIS COMMIT EXISTS TO CLOSE, one handler down,
      // and a review gate found it by reading beside the diff. `targetSession`
      // comes from a SELECT over `sessions` joined to `opportunities`, and
      // `sessions` has no `owner_name` or `owner_email` column - the string
      // appears nowhere in db/migrate.ts. Both arguments were `undefined` at
      // runtime, and this handler had ALREADY resolved the right values forty
      // lines above, passing them to the calendar attendee list and never to
      // the email.
      //
      // It degraded silently rather than rendering "undefined", which is why
      // nobody saw it: the template guards with `${ownerName ? ... : ''}` and
      // generateICSFile guards `organizerEmail`, so a participant who
      // rescheduled simply got a confirmation with no researcher on it and a
      // calendar file with no organiser. Proved inert by mutation - replacing
      // both arguments with a literal `undefined` changed nothing across all
      // 973 tests.
      const confirmationTemplate = EmailService.getBookingConfirmationTemplate(
        targetSession.opportunity_title,
        req.user!.name,
        new Date(targetSession.start_time),
        new Date(targetSession.end_time),
        targetSession.location_or_meet_link_optional,
        targetOwnerName,
        targetOwnerEmail
      );

      await emailService.sendEmail(
        { email: req.user!.email, name: req.user!.name },
        confirmationTemplate
      );
    } catch (emailError) {
      logger.error('Email notification failed', { error: emailError });
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

// `POST /cleanup-cancelled` USED TO SIT HERE, ON requireAuth, AND IS DELETED
// DELIBERATELY (cto/AdaptaLabs#49). It cleaned nothing up: one owner-scoped
// SELECT of the caller's own cancelled bookings, with a commented-out
// `DELETE FROM bookings WHERE user_id = $1 AND status = $2` under "uncomment if
// needed". Not the escalation it was raised as - `$1` was always `req.user!.id`
// - but a route named for a bulk mutation, carrying that mutation ready to
// uncomment, on the weakest gate we have, and with no caller anywhere in the
// tree. `GET /my/bookings/all` below returns a superset of what it returned,
// which is the whole of the "nothing is lost" argument and the reason that
// route was renamed out of "debug" rather than deleted beside this one (#54).
//
// Pinned in bookings.cleanup-cancelled-is-gone.test.ts, which fails BY NAME if
// it comes back.

/**
 * GET /api/bookings/my/bookings/all - the caller's OWN bookings, cancelled ones
 * included, owner-scoped by `WHERE b.user_id = $1`.
 *
 * IT WAS CALLED `/my/bookings/debug` UNTIL cto/AdaptaLabs#54, and the rename is
 * the whole change - same gate, same statement, same response. A route named
 * "debug" tells the next reader it is disposable, and this one is not: the
 * comment above and `bookings.cleanup-cancelled-is-gone.test.ts` both rest the
 * argument that #49's deletion cost nothing on THIS route returning a superset
 * of what the deleted one returned. Deleting it would have quietly invalidated
 * a merged MR's rationale, which is exactly what a confident cleanup does to a
 * route whose name invites one.
 *
 * `GET /my/bookings` below is the participant-facing surface and it splits
 * active bookings into upcoming and past. This one is the flat, unfiltered
 * view, which is why the cancelled rows only exist here.
 *
 * SO IT IS A TEST-FIXTURE SURFACE, and #54 asked for it to be named as one
 * rather than dressed up as a feature. Its only consumer in the tree is the
 * suite; nothing in the product wants a cancelled-bookings view and this route
 * is not an argument that anything should. It is here because a merged
 * deletion's correctness argument observes cancelled bookings through it, and
 * that is the entire justification.
 *
 * ponytail: an unbounded read - no LIMIT and no cursor, so the response grows
 * with the caller's whole booking history.
 *   -> #66. A bare LIMIT would silently truncate a route whose contract is
 *      "all of them", so the bound wants keyset pagination on the
 *      `(created_at, id)` this already orders by, or a decision that it is not
 *      worth having.
 */
router.get('/my/bookings/all', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    
    // Get ALL bookings for this user (including cancelled).
    //
    // NOT `b.*`, for the reason the sibling route below already carries in
    // full: the bookings row holds admin_notes - a researcher's free-text
    // judgement about this participant - plus approved_by and approved_at, and
    // spreading the row reads all of it out of the database. That leak has
    // happened here before, on `GET /my/bookings`, and is recorded at
    // learnings.md:349.
    //
    // THE RESPONSE MAP IS NOT THE GUARD. It was the only thing keeping those
    // three columns off the wire on this route, and a refute gate proved the
    // guard was worth nothing by adding `admin_notes: booking.admin_notes` to
    // the map: 1313 passed / 1313 on the mutated tree and on the baseline,
    // interleaved. Nothing in the backend suite could see it. So the fix is at
    // the PROJECTION, like the sibling's, which removes the class rather than
    // the instance - a column never read cannot be mapped by accident.
    //
    // Pinned by `sends no researcher-only column to the caller, whatever the
    // row carries` in bookings.cleanup-cancelled-is-gone.test.ts, which asserts
    // both halves: the projection does not say `b.*`, and a row carrying all
    // three fields reaches the caller with none of them.
    const ownBookingColumns = `
      b.id, b.session_id, b.status, b.created_at, b.cancelled_at
    `;

    const allBookingsResult = await pool.query(`
      SELECT ${ownBookingColumns},
             s.start_time as session_start_time, s.end_time as session_end_time,
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
    // "debug" is gone from the client-visible string too (#54). The defect that
    // issue closed was a name telling the next reader this route is
    // disposable, and a 500 body saying "debug bookings" serves that name
    // straight to the caller.
    logger.error('Error fetching all bookings for user', { error });
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// GET /api/my/bookings - Get user's bookings
router.get('/my/bookings', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  try {
    // No bare process.env.DATABASE_URL check here: Kubera injects DB_URL, not
    // DATABASE_URL, so that guard returned empty bookings on a working
    // database. isDatabaseAvailable() already covers configuration (via
    // hasDatabaseConfig) and connectivity.
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      logger.warn('Database not available, returning empty bookings');
      return res.json({ upcoming: [], past: [] });
    }

    const userId = req.user!.id;
    const now = new Date();

    // Get upcoming bookings (only active bookings for future sessions)
    // NOT `b.*`. The bookings row carries admin_notes - a researcher's free-text
    // judgement about this participant, written on a surface labelled "Admin
    // Notes (Optional)" - plus approved_by and approved_at. Spreading the row
    // sent all of it to the participant's browser; nothing rendered it, so it
    // was invisible in the UI and fully readable in the Network tab. The two
    // fields the participant-facing page actually needs are completion_status
    // and completed_at, so narrowing costs nothing.
    const participantBookingColumns = `
      b.id, b.user_id, b.session_id, b.status, b.completion_status, b.completed_at,
      b.cancelled_at, b.gcal_event_id, b.reminder_sent_at, b.created_at, b.updated_at
    `;

    const upcomingResult = await pool.query(`
      SELECT ${participantBookingColumns}, s.start_time as session_start_time, s.end_time as session_end_time, s.capacity as session_capacity,
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
      SELECT ${participantBookingColumns}, s.start_time as session_start_time, s.end_time as session_end_time, s.capacity as session_capacity,
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
    interface BookingRow {
      session_start_time: Date;
      session_end_time: Date;
      cancelled_at?: Date | null;
      created_at: Date;
      updated_at: Date;
      [key: string]: unknown;
    }
    const serializeBooking = (booking: BookingRow) => ({
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
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error fetching user bookings', { error });
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
}));

// GET /api/opportunities/:id/bookings - Get bookings for an opportunity (admin only)
// `requireAdmin`, not `requireAuth` plus an inline `isAdmin` (#37). The inline
// version computed the role from the session stamped at login, so #14's
// live-role re-read never reached this route and a revoked admin kept the
// listing for up to SESSION_MAX_AGE_MS. The gate is a straight swap: the
// middleware's 403 body is the same `Admin access required` the handler sent,
// and it still runs before the ownership check below.
router.get('/opportunities/:id/bookings', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  try {
    // No `isDatabaseAvailable()` fast-path here. It used to return `200 []` in
    // developer mock-data mode, but `requireAdmin` now runs a role query first
    // and that query fails in exactly the mode the fast-path existed for, so
    // the branch became unreachable: mock-data mode answers 503 from the gate.
    // Kept out rather than left in as code that cannot run.
    const { id: opportunityId } = req.params;

    // Check opportunity ownership
    const opportunityCheck = await pool.query(
      'SELECT owner_user_id FROM opportunities WHERE id = $1',
      [opportunityId]
    );

    if (opportunityCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    const isOwner = isOpportunityOwner(opportunityCheck.rows[0], req.user);
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the owner can view bookings for this opportunity' });
    }

    // Get bookings with participant details
    const result = await pool.query(`
      SELECT b.*, s.start_time as session_start_time, s.end_time as session_end_time,
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
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error fetching opportunity bookings', { error });
    res.status(500).json({ error: 'Failed to fetch opportunity bookings' });
  }
}));

// POST /api/bookings/sessions/:id/complete - Mark session as completed and award AdaptaBits
router.post('/sessions/:id/complete', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    throw new AppError('Database not available. Please set up PostgreSQL to complete sessions.', 503);
  }

  const { id: sessionId } = req.params;
  const userId = req.user!.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get session and opportunity details
    const sessionResult = await client.query(`
      SELECT s.*, o.type as opportunity_type, o.title as opportunity_title,
             o.owner_user_id, b.id as booking_id, b.status as booking_status
      FROM sessions s
      JOIN opportunities o ON s.opportunity_id = o.id
      LEFT JOIN bookings b ON s.id = b.session_id AND b.user_id = $1 AND b.status = 'booked'
      WHERE s.id = $2
    `, [userId, sessionId]);

    if (sessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Session');
    }

    const session = sessionResult.rows[0];

    // Check if user has an active booking for this session
    if (!session.booking_id) {
      await client.query('ROLLBACK');
      throw new ValidationError('You are not booked for this session');
    }

    // Check if session has already ended (can only complete after session ends)
    const now = new Date();
    const sessionEndTime = new Date(session.end_time);
    
    if (now < sessionEndTime) {
      await client.query('ROLLBACK');
      throw new ValidationError('Cannot complete session before it ends');
    }

    // Check if session has already been marked as completed
    const existingCompletion = await client.query(`
      SELECT completion_status FROM bookings 
      WHERE user_id = $1 AND session_id = $2 AND completion_status != 'pending'
    `, [userId, sessionId]);

    if (existingCompletion.rows.length > 0) {
      await client.query('ROLLBACK');
      throw new ConflictError('Session completion already submitted');
    }

    // Mark session as completed (pending admin approval)
    await client.query(`
      UPDATE bookings 
      SET completion_status = 'completed', completed_at = NOW()
      WHERE user_id = $1 AND session_id = $2
    `, [userId, sessionId]);

    await client.query('COMMIT');

    res.json({
      message: 'Session completion submitted successfully. Awaiting admin approval for AdaptaBits.',
      status: 'completed',
      awaitingApproval: true
    });

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

// GET /api/bookings/pending-approvals - Get sessions pending admin approval
router.get('/pending-approvals', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    throw new AppError('Database not available. Please set up PostgreSQL to view pending approvals.', 503);
  }

  const userId = req.user!.id;

  // Check if user is admin
  const userResult = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
  if (userResult.rows.length === 0 || (userResult.rows[0].role !== 'researcher_admin' && userResult.rows[0].role !== 'superadmin')) {
    throw new ForbiddenError('Only admins can view pending approvals');
  }

  // Scoped to the caller's own opportunities, exactly as approve and reject
  // beside it already are ("You can only approve sessions for your own
  // opportunities"). This gated on the admin ROLE alone, so every
  // researcher_admin could read every other researcher's completed sessions -
  // participant names, participant EMAILS, and `admin_notes`, which is a
  // researcher's written judgement of a named colleague. `o.owner_user_id` was
  // already in the SELECT; nothing ever compared it to the reader.
  //
  // Filtered in SQL rather than after the fetch: filtering in JS would still
  // pull every other researcher's notes and emails across the wire and into
  // this process, which is the disclosure, not the rendering of it.
  //
  // Superadmins are exempt, because they can approve any session anyway - the
  // list would otherwise hide work they are expected to act on.
  const isSuperadmin = userResult.rows[0].role === 'superadmin';

  const result = await pool.query(`
    SELECT 
      b.id as booking_id,
      b.user_id,
      b.session_id,
      b.completed_at,
      b.admin_notes,
      u.name as user_name,
      u.email as user_email,
      s.start_time,
      s.end_time,
      o.title as opportunity_title,
      o.type as opportunity_type,
      o.owner_user_id
    FROM bookings b
    JOIN users u ON b.user_id = u.id
    JOIN sessions s ON b.session_id = s.id
    JOIN opportunities o ON s.opportunity_id = o.id
    WHERE b.completion_status = 'completed'
      ${isSuperadmin ? '' : 'AND o.owner_user_id = $1'}
    ORDER BY b.completed_at ASC
  `, isSuperadmin ? [] : [userId]);

  res.json(result.rows);
}));

// POST /api/bookings/:bookingId/approve - Approve a completed session
router.post('/:bookingId/approve', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    throw new AppError('Database not available. Please set up PostgreSQL to approve sessions.', 503);
  }

  const { bookingId } = req.params;
  const { adminNotes } = req.body;
  const adminId = req.user!.id;

  // Check if user is admin
  const userResult = await pool.query('SELECT role FROM users WHERE id = $1', [adminId]);
  if (userResult.rows.length === 0 || (userResult.rows[0].role !== 'researcher_admin' && userResult.rows[0].role !== 'superadmin')) {
    throw new ForbiddenError('Only admins can approve sessions');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get booking details
    const bookingResult = await client.query(`
      SELECT b.*, s.start_time, s.end_time, o.title as opportunity_title, o.type as opportunity_type,
             o.owner_user_id, u.name as user_name
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      JOIN users u ON b.user_id = u.id
      WHERE b.id = $1 AND b.completion_status = 'completed'
    `, [bookingId]);

    if (bookingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Completed session booking');
    }

    const booking = bookingResult.rows[0];

    // Check if admin owns the opportunity or is a superadmin (superadmins can approve any session)
    const isSuperadmin = userResult.rows[0].role === 'superadmin';
    if (!isSuperadmin && !isOpportunityOwner(booking, req.user)) {
      await client.query('ROLLBACK');
      throw new ForbiddenError('You can only approve sessions for your own opportunities');
    }

    // Update booking status to approved
    await client.query(`
      UPDATE bookings 
      SET completion_status = 'approved', 
          approved_at = NOW(), 
          approved_by = $1,
          admin_notes = $2
      WHERE id = $3
    `, [adminId, adminNotes || null, bookingId]);

    await client.query('COMMIT');

    // Award AdaptaBits after approval
    const pointsResult = await awardPointsAfterApproval(
      booking.user_id,
      booking.opportunity_type,
      booking.opportunity_id,
      booking.session_id,
      adminId
    );

    res.json({
      message: 'Session approved successfully',
      pointsAwarded: pointsResult.points,
      newLevel: pointsResult.newLevel,
      levelUp: pointsResult.levelUp,
      totalPoints: pointsResult.totalPoints
    });

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

// POST /api/bookings/:bookingId/reject - Reject a completed session
router.post('/:bookingId/reject', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    throw new AppError('Database not available. Please set up PostgreSQL to reject sessions.', 503);
  }

  const { bookingId } = req.params;
  const { adminNotes } = req.body;
  const adminId = req.user!.id;

  // Check if user is admin
  const userResult = await pool.query('SELECT role FROM users WHERE id = $1', [adminId]);
  if (userResult.rows.length === 0 || (userResult.rows[0].role !== 'researcher_admin' && userResult.rows[0].role !== 'superadmin')) {
    throw new ForbiddenError('Only admins can reject sessions');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get booking details
    const bookingResult = await client.query(`
      SELECT b.*, o.owner_user_id
      FROM bookings b
      JOIN sessions s ON b.session_id = s.id
      JOIN opportunities o ON s.opportunity_id = o.id
      WHERE b.id = $1 AND b.completion_status = 'completed'
    `, [bookingId]);

    if (bookingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Completed session booking');
    }

    const booking = bookingResult.rows[0];

    // Check if admin owns the opportunity or is a superadmin (superadmins can reject any session)
    const isSuperadmin = userResult.rows[0].role === 'superadmin';
    if (!isSuperadmin && !isOpportunityOwner(booking, req.user)) {
      await client.query('ROLLBACK');
      throw new ForbiddenError('You can only reject sessions for your own opportunities');
    }

    // Update booking status to rejected
    await client.query(`
      UPDATE bookings 
      SET completion_status = 'rejected', 
          approved_at = NOW(), 
          approved_by = $1,
          admin_notes = $2
      WHERE id = $3
    `, [adminId, adminNotes || null, bookingId]);

    await client.query('COMMIT');

    res.json({
      message: 'Session rejected successfully',
      status: 'rejected'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

export default router;
