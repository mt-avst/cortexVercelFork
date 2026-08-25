import { Readable } from 'node:stream';

import { Router, Request, Response } from 'express';
import { z } from 'zod';

import { requireAuth } from '../middleware/authenticate';
import { bindParticipantSession } from '../middleware/firsthand-session';
import { perUserLimiter } from '../middleware/per-user-rate-limit';
import { participantRuntimeWork } from '../middleware/runtime-work-class';
import { asyncHandler } from '../utils/errorHandler';
import { parseSessionAttemptNumber } from '../firsthand/session-attempts';
import { runtimeMutationSchema } from '../firsthand/runtime-records';
import { findAnswerValidityProblem } from '../../../shared/firsthand/survey-answers';
import { isSurveySession } from '../../../shared/firsthand/contract';
import { logger } from '../utils/logger';
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

/**
 * Every route on this router is a participant acting on their own session, so
 * the whole router is classified at once rather than route by route.
 *
 * `router.use` rather than a per-route entry deliberately: this is the one
 * place where a route added later and left unmarked would put a participant's
 * answer save behind the admin admission cap, and a `use` cannot be forgotten
 * by a new route. Mounted FIRST, before `requireAuth`, because the
 * classification costs nothing on a request that is about to 401 and applying
 * it early means it holds for every code path below, refusals included.
 */
router.use(participantRuntimeWork);

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

/**
 * `x-firsthand-duration-seconds`, held to the SAME PREDICATE as the S3 path.
 *
 * cto/AdaptaLabs#22. The legacy streaming upload guarded this header with
 * `Number.isFinite` alone, while `s3UploadRequestSchema` and `s3FinalizeSchema`
 * fifteen lines up both say `z.number().nonnegative()`. So the two ways of
 * uploading the same recording disagreed about what a duration is, and
 * `-1e9` reached a DOUBLE PRECISION column through the older one.
 *
 * DROPS THE BAD VALUE RATHER THAN REFUSING THE UPLOAD, which is where it
 * departs from the S3 path on purpose, and the difference is what is at stake
 * on each. The S3 schemas validate a small JSON body sent BEFORE any bytes
 * move: a 400 there costs a round trip. This header rides on the request that
 * carries the recording itself, and by the time a participant's client sends it
 * the session is over and the media is not reproducible. Refusing a whole
 * recording over a metadata header is a data-loss trade nobody would choose.
 *
 * It is also what this path ALREADY did for the unparseable case - `'abc'` has
 * always become `null` here rather than a refusal - so this widens an existing
 * disposition to cover negatives instead of inventing a second one. `null` is a
 * value the column and every reader already handle: duration is optional.
 *
 * NOT the "refuse rather than truncate" case. That rule is about withholding
 * data a caller asked for on the way OUT; this is malformed metadata on the way
 * in, and the recording it describes is kept in full.
 */
function durationSecondsFromHeader(raw: string | null): number | null {
  if (raw === null || raw.length === 0) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
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

/**
 * Every mutating runtime route, per participant.
 *
 * Each POST /:token/runtime DELETES AND REINSERTS the session's entire event,
 * response and asset set, so a looping participant makes their own writes
 * progressively more expensive - on the 5-connection FirstHand runtime pool
 * that every other live session shares. The recording routes on the same
 * bucket reach S3 and the transcript queue.
 *
 * 120 a minute because this one is genuinely chatty: a participant working
 * through a long survey sends an event and a response per question, and the
 * runner also emits step and consent events. Two a second is far above a human
 * answering questions and still an actual ceiling on a loop.
 *
 * Reads are left alone. GET /:token and GET /:token/runtime do not write, and
 * the runner polls neither.
 */
const runtimeWriteLimiter = perUserLimiter(
  120,
  'Too many requests. Wait a minute and try again.'
);

/** Test seam, for the same reason as the one in routes/opportunities.ts. */
export function resetRuntimeRouteLimits(userId: string): void {
  runtimeWriteLimiter.resetKey(userId);
}

const guard = [requireAuth, bindParticipantSession];

// Mounted AFTER `guard` on every mutating route, so req.user is present and an
// unauthenticated flood cannot fill a real participant's bucket.
const writeGuard = [...guard, runtimeWriteLimiter];

/**
 * Refuses a native poll or survey the recording machinery.
 *
 * A survey session is an ordinary runtime session, so until the payload
 * carried `kind` nothing narrowed what its token could do: it could set
 * recording state and reach the three upload routes, which in the deployed
 * environment means a presigned S3 PUT, an asset row and a transcript job.
 * Bounded to the participant's own session - so storage and compute, plus a
 * session record claiming a recording on a survey, rather than a way to reach
 * anyone else's data.
 *
 * `requireRecordedSession` rather than `refuseSurveySession` would read
 * better, but would be the wrong rule: see isSurveySession on why an absent
 * `kind` must not be treated as a survey. This refuses only what positively
 * says it is one.
 *
 * 404 rather than 403, matching how the mint routes answer a survey/recorded
 * mismatch: the recording surface does not exist for this session, which is
 * more accurate than telling the caller they lack permission for something
 * that was never theirs to have.
 */
function refusesRecording(req: Request, res: Response): boolean {
  const payload = req.firsthandSession!;

  if (!isSurveySession(payload)) {
    return false;
  }

  logger.warn('Refused recording machinery to a survey session', {
    sessionId: payload.session.session_id,
    studyId: payload.study.id
  });

  res.status(404).json({ error: 'not_found' });
  return true;
}

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
  writeGuard,
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

    // Events and responses are exactly what a survey session is for, so only
    // the recording_state variant is refused here rather than the whole route.
    // Without this a survey could drive its own row to recordingStatus:
    // "active" and uploadStatus: "complete" - a session record claiming a
    // recording that does not and cannot exist, on a surface whose consent
    // text says nothing is recorded.
    if (parsedMutation.data.type === 'recording_state' && isSurveySession(payload)) {
      logger.warn('Refused a recording-state mutation on a survey session', {
        sessionId: payload.session.session_id,
        studyId: payload.study.id
      });
      return res.status(404).json({ error: 'not_found' });
    }

    // A response must answer a question this session was actually asked. The
    // schema above checks shape, not truth: without these checks a participant
    // can POST an option that was never offered, a score off the scale, or an
    // answer against a stepId the study does not contain, and it lands in the
    // researcher's aggregate and CSV as attacker-chosen text. The rules are
    // the shared module's - the same ones the participant UI enforces - so
    // anything that passes here is an answer the UI could have produced.
    if (parsedMutation.data.type === 'response') {
      const mutation = parsedMutation.data;
      const step = payload.steps.find(
        (candidate) => candidate.step_id === mutation.stepId
      );

      if (!step) {
        return res.status(422).json({ error: 'unknown_step' });
      }

      if (step.type !== mutation.stepType) {
        return res.status(422).json({ error: 'step_type_mismatch' });
      }

      const validityProblem = findAnswerValidityProblem(
        step,
        mutation.responsePayload
      );

      if (validityProblem) {
        return res.status(422).json({
          error: 'invalid_answer',
          code: validityProblem.code
        });
      }
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
  writeGuard,
  asyncHandler(async (req: Request, res: Response) => {
    if (refusesRecording(req, res)) return;

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
    const durationSeconds = durationSecondsFromHeader(
      headerString(req.headers['x-firsthand-duration-seconds'])
    );
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
        // `durationSecondsFromHeader` has already settled finite-and-nonnegative
        // or `null`; a second `Number.isFinite` here would read as though it
        // still had something to catch.
        durationSeconds,
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
  writeGuard,
  asyncHandler(async (req: Request, res: Response) => {
    if (refusesRecording(req, res)) return;

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
  writeGuard,
  asyncHandler(async (req: Request, res: Response) => {
    if (refusesRecording(req, res)) return;

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
