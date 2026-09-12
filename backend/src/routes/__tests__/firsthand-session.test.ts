import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';

// B4 participant runtime API. Every route is guarded by requireAuth +
// bindParticipantSession (H3): the token is bound to req.user.id, so a leaked
// token replayed by a different logged-in user is rejected with 403. The
// firsthand runtime/storage layer is mocked so these tests assert the route
// contract (auth, binding, status codes, the express.json/CSRF seam) rather than
// the data layer, which has its own suites.

jest.mock('../../firsthand/session-store', () => ({
  loadParticipantSession: jest.fn()
}));
jest.mock('../../firsthand/runtime-repository-postgres', () => ({
  seedRuntimeSession: jest.fn(),
  getRuntimeSession: jest.fn(),
  applyRuntimeMutation: jest.fn(),
  saveUploadedRecordingAsset: jest.fn(),
  registerPendingRecordingUpload: jest.fn(),
  resolvePendingRecordingUpload: jest.fn()
}));
jest.mock('../../firsthand/object-storage', () => ({
  storeRecordingObject: jest.fn(),
  deleteStoredObject: jest.fn()
}));
jest.mock('../../firsthand/runtime-object-storage-s3', () => ({
  createPresignedRecordingUploadUrl: jest.fn(),
  headS3ObjectSize: jest.fn()
}));
jest.mock('../../firsthand/transcript-automation', () => ({
  autoGenerateTranscriptForSession: jest.fn()
}));
jest.mock('../../firsthand/completion-events', () => ({
  recordInternalSessionEvent: jest.fn()
}));
jest.mock('../../firsthand/recording-limits', () => ({
  getMaximumRecordingSizeBytes: jest.fn()
}));

import firsthandSessionRouter, { resetRuntimeRouteLimits } from '../firsthand-session';
import { errorHandler } from '../../utils/errorHandler';
import { buildCsrfProtection } from '../../middleware/csrf';
import { loadParticipantSession } from '../../firsthand/session-store';
import {
  seedRuntimeSession,
  getRuntimeSession,
  applyRuntimeMutation,
  saveUploadedRecordingAsset,
  registerPendingRecordingUpload,
  resolvePendingRecordingUpload
} from '../../firsthand/runtime-repository-postgres';
import { storeRecordingObject, deleteStoredObject } from '../../firsthand/object-storage';
import {
  createPresignedRecordingUploadUrl,
  headS3ObjectSize
} from '../../firsthand/runtime-object-storage-s3';
import { autoGenerateTranscriptForSession } from '../../firsthand/transcript-automation';
import { recordInternalSessionEvent } from '../../firsthand/completion-events';
import { getMaximumRecordingSizeBytes } from '../../firsthand/recording-limits';

const mockLoad = loadParticipantSession as jest.MockedFunction<any>;
const mockSeed = seedRuntimeSession as jest.MockedFunction<any>;
const mockGetRuntime = getRuntimeSession as jest.MockedFunction<any>;
const mockApply = applyRuntimeMutation as jest.MockedFunction<any>;
const mockSaveAsset = saveUploadedRecordingAsset as jest.MockedFunction<any>;
const mockRegisterPending = registerPendingRecordingUpload as jest.MockedFunction<any>;
const mockResolvePending = resolvePendingRecordingUpload as jest.MockedFunction<any>;
const mockStore = storeRecordingObject as jest.MockedFunction<any>;
const mockDeleteStored = deleteStoredObject as jest.MockedFunction<any>;
const mockPresign = createPresignedRecordingUploadUrl as jest.MockedFunction<any>;
const mockHead = headS3ObjectSize as jest.MockedFunction<any>;
const mockTranscript = autoGenerateTranscriptForSession as jest.MockedFunction<any>;
const mockRecordEvent = recordInternalSessionEvent as jest.MockedFunction<any>;
const mockMaxBytes = getMaximumRecordingSizeBytes as jest.MockedFunction<any>;

const PARTICIPANT_ID = 'user_owner';
const TOKEN = 'fh_test_token';

function payloadFor(participantId: string) {
  return {
    contract_version: '1.0',
    study: { id: 'study_1', title: 'S', intro_text: 'i', consent_text: 'c' },
    participant: { participant_id: participantId, external_ref: 'opp_1' },
    session: {
      session_id: 'session_1',
      session_token: TOKEN,
      study_id: 'study_1',
      participant_id: participantId,
      single_use: true
    },
    steps: [{ step_id: 's1', order: 1, type: 'end', prompt: 'done' }]
  };
}

function buildApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.session = user ? { user } : {};
    next();
  });
  app.use('/api/firsthand/session', firsthandSessionRouter);
  app.use(errorHandler);
  return app;
}

const ownerUser = { id: PARTICIPANT_ID, name: 'Owner', email: 'o@x.com', role: 'employee' };
const ownerApp = buildApp(ownerUser);

function okSession(participantId = PARTICIPANT_ID) {
  mockLoad.mockResolvedValue({ kind: 'ok', payload: payloadFor(participantId) });
}

beforeEach(() => {
  jest.clearAllMocks();
  // The mutating runtime routes are rate limited per user and the counter
  // outlives a test, so without this a long suite starts answering 429 partway
  // through and every later assertion fails for a reason none of them names.
  resetRuntimeRouteLimits(PARTICIPANT_ID);
  mockMaxBytes.mockReturnValue(2 * 1024 * 1024 * 1024);
  mockSeed.mockResolvedValue({ sessionId: 'session_1', attemptNumber: 1 });
  mockRecordEvent.mockResolvedValue(undefined);
  mockTranscript.mockResolvedValue({ transcriptStatus: 'complete' });
});

// The five route files, as request thunks against the owner app.
const endpoints: Array<{ name: string; call: () => request.Test }> = [
  { name: 'GET /:token', call: () => request(listening(ownerApp)).get(`/api/firsthand/session/${TOKEN}`) },
  { name: 'GET /:token/runtime', call: () => request(listening(ownerApp)).get(`/api/firsthand/session/${TOKEN}/runtime`) },
  { name: 'POST /:token/runtime', call: () => request(listening(ownerApp)).post(`/api/firsthand/session/${TOKEN}/runtime`).send({ type: 'event', eventType: 'session_started' }) },
  { name: 'POST /:token/recording', call: () => request(listening(ownerApp)).post(`/api/firsthand/session/${TOKEN}/recording`).set('Content-Type', 'video/webm').send(Buffer.from('x')) },
  { name: 'POST /:token/recording/client-upload', call: () => request(listening(ownerApp)).post(`/api/firsthand/session/${TOKEN}/recording/client-upload`).send({ durationSeconds: 1, fileName: 'a.webm', mimeType: 'video/webm', fileSizeBytes: 10 }) },
  { name: 'POST /:token/recording/finalize', call: () => request(listening(ownerApp)).post(`/api/firsthand/session/${TOKEN}/recording/finalize`).send({ durationSeconds: 1, objectKey: 'recordings/session_1/a.webm' }) }
];

describe('B4 participant runtime — auth gate (requireAuth)', () => {
  it('every mutating + read endpoint is 401 without a session', async () => {
    const anonApp = buildApp(null);
    const calls = [
      () => request(listening(anonApp)).get(`/api/firsthand/session/${TOKEN}`),
      () => request(listening(anonApp)).get(`/api/firsthand/session/${TOKEN}/runtime`),
      () => request(listening(anonApp)).post(`/api/firsthand/session/${TOKEN}/runtime`).send({ type: 'event', eventType: 'session_started' }),
      () => request(listening(anonApp)).post(`/api/firsthand/session/${TOKEN}/recording`).set('Content-Type', 'video/webm').send(Buffer.from('x')),
      () => request(listening(anonApp)).post(`/api/firsthand/session/${TOKEN}/recording/client-upload`).send({ durationSeconds: 1, fileName: 'a.webm', mimeType: 'video/webm', fileSizeBytes: 10 }),
      () => request(listening(anonApp)).post(`/api/firsthand/session/${TOKEN}/recording/finalize`).send({ durationSeconds: 1, objectKey: 'k' })
    ];
    for (const c of calls) {
      const res = await c();
      expect(res.status).toBe(401);
    }
    expect(mockLoad).not.toHaveBeenCalled();
  });
});

describe('B4 participant runtime — token->user binding (H3)', () => {
  it.each(endpoints)('$name returns 403 when the token belongs to another user', async ({ call }) => {
    okSession('user_someone_else'); // token minted for a different participant
    const res = await call();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden_participant_mismatch');
  });

  it('does not touch the runtime/storage layer on a wrong-user request', async () => {
    okSession('user_someone_else');
    await request(listening(ownerApp)).post(`/api/firsthand/session/${TOKEN}/runtime`).send({ type: 'event', eventType: 'session_started' });
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });
});

describe('B4 participant runtime — session-load failure mapping', () => {
  it('maps expired -> 410', async () => {
    mockLoad.mockResolvedValue({ kind: 'expired', message: 'gone' });
    const res = await request(listening(ownerApp)).get(`/api/firsthand/session/${TOKEN}`);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('expired');
  });
  it('maps invalid_contract -> 422', async () => {
    mockLoad.mockResolvedValue({ kind: 'invalid_contract', message: 'bad' });
    const res = await request(listening(ownerApp)).get(`/api/firsthand/session/${TOKEN}`);
    expect(res.status).toBe(422);
  });
  it('maps not_found -> 404', async () => {
    mockLoad.mockResolvedValue({ kind: 'not_found', message: 'nope' });
    const res = await request(listening(ownerApp)).get(`/api/firsthand/session/${TOKEN}`);
    expect(res.status).toBe(404);
  });
  it('sets Referrer-Policy: no-referrer for token-in-URL hygiene', async () => {
    okSession();
    const res = await request(listening(ownerApp)).get(`/api/firsthand/session/${TOKEN}`);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('B4 GET /:token + GET /:token/runtime', () => {
  it('returns the bound session payload', async () => {
    okSession();
    const res = await request(listening(ownerApp)).get(`/api/firsthand/session/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.session.session_id).toBe('session_1');
  });
  it('seeds and returns the runtime snapshot', async () => {
    okSession();
    mockSeed.mockResolvedValue({ sessionId: 'session_1', attemptNumber: 1, sessionStatus: 'in_progress' });
    const res = await request(listening(ownerApp)).get(`/api/firsthand/session/${TOKEN}/runtime`);
    expect(res.status).toBe(200);
    expect(mockSeed).toHaveBeenCalled();
    expect(res.body.sessionId).toBe('session_1');
  });
  it('selects a specific attempt when ?attempt= is supplied', async () => {
    okSession();
    mockGetRuntime.mockResolvedValue({ sessionId: 'session_1', attemptNumber: 3 });
    const res = await request(listening(ownerApp)).get(`/api/firsthand/session/${TOKEN}/runtime?attempt=3`);
    expect(res.status).toBe(200);
    expect(mockGetRuntime).toHaveBeenCalledWith('session_1', { attemptNumber: 3 });
    expect(res.body.attemptNumber).toBe(3);
  });
});

describe('B4 POST /:token/runtime', () => {
  it('applies a valid mutation and records the lifecycle event in-process', async () => {
    okSession();
    mockApply.mockResolvedValue({ sessionId: 'session_1', sessionStatus: 'completed', logicalSessionId: 'session_1' });
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .send({ type: 'event', eventType: 'upload_completed' });
    expect(res.status).toBe(200);
    expect(mockApply).toHaveBeenCalled();
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty body with 422 rather than 500 (abandoned session)', async () => {
    okSession();
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .set('Content-Type', 'application/json')
      .send('');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('invalid_runtime_mutation');
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('turns a truncated JSON body into a clean 400, never a 500', async () => {
    okSession();
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .set('Content-Type', 'application/json')
      .send('{"type":"eve');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REQUEST_BODY');
    expect(mockApply).not.toHaveBeenCalled();
  });
});

// Server-side answer validation. Every rule here is unreachable through the
// UI - these states arrive only by a tampered request - and each would land
// attacker-chosen content in the researcher's aggregate and CSV export. The
// rules are shared/firsthand/survey-answers.ts, the same module the
// participant UI words its messages from, so the two boundaries cannot drift.
describe('B4 POST /:token/runtime — a response must answer a question the session was asked', () => {
  function okSurveySession() {
    mockLoad.mockResolvedValue({
      kind: 'ok',
      payload: {
        ...payloadFor(PARTICIPANT_ID),
        steps: [
          { step_id: 's_single', order: 1, type: 'single_choice', prompt: 'Pick one', options: ['Red', 'Blue'] },
          { step_id: 's_multi', order: 2, type: 'multi_choice', prompt: 'Pick some', options: ['A', 'B', 'C'], config: { max_selections: 2 } },
          { step_id: 's_nps', order: 3, type: 'nps', prompt: 'Recommend?' }
        ]
      }
    });
  }

  const submit = (body: Record<string, unknown>) =>
    request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .send({ type: 'response', ...body });

  beforeEach(() => {
    okSurveySession();
    mockApply.mockResolvedValue({ sessionId: 'session_1', sessionStatus: 'recording_in_progress', logicalSessionId: 'session_1' });
  });

  it('accepts a valid answer for each native survey type and stores it untouched', async () => {
    const answers = [
      { stepId: 's_single', stepType: 'single_choice', responsePayload: { selectedOption: 'Red' } },
      { stepId: 's_multi', stepType: 'multi_choice', responsePayload: { selectedOptions: ['A', 'C'] } },
      // Zero is a real NPS score - a detractor, not an absent answer.
      { stepId: 's_nps', stepType: 'nps', responsePayload: { rating: 0 } }
    ];

    for (const answer of answers) {
      const res = await submit(answer);
      expect(res.status).toBe(200);
    }

    expect(mockApply).toHaveBeenCalledTimes(3);
    // The payload must reach the repository exactly as submitted: the defect
    // this suite guards against was zod stripping the survey fields so every
    // answer was stored as {}.
    expect(mockApply.mock.calls[2][1]).toMatchObject({
      responsePayload: { rating: 0 }
    });
  });

  it('rejects a response against a stepId the study does not contain', async () => {
    const res = await submit({ stepId: 's_forged', stepType: 'single_choice', responsePayload: { selectedOption: 'Red' } });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('unknown_step');
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('rejects a stepType that disagrees with the step it names', async () => {
    const res = await submit({ stepId: 's_nps', stepType: 'open_text', responsePayload: { text: 'free text into a score column' } });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('step_type_mismatch');
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('rejects an option that was never offered', async () => {
    const res = await submit({ stepId: 's_single', stepType: 'single_choice', responsePayload: { selectedOption: 'Adaptavist is unsafe to work with' } });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'invalid_answer', code: 'option_not_offered' });
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('rejects a score off the scale', async () => {
    const res = await submit({ stepId: 's_nps', stepType: 'nps', responsePayload: { rating: 11 } });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'invalid_answer', code: 'score_off_scale' });
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('rejects more selections than the question allows', async () => {
    const res = await submit({ stepId: 's_multi', stepType: 'multi_choice', responsePayload: { selectedOptions: ['A', 'B', 'C'] } });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'invalid_answer', code: 'too_many_selections' });
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('rejects an unknown answer key as schema drift rather than stripping it', async () => {
    // Pre-fix, zod silently stripped unknown keys, which is exactly how the
    // legitimate survey fields were being discarded. Strict parsing turns
    // drift into a 422 on first submission.
    const res = await submit({ stepId: 's_nps', stepType: 'nps', responsePayload: { score: 9 } });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('invalid_runtime_mutation');
    expect(mockApply).not.toHaveBeenCalled();
  });
});

describe('B4 POST /:token/recording/client-upload (S3-only)', () => {
  it('presigns a server-derived S3 key and returns it', async () => {
    okSession();
    mockPresign.mockResolvedValue('https://s3.example/put?sig=1');
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/client-upload`)
      .send({ durationSeconds: 42.5, fileName: 'session.webm', mimeType: 'video/webm;codecs=vp9,opus', fileSizeBytes: 1024 });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('s3');
    expect(res.body.objectKey).toMatch(/^recordings\/session_1\//);
    expect(res.body.uploadUrl).toBe('https://s3.example/put?sig=1');
    // Key is server-derived, never the client's, and the mime is normalized.
    expect(mockRegisterPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ storageProvider: 's3', mimeType: 'video/webm' })
    );
    expect(mockPresign).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'video/webm', objectKey: res.body.objectKey })
    );
  });

  it('rejects an invalid upload request with 422', async () => {
    okSession();
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/client-upload`)
      .send({ fileName: '', mimeType: 'video/webm' });
    expect(res.status).toBe(422);
    expect(mockRegisterPending).not.toHaveBeenCalled();
  });

  it.each([
    ['a double quote', 'a".webm'],
    ['a CR/LF pair', 'a\r\nX: 1.webm'],
  ])('rejects a fileName carrying %s - the raw name is stored and later reaches a header', async (_what, fileName) => {
    // Mirrors the booking-artefact presign schema; defence in depth beside
    // buildInlineContentDisposition, which encodes whatever is stored.
    okSession();
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/client-upload`)
      .send({ durationSeconds: 1, fileName, mimeType: 'video/webm', fileSizeBytes: 10 });
    expect(res.status).toBe(422);
    expect(mockRegisterPending).not.toHaveBeenCalled();
  });

  it('rejects a mimeType with a codepoint above U+00FF - it becomes the serve-time Content-Type', async () => {
    okSession();
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/client-upload`)
      .send({ durationSeconds: 1, fileName: 'a.webm', mimeType: 'video/mp4会', fileSizeBytes: 10 });
    expect(res.status).toBe(422);
    expect(mockRegisterPending).not.toHaveBeenCalled();
  });

  it('accepts a CJK fileName - the researcher-language trade is accept-and-encode, not refuse', async () => {
    okSession();
    mockPresign.mockResolvedValue('https://s3.example/put?sig=1');
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/client-upload`)
      .send({ durationSeconds: 1, fileName: '会議.webm', mimeType: 'video/webm', fileSizeBytes: 10 });
    expect(res.status).toBe(200);
  });

  it('rejects an over-cap declared size with 413', async () => {
    okSession();
    mockMaxBytes.mockReturnValue(2048);
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/client-upload`)
      .send({ durationSeconds: 1, fileName: 'a.webm', mimeType: 'video/webm', fileSizeBytes: 4096 });
    expect(res.status).toBe(413);
    expect(res.body.maximumSizeInBytes).toBe(2048);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it('forwards the requested attempt number', async () => {
    okSession();
    mockPresign.mockResolvedValue('https://s3/put');
    await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/client-upload?attempt=3`)
      .send({ durationSeconds: 1, fileName: 'a.webm', mimeType: 'video/webm', fileSizeBytes: 10 });
    expect(mockRegisterPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptNumber: 3 })
    );
  });
});

describe('B4 POST /:token/recording/finalize (S3-only)', () => {
  const goodPending = {
    token: TOKEN,
    sessionId: 'session_1',
    fileName: 'session.webm',
    mimeType: 'video/webm',
    relativePath: 'recordings/session_1/session.webm',
    validUntil: new Date(Date.now() + 60_000).toISOString()
  };

  it('finalizes from HeadObject size and starts transcript automation', async () => {
    okSession();
    mockResolvePending.mockResolvedValue(goodPending);
    mockHead.mockResolvedValue(2048);
    mockSaveAsset.mockResolvedValue({ id: 'asset_1', sessionId: 'session_1', relativePath: goodPending.relativePath, fileSizeBytes: 2048, mimeType: 'video/webm' });
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/finalize`)
      .send({ durationSeconds: 42.5, objectKey: goodPending.relativePath });
    expect(res.status).toBe(200);
    expect(res.body.fileSizeBytes).toBe(2048);
    expect(mockSaveAsset).toHaveBeenCalledWith(expect.objectContaining({ fileSizeBytes: 2048, storageProvider: 's3' }));
    expect(mockTranscript).toHaveBeenCalledWith('session_1');
  });

  it('does not fail the response when transcript automation throws', async () => {
    okSession();
    mockResolvePending.mockResolvedValue(goodPending);
    mockHead.mockResolvedValue(2048);
    mockSaveAsset.mockResolvedValue({ id: 'asset_1', sessionId: 'session_1', relativePath: goodPending.relativePath, fileSizeBytes: 2048, mimeType: 'video/webm' });
    mockTranscript.mockRejectedValue(new Error('transcript boom'));
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/finalize`)
      .send({ durationSeconds: 1, objectKey: goodPending.relativePath });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('asset_1');
  });

  it('rejects an unregistered key with 403', async () => {
    okSession();
    mockResolvePending.mockResolvedValue(null);
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/finalize`)
      .send({ durationSeconds: 1, objectKey: 'recordings/session_1/never.webm' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('unknown_upload');
  });

  it("rejects a pending upload registered under another session's token with 403", async () => {
    okSession();
    mockResolvePending.mockResolvedValue({ ...goodPending, token: 'fh_other_token' });
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/finalize`)
      .send({ durationSeconds: 1, objectKey: goodPending.relativePath });
    expect(res.status).toBe(403);
  });

  it('rejects an expired pending upload with 410', async () => {
    okSession();
    mockResolvePending.mockResolvedValue({ ...goodPending, validUntil: new Date(Date.now() - 1000).toISOString() });
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/finalize`)
      .send({ durationSeconds: 1, objectKey: goodPending.relativePath });
    expect(res.status).toBe(410);
  });

  it('rejects a missing uploaded object with 422', async () => {
    okSession();
    mockResolvePending.mockResolvedValue(goodPending);
    mockHead.mockResolvedValue(null);
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/finalize`)
      .send({ durationSeconds: 1, objectKey: goodPending.relativePath });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('uploaded_object_missing');
  });

  it('rejects an object that exceeds the cap with 413 (HeadObject truth, not client claim)', async () => {
    okSession();
    mockMaxBytes.mockReturnValue(2048);
    mockResolvePending.mockResolvedValue(goodPending);
    mockHead.mockResolvedValue(4096);
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/finalize`)
      .send({ durationSeconds: 1, objectKey: goodPending.relativePath });
    expect(res.status).toBe(413);
  });
});

describe('B4 POST /:token/recording (server-proxied stream)', () => {
  it('streams the body to S3 and returns the saved asset', async () => {
    okSession();
    mockSeed.mockResolvedValue({ sessionId: 'session_1' });
    mockStore.mockResolvedValue({ fileName: 'a.webm', fileSizeBytes: 3, mimeType: 'video/webm', objectUrl: undefined, relativePath: 'recordings/session_1/a.webm', storageProvider: 's3' });
    mockSaveAsset.mockResolvedValue({ id: 'asset_1', sessionId: 'session_1', relativePath: 'recordings/session_1/a.webm', fileSizeBytes: 3, mimeType: 'video/webm' });
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording`)
      .set('Content-Type', 'video/webm')
      .set('x-firsthand-file-name', encodeURIComponent('a.webm'))
      .send(Buffer.from('abc'));
    expect(res.status).toBe(200);
    expect(mockStore).toHaveBeenCalled();
    expect(res.body.id).toBe('asset_1');
  });

  it('rejects an honest over-cap content-length upfront with 413', async () => {
    okSession();
    mockMaxBytes.mockReturnValue(1024);
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording`)
      .set('Content-Type', 'video/webm')
      .set('Content-Length', '4096')
      .send(Buffer.alloc(4096));
    expect(res.status).toBe(413);
    expect(mockStore).not.toHaveBeenCalled();
  });

  it('deletes the object and returns 413 when the stored size exceeds the cap (HeadObject truth)', async () => {
    okSession();
    // Cap 16: the 1-byte body's content-length (1) passes the upfront check, but
    // the persisted size (4096) is the truth and must be caught post-upload.
    mockMaxBytes.mockReturnValue(16);
    mockSeed.mockResolvedValue({ sessionId: 'session_1' });
    mockStore.mockResolvedValue({ fileName: 'a.webm', fileSizeBytes: 4096, mimeType: 'video/webm', objectUrl: undefined, relativePath: 'recordings/session_1/a.webm', storageProvider: 's3' });
    mockDeleteStored.mockResolvedValue(undefined);
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording`)
      .set('Content-Type', 'video/webm')
      .send(Buffer.from('a'));
    expect(res.status).toBe(413);
    expect(mockDeleteStored).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'recordings/session_1/a.webm', storageProvider: 's3' })
    );
    expect(mockSaveAsset).not.toHaveBeenCalled();
  });
});

/**
 * `x-firsthand-duration-seconds` HELD TO THE SAME PREDICATE AS THE S3 PATH.
 * cto/AdaptaLabs#22.
 *
 * `s3UploadRequestSchema` and `s3FinalizeSchema` both say
 * `z.number().nonnegative()`. The legacy streaming upload fifteen lines below
 * them guarded the same quantity with `Number.isFinite` alone, so the two ways
 * of uploading one recording disagreed about what a duration is and a NEGATIVE
 * reached a DOUBLE PRECISION column through the older one.
 *
 * IT DROPS THE VALUE RATHER THAN REFUSING THE UPLOAD, and that difference from
 * the S3 path is the decision, not an oversight. The S3 schemas validate a
 * small JSON body sent BEFORE any bytes move, so a 400 there costs a round
 * trip. This header rides on the request carrying the recording itself, and by
 * the time it arrives the session is over and the media is not reproducible.
 * Refusing a participant's whole recording over a metadata header trades
 * something irreplaceable for something optional.
 *
 * It is also what this path already did for `'abc'`, so it widens one
 * disposition rather than inventing a second.
 */
describe('B4 the legacy duration header is nonnegative or nothing', () => {
  const uploadWithDuration = async (duration: string) => {
    okSession();
    mockSeed.mockResolvedValue({ sessionId: 'session_1' });
    mockStore.mockResolvedValue({ fileName: 'a.webm', fileSizeBytes: 3, mimeType: 'video/webm', objectUrl: undefined, relativePath: 'recordings/session_1/a.webm', storageProvider: 's3' });
    mockSaveAsset.mockResolvedValue({ id: 'asset_1', sessionId: 'session_1', relativePath: 'recordings/session_1/a.webm', fileSizeBytes: 3, mimeType: 'video/webm' });
    return request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording`)
      .set('Content-Type', 'video/webm')
      .set('x-firsthand-duration-seconds', duration)
      .send(Buffer.from('abc'));
  };

  /** The duration the route actually asked the repository to persist. */
  const persistedDuration = () => mockSaveAsset.mock.calls[0]?.[0]?.durationSeconds;

  // THE CONTROL. Every assertion below is about a value being replaced with
  // null, which a route that always persisted null would satisfy perfectly.
  it('persists an ordinary positive duration unchanged', async () => {
    const res = await uploadWithDuration('42.5');

    expect(res.status).toBe(200);
    expect(persistedDuration()).toBe(42.5);
  });

  it('persists a zero-second duration rather than discarding it', async () => {
    const res = await uploadWithDuration('0');

    expect(res.status).toBe(200);
    expect(persistedDuration()).toBe(0);
  });

  it('keeps the recording but drops a negative duration', async () => {
    const res = await uploadWithDuration('-3600');

    expect(res.status).toBe(200);
    expect(mockSaveAsset).toHaveBeenCalled();
    expect(persistedDuration()).toBeNull();
  });

  it('keeps the recording but drops an unparseable duration', async () => {
    const res = await uploadWithDuration('not-a-number');

    expect(res.status).toBe(200);
    expect(persistedDuration()).toBeNull();
  });

  it('keeps the recording but drops an infinite duration', async () => {
    const res = await uploadWithDuration('Infinity');

    expect(res.status).toBe(200);
    expect(persistedDuration()).toBeNull();
  });
});

describe('B4 CSRF seam — header-based, GET exempt', () => {
  function buildCsrfApp() {
    const app = express();
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
    app.use(cookieParser());
    const { doubleCsrfProtection, generateCsrfToken } = buildCsrfProtection({
      secret: 'test-secret',
      secureCookies: false
    });
    app.get('/api/csrf-token', (req: any, res) => {
      req.session.csrfSeeded = true;
      res.json({ csrfToken: generateCsrfToken(req, res) });
    });
    app.use(doubleCsrfProtection);
    // Simulate an authenticated participant session (post-CSRF, pre-routes).
    app.use((req: any, _res, next) => {
      req.session.user = ownerUser;
      next();
    });
    app.use(express.json());
    app.use('/api/firsthand/session', firsthandSessionRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      if (err?.code === 'INVALID_CSRF_TOKEN') return res.status(403).json({ error: 'csrf' });
      return res.status(500).json({ error: 'other', message: err?.message });
    });
    app.use(errorHandler);
    return app;
  }

  it('rejects a mutating POST with no CSRF token (403)', async () => {
    okSession();
    const res = await request(listening(buildCsrfApp()))
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .send({ type: 'event', eventType: 'session_started' });
    expect(res.status).toBe(403);
  });

  it('allows a GET with no CSRF token (auto-exempt)', async () => {
    okSession();
    const res = await request(listening(buildCsrfApp())).get(`/api/firsthand/session/${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it('allows a mutating POST that echoes the issued CSRF token + cookie', async () => {
    okSession();
    mockApply.mockResolvedValue({ sessionId: 'session_1', sessionStatus: 'in_progress' });
    const app = buildCsrfApp();
    const agent = request.agent(listening(app));
    const tokenRes = await agent.get('/api/csrf-token');
    const csrf = tokenRes.body.csrfToken;
    const res = await agent
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .set('x-csrf-token', csrf)
      .send({ type: 'event', eventType: 'session_started' });
    expect(res.status).toBe(200);
  });
});

// A survey session is an ordinary runtime session, so until the payload carried
// `kind` nothing narrowed what its token could do: it could set recording state
// and reach all three upload routes, which in the deployed environment means a
// presigned S3 PUT, an asset row and a transcript job. Bounded to the
// participant's own session - storage and compute, not a way to anyone else's
// data - which is why this was a deferral rather than a blocker.
describe('B4 a survey token cannot drive the recording machinery', () => {
  const surveyPayload = () => ({
    ...payloadFor(PARTICIPANT_ID),
    study: {
      id: 'study_1',
      title: 'S',
      intro_text: 'i',
      consent_text: 'c',
      kind: 'survey'
    }
  });

  const surveySession = () => {
    mockLoad.mockResolvedValue({ kind: 'ok', payload: surveyPayload() });
  };

  it('refuses the direct recording upload', async () => {
    surveySession();
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording`)
      .set('Content-Type', 'video/webm')
      .send(Buffer.from('x'));

    expect(res.status).toBe(404);
    // The status alone would pass with the guard moved below the write.
    expect(mockStore).not.toHaveBeenCalled();
    expect(mockSaveAsset).not.toHaveBeenCalled();
  });

  it('refuses to presign an S3 upload, so no write capability is issued', async () => {
    surveySession();
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/client-upload`)
      .send({ durationSeconds: 1, fileName: 'a.webm', mimeType: 'video/webm', fileSizeBytes: 10 });

    expect(res.status).toBe(404);
    expect(mockPresign).not.toHaveBeenCalled();
    expect(mockRegisterPending).not.toHaveBeenCalled();
  });

  it('refuses to finalize, so no asset row and no transcript job', async () => {
    surveySession();
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/finalize`)
      .send({ durationSeconds: 1, objectKey: 'recordings/session_1/a.webm' });

    expect(res.status).toBe(404);
    expect(mockSaveAsset).not.toHaveBeenCalled();
    expect(mockTranscript).not.toHaveBeenCalled();
  });

  it('refuses a recording-state mutation, so the row cannot claim a recording', async () => {
    surveySession();
    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .send({ type: 'recording_state', recordingStatus: 'active', uploadStatus: 'complete' });

    expect(res.status).toBe(404);
    expect(mockApply).not.toHaveBeenCalled();
  });

  // The guard must not be wider than the problem. These are what a survey
  // session exists to do, and refusing the whole route would have broken it.
  it('still accepts an event, which is how the funnel learns the survey started', async () => {
    surveySession();
    mockApply.mockResolvedValue({ sessionId: 'session_1', sessionStatus: 'in_progress' });

    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .send({ type: 'event', eventType: 'session_started' });

    expect(res.status).toBe(200);
    expect(mockApply).toHaveBeenCalled();
  });

  it('still accepts an answer', async () => {
    mockLoad.mockResolvedValue({
      kind: 'ok',
      payload: {
        ...surveyPayload(),
        steps: [{ step_id: 's1', order: 1, type: 'open_text', prompt: 'Why?' }]
      }
    });
    mockApply.mockResolvedValue({ sessionId: 'session_1', sessionStatus: 'in_progress' });

    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .send({ type: 'response', stepId: 's1', stepType: 'open_text', responsePayload: { text: 'Because' } });

    expect(res.status).toBe(200);
    expect(mockApply).toHaveBeenCalled();
  });

  // The load-bearing half of isSurveySession. A payload minted before `kind`
  // existed has no kind, and those are recorded sessions in flight - treating
  // absent as "survey" would refuse a live recording mid-upload.
  it('leaves a payload minted before `kind` existed able to record', async () => {
    okSession();
    mockPresign.mockResolvedValue('https://s3.example/put?sig=1');

    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/client-upload`)
      .send({ durationSeconds: 1, fileName: 'a.webm', mimeType: 'video/webm', fileSizeBytes: 10 });

    expect(res.status).toBe(200);
    expect(mockPresign).toHaveBeenCalled();
  });

  it('leaves a recorded session able to record', async () => {
    mockLoad.mockResolvedValue({
      kind: 'ok',
      payload: {
        ...payloadFor(PARTICIPANT_ID),
        study: { id: 'study_1', title: 'S', intro_text: 'i', consent_text: 'c', kind: 'recorded' }
      }
    });
    mockPresign.mockResolvedValue('https://s3.example/put?sig=1');

    const res = await request(listening(ownerApp))
      .post(`/api/firsthand/session/${TOKEN}/recording/client-upload`)
      .send({ durationSeconds: 1, fileName: 'a.webm', mimeType: 'video/webm', fileSizeBytes: 10 });

    expect(res.status).toBe(200);
    expect(mockPresign).toHaveBeenCalled();
  });
});


/**
 * Each POST here deletes and reinserts the session's whole event, response and
 * asset set, on the 5-connection runtime pool every other live session shares.
 * A looping participant makes their own writes progressively more expensive.
 *
 * The ceiling is exercised ONCE and the three claims asserted against that one
 * exhausted state. Exhausting it per test opened a few hundred supertest
 * sockets in a second and the suite failed with "socket hang up" - a harness
 * limit reported as a test failure, which is worse than no test.
 */
describe('B4 the mutating runtime routes are rate limited per participant', () => {
  it('refuses a looping participant, spares the reads, and spares everyone else', async () => {
    okSession();
    mockApply.mockResolvedValue({ sessionId: 'session_1', sessionStatus: 'in_progress' });

    const codes: number[] = [];
    for (let i = 0; i < 121; i += 1) {
      codes.push(
        (await request(listening(ownerApp))
          .post(`/api/firsthand/session/${TOKEN}/runtime`)
          .send({ type: 'event', eventType: 'session_started' })).status
      );
    }

    expect(codes.slice(0, 120).every((code) => code !== 429)).toBe(true);
    expect(codes[120]).toBe(429);

    // Reads are not on this bucket. The participant surface fetches its payload
    // on load, and a 429 there would strand someone whose only offence was
    // answering a lot of questions.
    expect((await request(listening(ownerApp)).get(`/api/firsthand/session/${TOKEN}`)).status).not.toBe(429);
    expect(
      (await request(listening(ownerApp)).get(`/api/firsthand/session/${TOKEN}/runtime`)).status
    ).not.toBe(429);

    // And the key is the user, not the ingress - so one participant answering
    // fast cannot refuse another.
    okSession('other_participant');
    const otherApp = buildApp({ id: 'other_participant', name: 'O', email: 'o2@x.com', role: 'employee' });
    const other = await request(listening(otherApp))
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .send({ type: 'event', eventType: 'session_started' });
    expect(other.status).not.toBe(429);

    resetRuntimeRouteLimits(PARTICIPANT_ID);
    resetRuntimeRouteLimits('other_participant');
  });
});
