import { pool } from '../config';
import emailService, { EmailService } from './email';
import { logger } from '../utils/logger';

export interface ReminderSendSummary {
  sent: number;
  errors: number;
  total: number;
}

export interface ReminderDeps {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  sendEmail: (
    to: { email: string; name: string },
    template: { subject: string; html: string; text: string }
  ) => Promise<{ success: boolean; messageId?: string; error?: string }>;
}

interface DueReminderRow {
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
}

const defaultDeps: ReminderDeps = {
  query: (text, params) => pool.query(text, params as unknown[] | undefined),
  sendEmail: (to, template) => emailService.sendEmail(to, template),
};

/**
 * Sends session reminder emails for bookings whose session starts in ~24 hours
 * (window: 23-25 hours from now, one reminder per booking, tracked via
 * bookings.reminder_sent_at). Ported from the retired Vercel cron handler.
 */
export async function sendDueReminders(
  deps: ReminderDeps = defaultDeps
): Promise<ReminderSendSummary> {
  const now = new Date();
  const windowStart = new Date(now.getTime() + 23 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 25 * 60 * 60 * 1000);

  const result = await deps.query(
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

  const rows = (result.rows as DueReminderRow[]) || [];
  let sent = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const startTime =
        typeof row.start_time === 'string' ? new Date(row.start_time) : row.start_time;
      const endTime =
        typeof row.end_time === 'string' ? new Date(row.end_time) : row.end_time;

      const template = EmailService.getBookingReminderTemplate(
        row.opportunity_title,
        row.participant_name,
        startTime,
        endTime,
        row.meeting_location_optional ?? undefined,
        row.owner_name
      );

      const sendResult = await deps.sendEmail(
        { email: row.participant_email, name: row.participant_name },
        template
      );

      if (sendResult.success) {
        await deps.query('UPDATE bookings SET reminder_sent_at = NOW() WHERE id = $1', [
          row.booking_id,
        ]);
        sent++;
        logger.info('Reminder email sent', {
          bookingId: row.booking_id,
          email: row.participant_email,
        });
      } else {
        errors++;
        logger.warn('Reminder email failed', {
          bookingId: row.booking_id,
          error: sendResult.error,
        });
      }
    } catch (err) {
      errors++;
      logger.error('Reminder send error', { bookingId: row.booking_id, error: err });
    }
  }

  return { sent, errors, total: rows.length };
}
