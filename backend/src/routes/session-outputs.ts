import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

import { Router, Request, Response } from 'express';
import { z } from 'zod';

import { requireAdmin } from '../middleware/authenticate';
import { asyncHandler, NotFoundError, ForbiddenError, ValidationError } from '../utils/errorHandler';
import { isFirstHandConfigured, firstHandGet, FirstHandHttpError } from '../utils/firsthand-client';
import { pool } from '../config';
import { isDatabaseAvailable } from '../utils/database';
import { logger } from '../utils/logger';
import { FirstHandSessionOutputs, SessionUser } from '../types';
import { isFirstHandInternalEnabled } from '../firsthand/internal-flag';
import {
  getRuntimeAsset,
  getRuntimeSession,
  listRuntimeSessionAttempts
} from '../firsthand/runtime-repository';
import {
  buildSessionOutputs,
  isPlayableMimeType,
  sessionOutputsSchema
} from '../firsthand/session-outputs';
import { createRecordingAssetResponse } from '../firsthand/object-storage';

const router: Router = Router();

const attemptQuerySchema = z.coerce.number().int().positive().optional();

// The firsthand runtime pool runs `SET search_path TO firsthand, public` on its
// own (separate) connections. These authz queries run on Cortex's default pool,
// but they are schema-qualified to `public` so they can never resolve against a
// firsthand-schema relation regardless of search_path state — defence in depth
// that also survives the Phase C single-database cutover.
async function assertOpportunityOwnership(opportunityId: string, user: SessionUser): Promise<void> {
  const result = await pool.query(
    'SELECT owner_user_id FROM public.opportunities WHERE id = $1',
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
    'SELECT 1 FROM public.opportunity_session_events WHERE opportunity_id = $1 AND firsthand_session_id = $2 LIMIT 1',
    [opportunityId, sessionId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Session');
  }
}

// Assemble session outputs in-process from the internalised runtime engine
// (B3c). Every playable asset's media_url is an absolute Cortex URL built from
// the trusted FRONTEND_URL (never req headers — a forged Host/X-Forwarded-Proto
// must not be able to poison a minted media_url) and pointing at the media route
// below — never the standalone FirstHand HMAC URL the ported buildSessionOutputs
// would otherwise mint (hence mediaUrl: null here). The URL carries the
// reviewer's own :id/:sessionId, so the media route re-runs the same owner +
// session-scoping gate; there is no signed capability to retarget.
async function serveInternalOutputs(
  req: Request,
  res: Response,
  opportunityId: string,
  sessionId: string
): Promise<Response> {
  await assertSessionBelongsToOpportunity(opportunityId, sessionId);

  const attemptResult = attemptQuerySchema.safeParse(req.query.attempt);
  if (!attemptResult.success) {
    throw new ValidationError('attempt must be a positive integer');
  }

  const session = await getRuntimeSession(sessionId, {
    attemptNumber: attemptResult.data
  });

  if (!session) {
    throw new NotFoundError('Session outputs');
  }

  const attempts = await listRuntimeSessionAttempts(session.logicalSessionId);
  const outputs = buildSessionOutputs(
    session,
    attempts.length > 0 ? attempts : [session],
    { mediaUrl: null }
  );

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const assets = outputs.assets.map((asset) => ({
    ...asset,
    media_url: isPlayableMimeType(asset.mime_type)
      ? `${frontendUrl}/api/opportunities/${encodeURIComponent(opportunityId)}` +
        `/sessions/${encodeURIComponent(sessionId)}` +
        `/assets/${encodeURIComponent(asset.asset_id)}/media`
      : null
  }));

  const validated = sessionOutputsSchema.safeParse({ ...outputs, assets });
  if (!validated.success) {
    logger.error('FirstHand internal outputs failed validation', {
      sessionId,
      issues: validated.error.flatten()
    });
    return res.status(500).json({ error: 'outputs_assembly_failed' });
  }

  return res.json(validated.data);
}

// GET /api/opportunities/:id/sessions/:sessionId/outputs - session outputs
// (transcript, participant responses, asset metadata) for the opportunity owner.
// Flag-gated (correction C1): FIRSTHAND_INTERNAL serves the in-process engine;
// otherwise the HMAC proxy to standalone FirstHand is kept unchanged.
router.get(
  '/:id/sessions/:sessionId/outputs',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id, sessionId } = req.params;

    if (!(await isDatabaseAvailable())) {
      return res.status(503).json({ error: 'Database not available' });
    }

    await assertOpportunityOwnership(id, req.user!);

    if (isFirstHandInternalEnabled()) {
      return serveInternalOutputs(req, res, id, sessionId);
    }

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

// Storage-layer headers copied verbatim onto the client response. This is an
// explicit allowlist (a deliberate trust boundary): createRecordingAssetResponse
// only ever sets these, and we do NOT want a future storage change to leak
// arbitrary S3/origin headers through.
const FORWARDED_MEDIA_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'content-disposition'
] as const;

// GET /api/opportunities/:id/sessions/:sessionId/assets/:assetId/media - stream a
// session recording to the opportunity owner (B3c). Same-origin replacement for
// FirstHand's HMAC-signed media route: the short-lived signature is dropped and
// access is gated by the reviewer's cookie session plus the same owner +
// session-scoping chain as the outputs route. getRuntimeAsset binds the asset to
// the path :sessionId (across its attempts), so the URL cannot be retargeted to a
// recording outside this owner's session. GET is CSRF-exempt and needs no body
// parser; only nginx needs Range/buffering tuning (C2, before FIRSTHAND_INTERNAL
// is flipped on).
router.get(
  '/:id/sessions/:sessionId/assets/:assetId/media',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id, sessionId, assetId } = req.params;

    if (!(await isDatabaseAvailable())) {
      return res.status(503).json({ error: 'Database not available' });
    }

    await assertOpportunityOwnership(id, req.user!);

    if (!isFirstHandInternalEnabled()) {
      return res.status(503).json({ error: 'FirstHand internal engine not enabled' });
    }

    await assertSessionBelongsToOpportunity(id, sessionId);

    const asset = await getRuntimeAsset(sessionId, assetId);
    if (!asset) {
      throw new NotFoundError('Recording');
    }

    // Serve only audio/video - the same gate the outputs route applies when it
    // mints media_url. Combined with X-Content-Type-Options: nosniff below, this
    // stops a participant-uploaded object with an HTML-ish mime type from being
    // served inline, same-origin, under an admin cookie (content-type confusion).
    if (!isPlayableMimeType(asset.mimeType)) {
      throw new NotFoundError('Recording');
    }

    let mediaResponse: globalThis.Response;
    try {
      mediaResponse = await createRecordingAssetResponse(asset, {
        rangeHeader: req.headers.range ?? null
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      // A genuinely missing object is a clean 404 (e.g. a legacy row pointing at
      // a deleted key). Anything else - IRSA/bucket-policy misconfig, throttling,
      // network - must surface as a 500 with a log so a broken cutover is visible
      // rather than masquerading as "recording not found".
      if (name === 'NoSuchKey' || name === 'NotFound') {
        throw new NotFoundError('Recording');
      }
      logger.error('FirstHand media asset unreadable', { sessionId, assetId, error: err });
      throw err instanceof Error ? err : new Error('Media asset unreadable');
    }

    for (const header of FORWARDED_MEDIA_HEADERS) {
      const value = mediaResponse.headers.get(header);
      if (value !== null) {
        res.setHeader(header, value);
      }
    }
    // Consent-gated media: never let a shared cache store it, never let a browser
    // sniff the content type away from the validated audio/video type.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(mediaResponse.status);

    if (!mediaResponse.body) {
      // 416 unsatisfiable and any empty-body response carry headers only.
      res.end();
      return;
    }

    const nodeStream = Readable.fromWeb(
      mediaResponse.body as NodeWebReadableStream<Uint8Array>
    );
    nodeStream.on('error', (streamErr) => {
      logger.error('FirstHand media stream failed mid-flight', {
        sessionId,
        assetId,
        error: streamErr
      });
      if (res.headersSent) {
        // Bytes already on the wire: the only correct move is to break the
        // response so the client sees a truncated transfer, not a clean end.
        res.destroy(streamErr);
        return;
      }
      // Nothing written yet: drop the content headers we optimistically set for
      // the stream (a stale Content-Length/Content-Range would hang the client
      // or trip ERR_HTTP_CONTENT_LENGTH_MISMATCH) and send a clean 500.
      for (const header of FORWARDED_MEDIA_HEADERS) {
        res.removeHeader(header);
      }
      res.status(500).json({ error: 'media_stream_failed' });
    });
    nodeStream.pipe(res);
  })
);

export default router;
