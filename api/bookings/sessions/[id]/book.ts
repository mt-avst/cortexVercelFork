import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../../../db';
import { requireAuth } from '../../../utils/auth';
import { createErrorResponse, getErrorMessage } from '../../../utils/errors';
import emailService, { EmailService } from '../../../services/email';
import { logger } from '../../../utils/logger';

/**
 * POST /api/bookings/sessions/[id]/book
 * Book a session for the authenticated user
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    const { id: sessionId } = req.query;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json(createErrorResponse('Session ID is required'));
    }

    // Get authenticated user from cookie
    const user = requireAuth(req);
    const userId = user.id;

    // Start transaction for atomic booking
    const client = await getPool().connect();
    
    try {
      await client.query('BEGIN');

      // Lock session row for update to prevent race conditions
      const sessionResult = await client.query(`
        SELECT s.*, o.status as opportunity_status, o.title as opportunity_title,
               o.owner_user_id
        FROM sessions s
        JOIN opportunities o ON s.opportunity_id = o.id
        WHERE s.id = $1
        FOR UPDATE NOWAIT
      `, [sessionId]);

      if (sessionResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json(createErrorResponse('Session not found'));
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
        return res.status(404).json(createErrorResponse('Session not found or opportunity not published'));
      }

      if (new Date(session.end_time) <= new Date()) {
        await client.query('ROLLBACK');
        return res.status(400).json(createErrorResponse('Cannot book past sessions'));
      }

      // Check if already booked by this user (only active bookings)
      const existingBooking = await client.query(
        'SELECT id FROM bookings WHERE user_id = $1 AND session_id = $2 AND status = $3',
        [userId, sessionId, 'booked']
      );

      if (existingBooking.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json(createErrorResponse('Already booked for this session'));
      }

      // Check capacity (double-check after lock)
      if (session.booked_count >= session.capacity) {
        await client.query('ROLLBACK');
        return res.status(409).json(createErrorResponse('Session is full'));
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

      // Email notifications (after transaction commit)
      try {
        // Use singleton email service instance
        // Note: Password trimming is handled in EmailService constructor
        
        // Send confirmation email to participant
        const confirmationTemplate = EmailService.getBookingConfirmationTemplate(
          session.opportunity_title,
          user.name,
          new Date(session.start_time),
          new Date(session.end_time),
          session.location_or_meet_link_optional,
          ownerName,
          ownerEmail
        );

        const emailResult = await emailService.sendEmail(
          { email: user.email, name: user.name },
          confirmationTemplate
        );
        
        // Log only if email sending failed (errors are logged in email service)
        if (!emailResult.success) {
          logger.error('Failed to send booking confirmation email', {
            errorMessage: emailResult.error,
            participantEmail: user.email,
          });
        }

        // Send notification to researcher (if enabled in preferences)
        try {
          const prefsResult = await getPool().query(
            `SELECT on_book_email FROM notification_preferences WHERE user_id = $1`,
            [session.owner_user_id]
          );
          
          const shouldNotify = prefsResult.rows.length === 0 || prefsResult.rows[0].on_book_email === true;
          
          if (shouldNotify && session.owner_user_id) {
            const adminTemplate = EmailService.getAdminNotificationTemplate(
              session.opportunity_title,
              user.name,
              user.email,
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
          logger.error('Failed to send admin notification email', {
            errorMessage: prefError instanceof Error ? prefError.message : String(prefError),
          });
          // Don't fail the booking if admin notification fails
        }
      } catch (emailError) {
        logger.error('Failed to send booking confirmation email', {
          errorMessage: emailError instanceof Error ? emailError.message : String(emailError),
        });
        // Don't fail the booking if email fails
      }

      // Return booking with serialized dates
      return res.status(201).json({
        ...booking,
        created_at: booking.created_at.toISOString(),
        updated_at: booking.updated_at.toISOString(),
        cancelled_at: booking.cancelled_at ? booking.cancelled_at.toISOString() : null,
      });

    } catch (error: unknown) {
      await client.query('ROLLBACK');
      
      // Handle specific PostgreSQL errors
      if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') {
        // Lock timeout - session is being booked by another user
        return res.status(409).json(createErrorResponse('Session is being booked by another user. Please try again.'));
      }
      
      throw error;
    } finally {
      client.release();
    }

  } catch (error: unknown) {
    // Handle auth errors
    if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
      return res.status(401).json(createErrorResponse(
        typeof error === 'object' && 'error' in error 
          ? String(error.error) 
          : 'Not authenticated'
      ));
    }

    const errorMessage = getErrorMessage(error);
    return res.status(500).json(
      createErrorResponse('Failed to book session', errorMessage)
    );
  }
}

