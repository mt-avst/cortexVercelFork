import crypto from 'crypto';

import { Router, Request, Response } from 'express';

import { requireAdmin } from '../middleware/authenticate';
import { asyncHandler } from '../utils/errorHandler';
import { pool } from '../config';
import { isDatabaseAvailable } from '../utils/database';
import {
  createStudy,
  deleteStudy,
  getStudyById,
  isStudiesPersistenceConfigured,
  listStudies,
  updateStudy
} from '../firsthand/studies-repository';
import {
  createStudyRequestSchema,
  updateStudyRequestSchema
} from '../../../shared/firsthand/study-input';

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

// ─── Studies CRUD (B3a) ──────────────────────────────────────────────────────
// In-process studies persistence, replacing the FirstHand HMAC proxy. Gated on
// Cortex requireAdmin (H4): FirstHand's reviewer OIDC (reviewer-auth-server /
// reviewer-auth / reviewer-oidc / requireStaffPageSession) is intentionally NOT
// ported — the Cortex backend is the single Okta owner and admins are the sole
// study authors.

// Mirrors FirstHand's requireStaff persistence guard: fail loud with 503 when
// no runtime database is configured so a misconfig never silently no-ops.
function ensureStudiesPersistence(res: Response): boolean {
  if (!isStudiesPersistenceConfigured()) {
    res.status(503).json({
      error: 'persistence_not_configured',
      message: 'Studies require a configured PostgreSQL database.'
    });
    return false;
  }
  return true;
}

// GET /api/firsthand/studies - list studies for the Cortex study picker
router.get('/studies', requireAdmin, asyncHandler(async (_req: Request, res: Response) => {
  // listStudies() returns [] when persistence is unconfigured, matching the
  // FirstHand list endpoint's soft-empty behaviour.
  const studies = await listStudies();
  res.json({ studies });
}));

// POST /api/firsthand/studies - create a study
router.post('/studies', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const parsed = createStudyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  }

  try {
    const stored = await createStudy(parsed.data);
    return res.status(201).json({ study: stored.study, steps: stored.steps });
  } catch (error) {
    return res.status(400).json({
      error: 'create_failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

// GET /api/firsthand/studies/:studyId - fetch a single study with its steps
router.get('/studies/:studyId', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const stored = await getStudyById(req.params.studyId);
  if (!stored) {
    return res.status(404).json({ error: 'not_found' });
  }

  return res.json({ study: stored.study, steps: stored.steps });
}));

// PUT /api/firsthand/studies/:studyId - update a study
router.put('/studies/:studyId', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const parsed = updateStudyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  }

  try {
    const updated = await updateStudy(req.params.studyId, parsed.data);
    if (!updated) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({ study: updated.study, steps: updated.steps });
  } catch (error) {
    return res.status(400).json({
      error: 'update_failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

// DELETE /api/firsthand/studies/:studyId - delete a study
router.delete('/studies/:studyId', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const removed = await deleteStudy(req.params.studyId);
  if (!removed) {
    return res.status(404).json({ error: 'not_found' });
  }

  return res.json({ ok: true });
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
