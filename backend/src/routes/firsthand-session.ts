import { Readable } from 'node:stream';

import { Router, Request, Response } from 'express';
import { z } from 'zod';

import { requireAuth } from '../middleware/authenticate';
import { bindParticipantSession } from '../middleware/firsthand-session';
import { asyncHandler } from '../utils/errorHandler';
import { parseSessionAttemptNumber } from '../firsthand/session-attempts';
import { runtimeMutationSchema } from '../firsthand/runtime-records';
import {
  applyRuntimeMutation,
  getRuntimeSession,
  registerPendingRecordingUpload,
  resolvePendingRecordingUpload,
  saveUploadedRecordingAsset,
  seedRuntimeSession
} from '../firsthand/runtime-repository';
import { deleteStoredObject, storeRecordingObject } from '../firsthand/object-storage';
import {
  createPresignedRecordingUploadUrl,
  headS3ObjectSize
} from '../firsthand/runtime-object-storage-s3';
import { normalizeRecordingMimeType } from '../firsthand/recording-mime';
import { getMaximumRecordingSizeBytes } from '../firsthand/recording-limits';
import { buildStorageFileName } from '../firsthand/storage-file-name';
import { autoGenerateTranscriptForSession } from '../firsthand/transcript-automation';
import { recordInternalSessionEvent } from '../firsthand/completion-events';

// --- Participant runtime API (B4) ---
// The internalised, logged-in equivalent of FirstHand's
// src/app/api/session/[token]/* Next.js route handlers. Every route is guarded
// by requireAuth + bindParticipantSession (H3): the opaque token is bound to
// req.user.id, so a leaked token replayed by a different Cortex user gets 403.
// Anonymous OIDC / participant cookies are dropped, not ported (decision 7).
//
// Storage is S3-only (H9): FirstHand's getObjectStorageMode selector and the
// @vercel/blob + filesystem branches are excised. client-upload presigns a PUT
// direct to S3 and finalize verifies it with HeadObject; both carry tiny JSON
// bodies and mount under the global express.json (the seam correction: NOT
// express.raw). The recording blob PUT goes browser->S3 and never transits the
// backend. CSRF is header-based (x-csrf-token) and applies to these mutating
// routes; GET is auto-exempt.

const router: Router = Router();

const PENDING_UPLOAD_VALIDITY_MS = 15 * 60 * 1000;

const s3UploadRequestSchema = z.object({
  durationSeconds: z.number().nonnegative().nullable(),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  fileSizeBytes: z.number().int().positive()
});

const s3FinalizeSchema = z.object({
  durationSeconds: z.number().nonnegative().nullable(),
  objectKey: z.string().min(1)
});

// req.query values are string | string[] | ParsedQs - only a bare string is a
// valid attempt selector; anything else is treated as "unspecified".
function attemptFromQuery(req: Request): number | null {
  const raw = req.query.attempt;
  return parseSessionAttemptNumber(typeof raw === 'string' ? raw : null);
}

function headerString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function parseUploadFileName(headerValue: string | null): string {
  if (!headerValue) {
    return `session-${Date.now()}.webm`;
  }
  try {
    const decoded = decodeURIComponent(headerValue);
    return decoded.length > 0 ? decoded : `session-${Date.now()}.webm`;
  } catch {
    return `session-${Date.now()}.webm`;
  }
}

const guard = [requireAuth, bindParticipantSession];

// GET /:token - resolve the bound session payload for the participant surface.
router.get(
  '/:token',
  guard,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(req.firsthandSession);
  })
);

// GET /:token/runtime - the current (or a specific attempt's) runtime snapshot.
router.get(
  '/:token/runtime',
  guard,
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.firsthandSession!;
    const runtimeSession = await seedRuntimeSession(payload);
    const attempt = attemptFromQuery(req);
    const selected = attempt
      ? await getRuntimeSession(payload.session.session_id, { attemptNumber: attempt })
      : runtimeSession;

    res.json(selected ?? runtimeSession);
  })
);

// POST /:token/runtime - apply a runtime mutation (event / response / recording
// state). A truncated/abandoned body is parsed to {} by express.json and fails
// the schema with 422 (never a 500); a genuinely malformed JSON body is turned
// into a clean 400 by the global error handler's body-parser mapping.
router.post(
  '/:token/runtime',
  guard,
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.firsthandSession!;
    const attempt = attemptFromQuery(req);
    const parsedMutation = runtimeMutationSchema.safeParse(req.body);

    if (!parsedMutation.success) {
      return res.status(422).json({
        error: 'invalid_runtime_mutation',
        issues: parsedMutation.error.flatten()
      });
    }

    const session = await applyRuntimeMutation(payload, parsedMutation.data, {
      attemptNumber: attempt ?? undefined
    });

    // Replaces FirstHand's HMAC maybeSendLifecycleCallback: internal sessions
    // record lifecycle events straight into opportunity_session_events. Fire and
    // forget - the helper never throws.
    void recordInternalSessionEvent(payload, parsedMutation.data, session);

    return res.json(session);
  })
);

// POST /:token/recording - server-proxied upload. The video/webm body streams
// straight to S3 (express.json is content-type-gated and leaves it untouched).
// The production path is client-upload+finalize (direct-to-S3); this route is
// kept for parity and local/dev where a direct PUT is unavailable.
router.post(
  '/:token/recording',
  guard,
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.firsthandSession!;
    const attempt = attemptFromQuery(req);
    const maximumRecordingSizeBytes = getMaximumRecordingSizeBytes();

    const contentLength = headerString(req.headers['content-length']);
    if (contentLength === '0') {
      return res.status(422).json({ error: 'missing_recording_stream' });
    }
    // Cheap early reject for an honest oversized upload. A lying/absent
    // content-length is still caught post-upload by the HeadObject check below,
    // so the cap holds either way.
    if (contentLength && Number(contentLength) > maximumRecordingSizeBytes) {
      return res.status(413).json({
        error: 'recording_too_large',
        maximumSizeInBytes: maximumRecordingSizeBytes
      });
    }

    const fileName = parseUploadFileName(
      headerString(req.headers['x-firsthand-file-name'])
    );
    const durationRaw = headerString(req.headers['x-firsthand-duration-seconds']);
    const durationSeconds =
      typeof durationRaw === 'string' && durationRaw.length > 0
        ? Number(durationRaw)
        : null;
    const mimeType = normalizeRecordingMimeType(
      headerString(req.headers['x-firsthand-mime-type']) ??
        headerString(req.headers['content-type']) ??
        'video/webm'
    );

    try {
      const seededSession = await seedRuntimeSession(payload);
      const runtimeSession = attempt
        ? await getRuntimeSession(payload.session.session_id, { attemptNumber: attempt })
        : seededSession;

      if (!runtimeSession) {
        return res.status(404).json({ error: 'invalid_runtime_attempt' });
      }

      const storedObject = await storeRecordingObject({
        fileName,
        mimeType,
        sessionId: runtimeSession.sessionId,
        stream: Readable.toWeb(req) as ReadableStream<Uint8Array>
      });

      // HeadObject truth (storeRecordingObject returns the persisted size): a
      // client that lied about content-length, or a chunked upload with none,
      // is caught here. Delete the over-cap object rather than persist an asset
      // pointing at it.
      if (storedObject.fileSizeBytes > maximumRecordingSizeBytes) {
        await deleteStoredObject({
          relativePath: storedObject.relativePath,
          storageProvider: storedObject.storageProvider
        }).catch(() => null);
        return res.status(413).json({
          error: 'recording_too_large',
          maximumSizeInBytes: maximumRecordingSizeBytes
        });
      }

      const asset = await saveUploadedRecordingAsset({
        payload,
        attemptNumber: attempt ?? undefined,
        sessionId: runtimeSession.sessionId,
        fileName: storedObject.fileName,
        fileSizeBytes: storedObject.fileSizeBytes,
        mimeType: storedObject.mimeType,
        durationSeconds:
          durationSeconds !== null && Number.isFinite(durationSeconds)
            ? durationSeconds
            : null,
        objectUrl: storedObject.objectUrl,
        relativePath: storedObject.relativePath,
        storageProvider: storedObject.storageProvider
      });
      await autoGenerateTranscriptForSession(asset.sessionId).catch(() => null);

      return res.json(asset);
    } catch (error) {
      return res.status(500).json({
        error: 'recording_upload_failed',
        message:
          error instanceof Error
            ? error.message
            : 'The recording upload could not be completed.'
      });
    }
  })
);

// POST /:token/recording/client-upload - presign a direct-to-S3 PUT. The object
// key is server-derived, never client-chosen: a presigned PUT is a raw write
// capability, so honouring a client key would let one participant overwrite
// another's recording.
router.post(
  '/:token/recording/client-upload',
  guard,
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.firsthandSession!;
    const attempt = attemptFromQuery(req);
    const parsedBody = s3UploadRequestSchema.safeParse(req.body);

    if (!parsedBody.success) {
      return res.status(422).json({
        error: 'invalid_upload_request',
        issues: parsedBody.error.flatten()
      });
    }

    const maximumRecordingSizeBytes = getMaximumRecordingSizeBytes();
    if (parsedBody.data.fileSizeBytes > maximumRecordingSizeBytes) {
      return res.status(413).json({
        error: 'recording_too_large',
        maximumSizeInBytes: maximumRecordingSizeBytes
      });
    }

    const normalizedMimeType = normalizeRecordingMimeType(parsedBody.data.mimeType);
    const objectKey = `recordings/${payload.session.session_id}/${buildStorageFileName(parsedBody.data.fileName)}`;
    const validUntil = new Date(Date.now() + PENDING_UPLOAD_VALIDITY_MS).toISOString();

    await registerPendingRecordingUpload(payload, {
      attemptNumber: attempt ?? undefined,
      fileName: parsedBody.data.fileName,
      mimeType: normalizedMimeType,
      relativePath: objectKey,
      storageProvider: 's3',
      validUntil
    });

    const uploadUrl = await createPresignedRecordingUploadUrl({
      contentType: normalizedMimeType,
      expiresInSeconds: PENDING_UPLOAD_VALIDITY_MS / 1000,
      objectKey
    });

    return res.json({ mode: 's3', objectKey, uploadUrl, validUntil });
  })
);

// POST /:token/recording/finalize - turn a completed direct upload into a
// recording asset. Everything about the asset comes from the pending-upload row
// registered at presign time plus HeadObject; the client only names which of
// its own registered uploads to finalize.
router.post(
  '/:token/recording/finalize',
  guard,
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.firsthandSession!;
    const attempt = attemptFromQuery(req);
    const parsedBody = s3FinalizeSchema.safeParse(req.body);

    if (!parsedBody.success) {
      return res.status(422).json({
        error: 'invalid_recording_finalize_payload',
        issues: parsedBody.error.flatten()
      });
    }

    const pendingUpload = await resolvePendingRecordingUpload({
      relativePath: parsedBody.data.objectKey,
      storageProvider: 's3'
    });

    if (!pendingUpload || pendingUpload.token !== payload.session.session_token) {
      return res.status(403).json({ error: 'unknown_upload' });
    }

    if (Date.parse(pendingUpload.validUntil) < Date.now()) {
      return res.status(410).json({ error: 'upload_expired' });
    }

    const objectSizeBytes = await headS3ObjectSize(pendingUpload.relativePath);
    if (objectSizeBytes === null) {
      return res.status(422).json({ error: 'uploaded_object_missing' });
    }

    const maximumRecordingSizeBytes = getMaximumRecordingSizeBytes();
    if (objectSizeBytes > maximumRecordingSizeBytes) {
      return res.status(413).json({
        error: 'recording_too_large',
        maximumSizeInBytes: maximumRecordingSizeBytes
      });
    }

    const asset = await saveUploadedRecordingAsset({
      attemptNumber: attempt ?? undefined,
      durationSeconds: parsedBody.data.durationSeconds,
      fileName: pendingUpload.fileName,
      fileSizeBytes: objectSizeBytes,
      mimeType: pendingUpload.mimeType,
      objectUrl: undefined,
      payload,
      relativePath: pendingUpload.relativePath,
      sessionId: pendingUpload.sessionId,
      storageProvider: 's3'
    });
    await autoGenerateTranscriptForSession(
      pendingUpload.sessionId ?? asset.sessionId ?? payload.session.session_id
    ).catch(() => null);

    return res.json(asset);
  })
);

export default router;
