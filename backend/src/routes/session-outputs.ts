import { Router, Request, Response } from 'express';
import { z } from 'zod';

import { requireAdmin } from '../middleware/authenticate';
import { asyncHandler, NotFoundError, ForbiddenError, ValidationError } from '../utils/errorHandler';
import { isFirstHandConfigured, firstHandGet, FirstHandHttpError } from '../utils/firsthand-client';
import { pool } from '../config';
import { isDatabaseAvailable } from '../utils/database';
import { FirstHandSessionOutputs, SessionUser } from '../types';

const router: Router = Router();

const attemptQuerySchema = z.coerce.number().int().positive().optional();

async function assertOpportunityOwnership(opportunityId: string, user: SessionUser): Promise<void> {
  const result = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [opportunityId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }

  const isOwner = result.rows[0].owner_user_id === user.id;
  const isSuperadmin = user.role === 'superadmin';

  if (!isOwner && !isSuperadmin) {
    throw new ForbiddenError('Only the opportunity owner can view session outputs');
  }
}

async function assertSessionBelongsToOpportunity(opportunityId: string, sessionId: string): Promise<void> {
  const result = await pool.query(
    'SELECT 1 FROM opportunity_session_events WHERE opportunity_id = $1 AND firsthand_session_id = $2 LIMIT 1',
    [opportunityId, sessionId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Session');
  }
}

// GET /api/opportunities/:id/sessions/:sessionId/outputs - proxy FirstHand session outputs
// (transcript, participant responses, asset metadata) for the opportunity owner
router.get(
  '/:id/sessions/:sessionId/outputs',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id, sessionId } = req.params;

    if (!(await isDatabaseAvailable())) {
      return res.status(503).json({ error: 'Database not available' });
    }

    await assertOpportunityOwnership(id, req.user!);

    if (!isFirstHandConfigured()) {
      return res.status(503).json({ error: 'FirstHand integration not configured' });
    }

    await assertSessionBelongsToOpportunity(id, sessionId);

    const attemptResult = attemptQuerySchema.safeParse(req.query.attempt);
    if (!attemptResult.success) {
      throw new ValidationError('attempt must be a positive integer');
    }

    const attemptSuffix = attemptResult.data ? `?attempt=${attemptResult.data}` : '';
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/outputs${attemptSuffix}`;

    try {
      const outputs = await firstHandGet<FirstHandSessionOutputs>(path);
      res.json(outputs);
    } catch (err) {
      if (err instanceof FirstHandHttpError && err.status === 404) {
        throw new NotFoundError('Session outputs');
      }
      if (err instanceof FirstHandHttpError && err.status === 503) {
        return res.status(503).json({ error: 'FirstHand integration unavailable' });
      }
      throw err;
    }
  })
);

export default router;
