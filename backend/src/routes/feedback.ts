import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/errorHandler';
import emailService, { EmailService } from '../services/email';
import { logger } from '../utils/logger';

const router = Router();

// POST /api/feedback
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { feedback, category, userAgent, url } = req.body;
  const user = req.user;

  const userName = user?.name || 'Anonymous';
  const userEmail = user?.email || 'Not logged in';

  logger.info('📧 Sending feedback email', { category, userEmail });

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
    logger.error('Failed to send feedback email', result);
    return res.status(500).json({ error: 'Failed to send feedback' });
  }

  res.json({ success: true });
}));

export default router;

