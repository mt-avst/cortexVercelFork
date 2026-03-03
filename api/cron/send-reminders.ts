import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import emailService, { EmailService } from '../services/email';
import { logger } from '../utils/logger';
import { createSafeErrorResponse } from '../utils/errors';

/**
 * GET /api/cron/send-reminders
 * Sends session reminder emails for bookings whose session starts in ~24 hours.
 * Secured by CRON_SECRET (Vercel Cron sends Authorization: Bearer <CRON_SECRET>).
 * Run migrations first to add reminder_sent_at to bookings.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn('Cron send-reminders: unauthorized or missing CRON_SECRET');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Window: sessions starting between 23 and 25 hours from now (send one reminder per booking)
    const now = new Date();
    const windowStart = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    const bookingsResult = await query(
      `SELECT b.id AS booking_id,
              b.user_id,
              b.session_id,
              s.start_time,
              s.end_time,
              o.title AS opportunity_title,
              o.meeting_location_optional,
              o.owner_user_id,
              pu.name AS participant_name,
              pu.email AS participant_email,
              ou.name AS owner_name
       FROM bookings b
       JOIN sessions s ON s.id = b.session_id
       JOIN opportunities o ON o.id = s.opportunity_id
       JOIN users pu ON pu.id = b.user_id
       JOIN users ou ON ou.id = o.owner_user_id
       WHERE b.status = $1
         AND b.reminder_sent_at IS NULL
         AND s.start_time >= $2
         AND s.start_time <= $3
       ORDER BY s.start_time ASC`,
      ['booked', windowStart.toISOString(), windowEnd.toISOString()]
    );

    const rows = (bookingsResult.rows as Array<{
      booking_id: string;
      user_id: string;
      session_id: string;
      start_time: Date | string;
      end_time: Date | string;
      opportunity_title: string;
      meeting_location_optional: string | null;
      owner_user_id: string;
      participant_name: string;
      participant_email: string;
      owner_name: string;
    }>) || [];

    let sent = 0;
    let errors = 0;

    for (const row of rows) {
      try {
        const startTime = typeof row.start_time === 'string' ? new Date(row.start_time) : row.start_time;
        const endTime = typeof row.end_time === 'string' ? new Date(row.end_time) : row.end_time;
        const template = EmailService.getBookingReminderTemplate(
          row.opportunity_title,
          row.participant_name,
          startTime,
          endTime,
          row.meeting_location_optional ?? undefined,
          row.owner_name
        );

        const result = await emailService.sendEmail(
          { email: row.participant_email, name: row.participant_name },
          template
        );

        if (result.success) {
          await query(
            'UPDATE bookings SET reminder_sent_at = NOW() WHERE id = $1',
            [row.booking_id]
          );
          sent++;
          logger.info('Reminder email sent', { bookingId: row.booking_id, email: row.participant_email });
        } else {
          errors++;
          logger.warn('Reminder email failed', { bookingId: row.booking_id, error: result.error });
        }
      } catch (err) {
        errors++;
        logger.error('Reminder send error', { bookingId: row.booking_id, error: err });
      }
    }

    return res.status(200).json({
      ok: true,
      sent,
      errors,
      total: rows.length,
    });
  } catch (err: unknown) {
    logger.error('Cron send-reminders failed', { error: err });
    const safe = createSafeErrorResponse(err, { userMessage: 'Send reminders failed' });
    return res.status(500).json({ error: safe.error });
  }
}
