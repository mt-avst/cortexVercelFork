import { Router, Request, Response } from 'express';

import { sendDueReminders } from '../services/reminders';
import { asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';

const router: Router = Router();

/**
 * GET /api/cron/send-reminders
 * Manual/ops trigger for the daily reminder job (the in-process scheduler in
 * index.ts runs it automatically). Secured by CRON_SECRET via
 * Authorization: Bearer <CRON_SECRET>.
 */
router.get(
  '/send-reminders',
  asyncHandler(async (req: Request, res: Response) => {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      logger.warn('Cron send-reminders: unauthorized or missing CRON_SECRET');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const summary = await sendDueReminders();
    return res.status(200).json({ ok: true, ...summary });
  })
);

export default router;
