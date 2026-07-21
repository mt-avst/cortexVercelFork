import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
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
jest.mock('../../firsthand/runtime-repository', () => ({
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

import firsthandSessionRouter from '../firsthand-session';
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
} from '../../firsthand/runtime-repository';
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
  mockMaxBytes.mockReturnValue(2 * 1024 * 1024 * 1024);
  mockSeed.mockResolvedValue({ sessionId: 'session_1', attemptNumber: 1 });
  mockRecordEvent.mockResolvedValue(undefined);
  mockTranscript.mockResolvedValue({ transcriptStatus: 'complete' });
});

// The five route files, as request thunks against the owner app.
const endpoints: Array<{ name: string; call: () => request.Test }> = [
  { name: 'GET /:token', call: () => request(ownerApp).get(`/api/firsthand/session/${TOKEN}`) },
  { name: 'GET /:token/runtime', call: () => request(ownerApp).get(`/api/firsthand/session/${TOKEN}/runtime`) },
  { name: 'POST /:token/runtime', call: () => request(ownerApp).post(`/api/firsthand/session/${TOKEN}/runtime`).send({ type: 'event', eventType: 'session_started' }) },
  { name: 'POST /:token/recording', call: () => request(ownerApp).post(`/api/firsthand/session/${TOKEN}/recording`).set('Content-Type', 'video/webm').send(Buffer.from('x')) },
  { name: 'POST /:token/recording/client-upload', call: () => request(ownerApp).post(`/api/firsthand/session/${TOKEN}/recording/client-upload`).send({ durationSeconds: 1, fileName: 'a.webm', mimeType: 'video/webm', fileSizeBytes: 10 }) },
  { name: 'POST /:token/recording/finalize', call: () => request(ownerApp).post(`/api/firsthand/session/${TOKEN}/recording/finalize`).send({ durationSeconds: 1, objectKey: 'recordings/session_1/a.webm' }) }
];

describe('B4 participant runtime — auth gate (requireAuth)', () => {
  it('every mutating + read endpoint is 401 without a session', async () => {
    const anonApp = buildApp(null);
    const calls = [
      () => request(anonApp).get(`/api/firsthand/session/${TOKEN}`),
      () => request(anonApp).get(`/api/firsthand/session/${TOKEN}/runtime`),
      () => request(anonApp).post(`/api/firsthand/session/${TOKEN}/runtime`).send({ type: 'event', eventType: 'session_started' }),
      () => request(anonApp).post(`/api/firsthand/session/${TOKEN}/recording`).set('Content-Type', 'video/webm').send(Buffer.from('x')),
      () => request(anonApp).post(`/api/firsthand/session/${TOKEN}/recording/client-upload`).send({ durationSeconds: 1, fileName: 'a.webm', mimeType: 'video/webm', fileSizeBytes: 10 }),
      () => request(anonApp).post(`/api/firsthand/session/${TOKEN}/recording/finalize`).send({ durationSeconds: 1, objectKey: 'k' })
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
    await request(ownerApp).post(`/api/firsthand/session/${TOKEN}/runtime`).send({ type: 'event', eventType: 'session_started' });
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });
});

describe('B4 participant runtime — session-load failure mapping', () => {
  it('maps expired -> 410', async () => {
    mockLoad.mockResolvedValue({ kind: 'expired', message: 'gone' });
    const res = await request(ownerApp).get(`/api/firsthand/session/${TOKEN}`);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('expired');
  });
  it('maps invalid_contract -> 422', async () => {
    mockLoad.mockResolvedValue({ kind: 'invalid_contract', message: 'bad' });
    const res = await request(ownerApp).get(`/api/firsthand/session/${TOKEN}`);
    expect(res.status).toBe(422);
  });
  it('maps not_found -> 404', async () => {
    mockLoad.mockResolvedValue({ kind: 'not_found', message: 'nope' });
    const res = await request(ownerApp).get(`/api/firsthand/session/${TOKEN}`);
    expect(res.status).toBe(404);
  });
  it('sets Referrer-Policy: no-referrer for token-in-URL hygiene', async () => {
    okSession();
    const res = await request(ownerApp).get(`/api/firsthand/session/${TOKEN}`);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('B4 GET /:token + GET /:token/runtime', () => {
  it('returns the bound session payload', async () => {
    okSession();
    const res = await request(ownerApp).get(`/api/firsthand/session/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.session.session_id).toBe('session_1');
  });
  it('seeds and returns the runtime snapshot', async () => {
    okSession();
    mockSeed.mockResolvedValue({ sessionId: 'session_1', attemptNumber: 1, sessionStatus: 'in_progress' });
    const res = await request(ownerApp).get(`/api/firsthand/session/${TOKEN}/runtime`);
    expect(res.status).toBe(200);
    expect(mockSeed).toHaveBeenCalled();
    expect(res.body.sessionId).toBe('session_1');
  });
  it('selects a specific attempt when ?attempt= is supplied', async () => {
    okSession();
    mockGetRuntime.mockResolvedValue({ sessionId: 'session_1', attemptNumber: 3 });
    const res = await request(ownerApp).get(`/api/firsthand/session/${TOKEN}/runtime?attempt=3`);
    expect(res.status).toBe(200);
    expect(mockGetRuntime).toHaveBeenCalledWith('session_1', { attemptNumber: 3 });
    expect(res.body.attemptNumber).toBe(3);
  });
});

describe('B4 POST /:token/runtime', () => {
  it('applies a valid mutation and records the lifecycle event in-process', async () => {
    okSession();
    mockApply.mockResolvedValue({ sessionId: 'session_1', sessionStatus: 'completed', logicalSessionId: 'session_1' });
    const res = await request(ownerApp)
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .send({ type: 'event', eventType: 'upload_completed' });
    expect(res.status).toBe(200);
    expect(mockApply).toHaveBeenCalled();
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty body with 422 rather than 500 (abandoned session)', async () => {
    okSession();
    const res = await request(ownerApp)
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .set('Content-Type', 'application/json')
      .send('');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('invalid_runtime_mutation');
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('turns a truncated JSON body into a clean 400, never a 500', async () => {
    okSession();
    const res = await request(ownerApp)
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .set('Content-Type', 'application/json')
      .send('{"type":"eve');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REQUEST_BODY');
    expect(mockApply).not.toHaveBeenCalled();
  });
});

describe('B4 POST /:token/recording/client-upload (S3-only)', () => {
  it('presigns a server-derived S3 key and returns it', async () => {
    okSession();
    mockPresign.mockResolvedValue('https://s3.example/put?sig=1');
    const res = await request(ownerApp)
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
    const res = await request(ownerApp)
      .post(`/api/firsthand/session/${TOKEN}/recording/client-upload`)
      .send({ fileName: '', mimeType: 'video/webm' });
    expect(res.status).toBe(422);
    expect(mockRegisterPending).not.toHaveBeenCalled();
  });

  it('rejects an over-cap declared size with 413', async () => {
    okSession();
    mockMaxBytes.mockReturnValue(2048);
    const res = await request(ownerApp)
      .post(`/api/firsthand/session/${TOKEN}/recording/client-upload`)
      .send({ durationSeconds: 1, fileName: 'a.webm', mimeType: 'video/webm', fileSizeBytes: 4096 });
    expect(res.status).toBe(413);
    expect(res.body.maximumSizeInBytes).toBe(2048);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it('forwards the requested attempt number', async () => {
    okSession();
    mockPresign.mockResolvedValue('https://s3/put');
    await request(ownerApp)
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
    const res = await request(ownerApp)
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
    const res = await request(ownerApp)
      .post(`/api/firsthand/session/${TOKEN}/recording/finalize`)
      .send({ durationSeconds: 1, objectKey: goodPending.relativePath });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('asset_1');
  });

  it('rejects an unregistered key with 403', async () => {
    okSession();
    mockResolvePending.mockResolvedValue(null);
    const res = await request(ownerApp)
      .post(`/api/firsthand/session/${TOKEN}/recording/finalize`)
      .send({ durationSeconds: 1, objectKey: 'recordings/session_1/never.webm' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('unknown_upload');
  });

  it("rejects a pending upload registered under another session's token with 403", async () => {
    okSession();
    mockResolvePending.mockResolvedValue({ ...goodPending, token: 'fh_other_token' });
    const res = await request(ownerApp)
      .post(`/api/firsthand/session/${TOKEN}/recording/finalize`)
      .send({ durationSeconds: 1, objectKey: goodPending.relativePath });
    expect(res.status).toBe(403);
  });

  it('rejects an expired pending upload with 410', async () => {
    okSession();
    mockResolvePending.mockResolvedValue({ ...goodPending, validUntil: new Date(Date.now() - 1000).toISOString() });
    const res = await request(ownerApp)
      .post(`/api/firsthand/session/${TOKEN}/recording/finalize`)
      .send({ durationSeconds: 1, objectKey: goodPending.relativePath });
    expect(res.status).toBe(410);
  });

  it('rejects a missing uploaded object with 422', async () => {
    okSession();
    mockResolvePending.mockResolvedValue(goodPending);
    mockHead.mockResolvedValue(null);
    const res = await request(ownerApp)
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
    const res = await request(ownerApp)
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
    const res = await request(ownerApp)
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
    const res = await request(ownerApp)
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
    const res = await request(ownerApp)
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
    const res = await request(buildCsrfApp())
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .send({ type: 'event', eventType: 'session_started' });
    expect(res.status).toBe(403);
  });

  it('allows a GET with no CSRF token (auto-exempt)', async () => {
    okSession();
    const res = await request(buildCsrfApp()).get(`/api/firsthand/session/${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it('allows a mutating POST that echoes the issued CSRF token + cookie', async () => {
    okSession();
    mockApply.mockResolvedValue({ sessionId: 'session_1', sessionStatus: 'in_progress' });
    const app = buildCsrfApp();
    const agent = request.agent(app);
    const tokenRes = await agent.get('/api/csrf-token');
    const csrf = tokenRes.body.csrfToken;
    const res = await agent
      .post(`/api/firsthand/session/${TOKEN}/runtime`)
      .set('x-csrf-token', csrf)
      .send({ type: 'event', eventType: 'session_started' });
    expect(res.status).toBe(200);
  });
});
