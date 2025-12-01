import { Router, Request, Response, IRouter } from 'express';
import { asyncHandler } from '../utils/errorHandler';
import emailService, { EmailService } from '../services/email';
import { logger } from '../utils/logger';
import { pool } from '../config/index';
import { requireAdmin, requireSuperadmin } from '../middleware/authenticate';

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

// GET /api/feedback - List all feedback (admin access - researcher_admin and superadmin)
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

// GET /api/feedback/export - Export all feedback as CSV (admin access - researcher_admin and superadmin)
router.get('/export', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT id, user_name, user_email, category, feedback, url, user_agent, created_at
     FROM feedback
     ORDER BY created_at DESC`
  );

  // Build CSV content
  const headers = ['ID', 'User Name', 'User Email', 'Category', 'Feedback', 'URL', 'User Agent', 'Created At'];
  const rows = result.rows.map(row => [
    row.id,
    escapeCsvField(row.user_name),
    escapeCsvField(row.user_email),
    escapeCsvField(row.category),
    escapeCsvField(row.feedback),
    escapeCsvField(row.url),
    escapeCsvField(row.user_agent),
    new Date(row.created_at).toISOString()
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.join(','))
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="feedback-export-${new Date().toISOString().split('T')[0]}.csv"`);
  res.send(csvContent);
}));

// Helper function to escape CSV fields
function escapeCsvField(field: string | null | undefined): string {
  if (field === null || field === undefined) {
    return '';
  }
  const str = String(field);
  // If the field contains a comma, newline, or double quote, wrap it in quotes and escape any quotes
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export default router;
