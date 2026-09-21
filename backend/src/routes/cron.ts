import { createHash, timingSafeEqual } from 'node:crypto';

import { Router, Request, Response } from 'express';

import { sendDueReminders } from '../services/reminders';
import { asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';

const router: Router = Router();

/**
 * CONSTANT-TIME COMPARISON OF THE CRON BEARER HEADER. cto/AdaptaLabs#22.
 *
 * This was a plain `!==` on a shared secret, which is a byte-by-byte compare
 * that returns at the first difference.
 *
 * COMPARES DIGESTS, NOT THE SECRETS. `timingSafeEqual` THROWS on unequal-length
 * buffers, so the obvious fix needs a length check first - and a length check on
 * a shared secret is the leak moved rather than closed: an early return on
 * `length` tells a caller the secret's length, which is the one thing about it
 * that narrows a search. Hashing both sides to a fixed 32 bytes removes both
 * problems at once: the buffers are always the same size, so it cannot throw,
 * and no branch anywhere depends on what the caller sent.
 *
 * `sha256` UNSALTED IS DELIBERATE and is not being used as a password hash. Both
 * digests are computed in this process, compared, and discarded; neither is
 * stored, so there is nothing for a rainbow table to attack that is not already
 * `process.env.CRON_SECRET` sitting in the same memory.
 *
 * THE ONE EARLY RETURN IS ON THE SERVER'S OWN CONFIGURATION, never on the
 * caller's input. An unset CRON_SECRET must refuse everything rather than
 * authenticate a caller who also sends nothing, and its absence is not a secret
 * from anybody - it is the deployment's own state.
 */
function bearerMatches(authHeader: string | undefined, cronSecret: string | undefined): boolean {
  if (!cronSecret) return false;

  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

  return timingSafeEqual(digest(authHeader ?? ''), digest(`Bearer ${cronSecret}`));
}

/**
 * GET /api/cron/send-reminders
 * Manual/ops trigger for the daily reminder job (the in-process scheduler in
 * server.ts runs it automatically). Secured by CRON_SECRET via
 * Authorization: Bearer <CRON_SECRET>.
 */
router.get(
  '/send-reminders',
  asyncHandler(async (req: Request, res: Response) => {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization;

    if (!bearerMatches(authHeader, cronSecret)) {
      logger.warn('Cron send-reminders: unauthorized or missing CRON_SECRET');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const summary = await sendDueReminders();
    return res.status(200).json({ ok: true, ...summary });
  })
);

export default router;
