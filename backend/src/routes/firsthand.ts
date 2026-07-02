import crypto from 'crypto';

import { Router, Request, Response } from 'express';

import { requireAdmin } from '../middleware/authenticate';
import { asyncHandler } from '../utils/errorHandler';
import { isFirstHandConfigured, firstHandGet } from '../utils/firsthand-client';
import { pool } from '../config';
import { isDatabaseAvailable } from '../utils/database';
import { FirstHandStudy } from '../types';

const router: Router = Router();

const SIGNATURE_HEADER = 'x-firsthand-signature';
const TIMESTAMP_HEADER = 'x-firsthand-timestamp';
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

function verifyCallbackSignature(rawBody: string, headers: Request['headers']): boolean {
  const secret = process.env.FIRSTHAND_INTEGRATION_SECRET?.trim();
  if (!secret) return false;

  const signature = (headers[SIGNATURE_HEADER] as string | undefined)?.trim();
  const timestamp = (headers[TIMESTAMP_HEADER] as string | undefined)?.trim();
  if (!signature || !timestamp) return false;

  const timestampMs = parseInt(timestamp, 10);
  if (!Number.isFinite(timestampMs)) return false;
  if (Math.abs(Date.now() - timestampMs) > SIGNATURE_TOLERANCE_MS) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}\n${rawBody}`)
    .digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length === 0 || sigBuf.length !== expBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// GET /api/firsthand/studies - proxy the FirstHand study list for the Cortex study picker
router.get('/studies', requireAdmin, asyncHandler(async (_req: Request, res: Response) => {
  if (!isFirstHandConfigured()) {
    return res.status(503).json({ error: 'firsthand_not_configured', studies: [] });
  }

  const data = await firstHandGet<{ studies: FirstHandStudy[] }>('/api/studies');
  res.json(data);
}));

// POST /api/firsthand/callbacks - receive lifecycle events from FirstHand
router.post('/callbacks', asyncHandler(async (req: Request, res: Response) => {
  const rawBody = (req as any).rawBody ?? JSON.stringify(req.body);

  if (!verifyCallbackSignature(rawBody, req.headers)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  const { event, session_id, participant_id, external_ref, occurred_at } = req.body;

  if (!event || !session_id || !occurred_at) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const KNOWN_EVENT_TYPES = ['session_started', 'session_completed', 'session_abandoned', 'session_failed'];
  if (!KNOWN_EVENT_TYPES.includes(event)) {
    return res.status(400).json({ error: 'unknown_event_type', event });
  }

  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable && external_ref) {
    try {
      await pool.query(
        `INSERT INTO opportunity_session_events
           (opportunity_id, participant_user_id, firsthand_session_id, event_type, occurred_at, payload)
         VALUES ($1, $2::uuid, $3, $4, $5, $6)
         ON CONFLICT (firsthand_session_id, event_type) DO NOTHING`,
        [
          external_ref,
          participant_id || null,
          session_id,
          event,
          occurred_at,
          JSON.stringify(req.body)
        ]
      );
    } catch (err) {
      // Don't fail the 200 response over a DB error — FirstHand shouldn't retry indefinitely
      console.warn('[firsthand] callback DB insert failed for session', session_id, err);
    }
  }

  res.status(200).json({ received: true });
}));

export default router;
