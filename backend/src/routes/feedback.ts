import { Router, Request, Response, IRouter } from 'express';
import { asyncHandler } from '../utils/errorHandler';
import emailService, { EmailService } from '../services/email';
import { logger } from '../utils/logger';
import { pool } from '../config/index';
import { requireAdmin, requireSuperadmin } from '../middleware/authenticate';
// cto/AdaptaLabs#65. Replaces this file's private `escapeCsvField`, which
// quoted but did not neutralise spreadsheet formulas - on the one export whose
// cells are free text from any authenticated user, read by a superadmin.
import { csvCell } from '../utils/csv-cell';
import { streamCsvExport } from '../utils/csv-stream';

const router: IRouter = Router();

/**
 * The most rows GET /api/feedback will put in one response. cto/AdaptaLabs#81.
 *
 * A policy number: the UI copy in AdminFeedback.tsx states it, the pinning
 * test asserts it as a literal, and #86 is the ticket that would replace it
 * with a cursor. Change all of them together or none.
 */
export const FEEDBACK_LIST_LIMIT = 1000;

// POST /api/feedback - Submit feedback (saves to database, optionally sends email)
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { feedback, category, userAgent, url } = req.body;
  const user = req.user;

  const userName = user?.name || 'Anonymous';
  const userEmail = user?.email || 'Not logged in';
  const userId = user?.id || null;

  logger.info('📝 Saving feedback to database', { category, userEmail });

  // Save feedback to database
  try {
    await pool.query(
      `INSERT INTO feedback (user_id, user_name, user_email, category, feedback, url, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, userName, userEmail, category, feedback, url || 'Unknown', userAgent || req.headers['user-agent'] || 'Unknown']
    );
    logger.info('✅ Feedback saved to database');
  } catch (dbError) {
    logger.error('Failed to save feedback to database', { error: dbError instanceof Error ? dbError : undefined, errorMessage: String(dbError) });
    return res.status(500).json({ error: 'Failed to save feedback' });
  }

  // Optionally try to send email notification (don't fail if it doesn't work)
  try {
    const template = EmailService.getFeedbackTemplate(
      category,
      feedback,
      userName,
      userEmail,
      userAgent || req.headers['user-agent'] || 'Unknown',
      url || 'Unknown'
    );

    const result = await emailService.sendEmail(
      { email: 'nfine@adaptavist.com', name: 'Nick Fine' },
      template
    );

    if (!result.success) {
      logger.warn('Email notification failed, but feedback was saved to database');
    }
  } catch (emailError) {
    logger.warn('Email notification failed, but feedback was saved to database', { error: emailError instanceof Error ? emailError : undefined, errorMessage: String(emailError) });
  }

  res.json({ success: true });
}));

/**
 * GET /api/feedback - List the most recent feedback (admin access). Bounded
 * since cto/AdaptaLabs#81 - it read the whole table before.
 *
 * The shape is a fixed cap plus `has_more`, NOT the `?before=` keyset that
 * points-history and the bookings list use (#81's option 3, Nick's call).
 * The one consumer, AdminFeedback.tsx, sorts client-side on three fields over
 * the whole loaded set; a `(created_at, id)` keyset can preserve exactly one
 * of those sorts, so a cursor here is a visible UX change, not a drop-in.
 *
 * We fetch cap+1 and derive `has_more` from the sentinel row, so the flag is
 * measured by the same read it describes rather than by a COUNT that could
 * race it. The sentinel row never reaches the wire. `id DESC` tiebreaks equal
 * timestamps for the same reason the export's keyset carries the id: two rows
 * in one request share a created_at, and an unstable order across refreshes
 * reads as rows appearing and vanishing.
 *
 * ponytail: past FEEDBACK_LIST_LIMIT rows the UI shows only the newest cap
 *   and the streamed CSV export is the route to the rest.
 *   -> #86, the (created_at, id) cursor rework, triggered if `has_more: true`
 *      ever shows up in production responses - which the handler now LOGS, so
 *      the trigger is greppable rather than dependent on an admin mentioning
 *      the notice in the UI.
 */
router.get('/', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT id, user_id, user_name, user_email, category, feedback, url, user_agent, created_at
     FROM feedback
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [FEEDBACK_LIST_LIMIT + 1]
  );

  const hasMore = result.rows.length > FEEDBACK_LIST_LIMIT;
  const rows = hasMore ? result.rows.slice(0, FEEDBACK_LIST_LIMIT) : result.rows;

  if (hasMore) {
    /*
     * THE TRIGGER FOR cto/AdaptaLabs#86, MADE OBSERVABLE.
     *
     * The cap is a deliberate deferral and it comes with a condition for
     * revisiting it: the table outgrowing the cap. That condition was detectable
     * only by an admin noticing the notice in the UI and mentioning it to
     * someone - which is a hope rather than a signal, and the sort of trigger
     * that is discovered years later in a support conversation.
     *
     * `warn` rather than `info` so it survives a level filter, and one line per
     * list request is bounded by admin activity rather than by the table.
     */
    logger.warn('Feedback list truncated at its cap; the keyset rework is cto/AdaptaLabs#86', {
      cap: FEEDBACK_LIST_LIMIT,
    });
  }

  res.json({ success: true, data: rows, has_more: hasMore });
}));

// DELETE /api/feedback/:id - Delete a feedback item (superadmin only)
router.delete('/:id', requireSuperadmin, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const result = await pool.query(
    `DELETE FROM feedback WHERE id = $1 RETURNING id`,
    [id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Feedback not found' });
  }

  logger.info('🗑️ Feedback deleted', { id });
  res.json({ success: true });
}));

/**
 * GET /api/feedback/export - the feedback CSV, STREAMED. #65.
 *
 * Was `SELECT ... FROM feedback ORDER BY created_at DESC` with no LIMIT,
 * mapped into an array of strings, joined and sent in one go. #65 measured the
 * query at 247ms over 200,000 rows, so the ceiling was never the query - it
 * was holding the whole result set and the whole CSV on the heap at once.
 *
 * THE FORMULA NEUTRALISATION MATTERS MORE HERE THAN ANYWHERE ELSE IN THE TREE,
 * and it was missing. `feedback`, `url` and `user_agent` are free text
 * submitted by ANY authenticated user; the person who opens this CSV is a
 * researcher_admin or a superadmin. The route-local `escapeCsvField` quoted
 * those fields and stopped there, so a feedback body of
 * `=HYPERLINK("http://evil.test")` arrived in an admin's spreadsheet as a live
 * formula. The survey export had been fixed for exactly this; this one had a
 * separate copy of the escaping and so never was. See utils/csv-cell.ts.
 *
 * `id` IS IN THE KEY because `created_at` is not unique - two submissions in
 * the same request share it - and a batch boundary between two equal
 * timestamps would drop one silently under `created_at` alone.
 */
router.get('/export', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const headers = ['ID', 'User Name', 'User Email', 'Category', 'Feedback', 'URL', 'User Agent', 'Created At'];

  // A string, not a Date: node-pg's Date holds ms, TIMESTAMPTZ holds µs, and a
  // truncated cursor ends the walk after one batch on any µs-bearing row. See
  // the fuller note on the bookings export in admin.ts - same fix, same reason.
  type FeedbackCursor = { createdAt: string; id: string };

  await streamCsvExport<FeedbackCursor>({
    res,
    filename: `feedback-export-${new Date().toISOString().split('T')[0]}.csv`,
    headerRow: headers.join(','),
    context: { route: 'GET /api/feedback/export', userId: req.user?.id },
    readBatch: async (cursor, limit) => {
      const result = await pool.query(
        `SELECT id, user_name, user_email, category, feedback, url, user_agent, created_at,
                created_at::text AS cursor_created_at
         FROM feedback
         WHERE ($1::timestamptz IS NULL
                OR (created_at, id) < ($1::timestamptz, $2::uuid))
         ORDER BY created_at DESC, id DESC
         LIMIT $3`,
        [cursor?.createdAt ?? null, cursor?.id ?? null, limit]
      );

      const rows = result.rows.map(row => [
        // The uuid and the ISO timestamp are ours, within a known shape, so
        // they stay unprefixed and keep their type in the sheet. Everything
        // between them was typed by a person.
        csvCell(String(row.id ?? ''), false),
        csvCell(String(row.user_name ?? ''), true),
        csvCell(String(row.user_email ?? ''), true),
        csvCell(String(row.category ?? ''), true),
        csvCell(String(row.feedback ?? ''), true),
        csvCell(String(row.url ?? ''), true),
        csvCell(String(row.user_agent ?? ''), true),
        csvCell(new Date(row.created_at).toISOString(), false)
      ].join(','));

      const last = result.rows[result.rows.length - 1];

      return {
        rows,
        nextCursor:
          result.rows.length === limit && last
            ? { createdAt: String(last.cursor_created_at), id: String(last.id) }
            : undefined
      };
    }
  });
}));

export default router;
