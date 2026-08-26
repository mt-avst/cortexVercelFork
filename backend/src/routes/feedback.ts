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
 * GET /api/feedback - List all feedback (admin access).
 *
 * ponytail: an unbounded read - no LIMIT and no cursor, so the response grows
 *   with every feedback row ever submitted.
 *   -> #81. NOT fixed by #65, which streamed the two CSV EXPORTS either side
 *      of this. An export's contract is "give me everything", so streaming
 *      removes its ceiling without changing what success means; this route
 *      feeds a UI, so it wants the `has_more` + `?before=` shape that
 *      points-history and #66 already use, and that is a different decision
 *      taken against a frontend caller which actually exists. Filed rather
 *      than folded in.
 */
router.get('/', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT id, user_id, user_name, user_email, category, feedback, url, user_agent, created_at
     FROM feedback
     ORDER BY created_at DESC`
  );

  res.json({ success: true, data: result.rows });
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
