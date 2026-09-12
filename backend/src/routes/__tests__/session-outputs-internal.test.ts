import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// In-process outputs route + the media streaming route (B3c). The HMAC proxy is
// gone, so this is the only path: the firsthand runtime/storage layer is mocked
// and the real buildSessionOutputs + sessionOutputsSchema assemble the response.

// #14: route suites use the session-trusting auth double (see middleware/__mocks__/authenticate.ts);
// the real gate now re-reads the DB role, which their positional pool mock cannot satisfy.
jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: { query: jest.fn() }
}));

jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn()
}));

jest.mock('../../firsthand/runtime-repository-postgres', () => ({
  getRuntimeSession: jest.fn(),
  listRuntimeSessionAttempts: jest.fn(),
  getRuntimeAsset: jest.fn()
}));

jest.mock('../../firsthand/object-storage', () => ({
  createRecordingAssetResponse: jest.fn()
}));

import sessionOutputsRouter from '../session-outputs';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import {
  getRuntimeSession,
  listRuntimeSessionAttempts,
  getRuntimeAsset
} from '../../firsthand/runtime-repository-postgres';
import { createRecordingAssetResponse } from '../../firsthand/object-storage';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as jest.MockedFunction<any>;
const mockIsDatabaseAvailable = isDatabaseAvailable as jest.MockedFunction<any>;
const mockGetRuntimeSession = getRuntimeSession as jest.MockedFunction<any>;
const mockListAttempts = listRuntimeSessionAttempts as jest.MockedFunction<any>;
const mockGetRuntimeAsset = getRuntimeAsset as jest.MockedFunction<any>;
const mockCreateAssetResponse = createRecordingAssetResponse as jest.MockedFunction<any>;

function buildApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.session = user ? { user } : {};
    next();
  });
  app.use('/api/opportunities', sessionOutputsRouter);
  app.use(errorHandler);
  return app;
}

const ownerUser = {
  id: 'owner-user-id',
  name: 'Owner User',
  email: 'owner@example.com',
  role: 'researcher_admin'
};
const otherAdminUser = { ...ownerUser, id: 'other-admin-id' };
const superadminUser = { ...ownerUser, id: 'superadmin-id', role: 'superadmin' };
const employeeUser = { ...ownerUser, role: 'employee' };

const ownerApp = buildApp(ownerUser);

function mockOwnershipRow(ownerUserId = 'owner-user-id') {
  mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: ownerUserId }] });
}
function mockScopingHit() {
  // assertSessionBelongsToOpportunity only checks rows.length; the query selects
  // the literal 1, so a shapeless row communicates "one match" accurately.
  mockQuery.mockResolvedValueOnce({ rows: [{}] });
}

// A completed runtime session with one open-text step and one playable video
// asset, matching the fields buildSessionOutputs reads.
function buildRuntimeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session_abc',
    logicalSessionId: 'session_abc',
    attemptNumber: 1,
    token: 'fh_token',
    studyId: 'study_123',
    studyTitle: 'Checkout flow study',
    participantId: 'user_42',
    participantDisplayName: 'Jane Doe',
    sessionStatus: 'completed',
    transcriptStatus: 'complete',
    startedAt: '2026-07-15T10:00:00.000Z',
    completedAt: '2026-07-15T10:14:30.000Z',
    transcript: null,
    transcriptFailureMessage: null,
    steps: [
      { stepId: 'step_1', order: 1, type: 'open_text', prompt: 'How was checkout?' }
    ],
    responses: [],
    assets: [
      {
        id: 'asset_1',
        sessionId: 'session_abc',
        fileName: 'capture.webm',
        mimeType: 'video/webm',
        fileSizeBytes: 1024,
        durationSeconds: 30,
        storageProvider: 's3',
        relativePath: 'recordings/session_abc/capture.webm',
        uploadedAt: '2026-07-15T10:14:00.000Z'
      }
    ],
    ...overrides
  };
}

const OUTPUTS_PATH = '/api/opportunities/opp-1/sessions/session_abc/outputs';
const MEDIA_PATH = '/api/opportunities/opp-1/sessions/session_abc/assets/asset_1/media';

describe('GET outputs - in-process assembly', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    mockIsDatabaseAvailable.mockResolvedValue(true);
    mockListAttempts.mockResolvedValue([]);
    process.env.FRONTEND_URL = 'https://cortex.example.com';
  });

  afterEach(() => {
    delete process.env.FRONTEND_URL;
  });

  it('returns 401 when unauthenticated', async () => {
    const response = await request(listening(buildApp(null))).get(OUTPUTS_PATH);
    expect(response.status).toBe(401);
    expect(mockGetRuntimeSession).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin role', async () => {
    const response = await request(listening(buildApp(employeeUser))).get(OUTPUTS_PATH);
    expect(response.status).toBe(403);
    expect(mockGetRuntimeSession).not.toHaveBeenCalled();
  });

  it('returns 403 for an admin who does not own the opportunity', async () => {
    mockOwnershipRow('owner-user-id');
    const response = await request(listening(buildApp(otherAdminUser))).get(OUTPUTS_PATH);
    expect(response.status).toBe(403);
    expect(mockGetRuntimeSession).not.toHaveBeenCalled();
  });

  it('returns 503 when the database is unavailable', async () => {
    mockIsDatabaseAvailable.mockResolvedValue(false);
    const response = await request(listening(ownerApp)).get(OUTPUTS_PATH);
    expect(response.status).toBe(503);
    expect(mockGetRuntimeSession).not.toHaveBeenCalled();
  });

  it('returns 404 when the session does not belong to the opportunity', async () => {
    mockOwnershipRow();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const response = await request(listening(ownerApp)).get(OUTPUTS_PATH);
    expect(response.status).toBe(404);
    expect(mockGetRuntimeSession).not.toHaveBeenCalled();
  });

  it('returns 404 when the runtime session does not exist', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockGetRuntimeSession.mockResolvedValue(null);
    const response = await request(listening(ownerApp)).get(OUTPUTS_PATH);
    expect(response.status).toBe(404);
  });

  it('returns 400 for an invalid attempt value', async () => {
    mockOwnershipRow();
    mockScopingHit();
    const response = await request(listening(ownerApp)).get(`${OUTPUTS_PATH}?attempt=abc`);
    expect(response.status).toBe(400);
    expect(mockGetRuntimeSession).not.toHaveBeenCalled();
  });

  it('forwards a valid attempt query parameter to the runtime repository', async () => {
    mockOwnershipRow();
    mockScopingHit();
    const session = buildRuntimeSession({ attemptNumber: 2 });
    mockGetRuntimeSession.mockResolvedValue(session);
    mockListAttempts.mockResolvedValue([session]);
    const response = await request(listening(ownerApp)).get(`${OUTPUTS_PATH}?attempt=2`);
    expect(response.status).toBe(200);
    expect(mockGetRuntimeSession).toHaveBeenCalledWith('session_abc', { attemptNumber: 2 });
    expect(mockListAttempts).toHaveBeenCalledWith('session_abc');
  });

  it('assembles outputs and mints an absolute same-origin media_url for playable assets', async () => {
    mockOwnershipRow();
    mockScopingHit();
    const session = buildRuntimeSession();
    mockGetRuntimeSession.mockResolvedValue(session);
    mockListAttempts.mockResolvedValue([session]);

    const response = await request(listening(ownerApp)).get(OUTPUTS_PATH);

    expect(response.status).toBe(200);
    expect(response.body.contract_version).toBe('1.0');
    expect(response.body.session.session_id).toBe('session_abc');
    // Absolute, built from the trusted FRONTEND_URL (never request headers).
    expect(response.body.assets[0].media_url).toBe(
      'https://cortex.example.com/api/opportunities/opp-1/sessions/session_abc/assets/asset_1/media'
    );
  });

  it('assembles outputs when the repository returns no separate attempt rows', async () => {
    mockOwnershipRow();
    mockScopingHit();
    const session = buildRuntimeSession();
    mockGetRuntimeSession.mockResolvedValue(session);
    // Leave the beforeEach default (empty attempts) in place: the route must
    // fall back to [session] so attempts satisfies the schema's min(1).
    mockListAttempts.mockResolvedValue([]);

    const response = await request(listening(ownerApp)).get(OUTPUTS_PATH);

    expect(response.status).toBe(200);
    expect(response.body.attempts).toHaveLength(1);
    expect(response.body.attempts[0].session_id).toBe('session_abc');
  });

  it('leaves media_url null for non-playable assets', async () => {
    mockOwnershipRow();
    mockScopingHit();
    const session = buildRuntimeSession({
      assets: [
        {
          id: 'asset_doc',
          sessionId: 'session_abc',
          fileName: 'notes.txt',
          mimeType: 'text/plain',
          fileSizeBytes: 12,
          durationSeconds: null,
          storageProvider: 's3',
          relativePath: 'recordings/session_abc/notes.txt',
          uploadedAt: '2026-07-15T10:14:00.000Z'
        }
      ]
    });
    mockGetRuntimeSession.mockResolvedValue(session);
    mockListAttempts.mockResolvedValue([session]);

    const response = await request(listening(ownerApp)).get(OUTPUTS_PATH);

    expect(response.status).toBe(200);
    expect(response.body.assets[0].media_url).toBeNull();
  });

  it('allows a superadmin who does not own the opportunity', async () => {
    mockOwnershipRow('owner-user-id');
    mockScopingHit();
    const session = buildRuntimeSession();
    mockGetRuntimeSession.mockResolvedValue(session);
    mockListAttempts.mockResolvedValue([session]);
    const response = await request(listening(buildApp(superadminUser))).get(OUTPUTS_PATH);
    expect(response.status).toBe(200);
  });

  it('returns 500 when the assembled outputs fail validation', async () => {
    mockOwnershipRow();
    mockScopingHit();
    // Empty studyTitle violates sessionOutputsSchema (min length 1).
    const session = buildRuntimeSession({ studyTitle: '' });
    mockGetRuntimeSession.mockResolvedValue(session);
    mockListAttempts.mockResolvedValue([session]);
    const response = await request(listening(ownerApp)).get(OUTPUTS_PATH);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'outputs_assembly_failed' });
  });
});

describe('GET assets/:assetId/media - same-origin recording stream', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    mockIsDatabaseAvailable.mockResolvedValue(true);
  });

  it('returns 401 when unauthenticated', async () => {
    const response = await request(listening(buildApp(null))).get(MEDIA_PATH);
    expect(response.status).toBe(401);
    expect(mockGetRuntimeAsset).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin role', async () => {
    const response = await request(listening(buildApp(employeeUser))).get(MEDIA_PATH);
    expect(response.status).toBe(403);
    expect(mockGetRuntimeAsset).not.toHaveBeenCalled();
  });

  it('returns 403 for an admin who does not own the opportunity', async () => {
    mockOwnershipRow('owner-user-id');
    const response = await request(listening(buildApp(otherAdminUser))).get(MEDIA_PATH);
    expect(response.status).toBe(403);
    expect(mockGetRuntimeAsset).not.toHaveBeenCalled();
  });

  it('returns 503 when the database is unavailable', async () => {
    mockIsDatabaseAvailable.mockResolvedValue(false);
    const response = await request(listening(ownerApp)).get(MEDIA_PATH);
    expect(response.status).toBe(503);
    expect(mockGetRuntimeAsset).not.toHaveBeenCalled();
  });

  it('returns 404 when the opportunity does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const response = await request(listening(ownerApp)).get(MEDIA_PATH);
    expect(response.status).toBe(404);
    expect(mockGetRuntimeAsset).not.toHaveBeenCalled();
  });

  it('returns 404 when the session does not belong to the opportunity', async () => {
    mockOwnershipRow();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const response = await request(listening(ownerApp)).get(MEDIA_PATH);
    expect(response.status).toBe(404);
    expect(mockGetRuntimeAsset).not.toHaveBeenCalled();
  });

  it('returns 404 when the asset is not found', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockGetRuntimeAsset.mockResolvedValue(null);
    const response = await request(listening(ownerApp)).get(MEDIA_PATH);
    expect(response.status).toBe(404);
    expect(mockGetRuntimeAsset).toHaveBeenCalledWith('session_abc', 'asset_1');
  });

  it('returns 404 for a non-playable asset (no inline HTML serving)', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockGetRuntimeAsset.mockResolvedValue({ id: 'asset_1', mimeType: 'text/html' });
    const response = await request(listening(ownerApp)).get(MEDIA_PATH);
    expect(response.status).toBe(404);
    expect(mockCreateAssetResponse).not.toHaveBeenCalled();
  });

  it('streams the recording (200) with nosniff + no-store, forwarding no Range header', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockGetRuntimeAsset.mockResolvedValue({ id: 'asset_1', mimeType: 'video/webm' });
    mockCreateAssetResponse.mockResolvedValue(
      new Response('stream-bytes', {
        status: 200,
        headers: { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes' }
      })
    );

    const response = await request(listening(ownerApp)).get(MEDIA_PATH).buffer(true);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('video/webm');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(Buffer.from(response.body).toString()).toBe('stream-bytes');
    expect(mockCreateAssetResponse).toHaveBeenCalledWith(
      { id: 'asset_1', mimeType: 'video/webm' },
      { rangeHeader: null }
    );
  });

  it('forwards the Range header and returns a 206 partial', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockGetRuntimeAsset.mockResolvedValue({ id: 'asset_1', mimeType: 'video/webm' });
    mockCreateAssetResponse.mockResolvedValue(
      new Response('slice', {
        status: 206,
        headers: { 'Content-Type': 'video/webm', 'Content-Range': 'bytes 0-4/1024' }
      })
    );

    const response = await request(listening(ownerApp))
      .get(MEDIA_PATH)
      .set('Range', 'bytes=0-4');

    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toBe('bytes 0-4/1024');
    expect(mockCreateAssetResponse).toHaveBeenCalledWith(
      { id: 'asset_1', mimeType: 'video/webm' },
      { rangeHeader: 'bytes=0-4' }
    );
  });

  it('forwards a malformed Range verbatim (the storage layer resolves it to full)', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockGetRuntimeAsset.mockResolvedValue({ id: 'asset_1', mimeType: 'video/webm' });
    mockCreateAssetResponse.mockResolvedValue(
      new Response('whole', { status: 200, headers: { 'Content-Type': 'video/webm' } })
    );

    const response = await request(listening(ownerApp))
      .get(MEDIA_PATH)
      .set('Range', 'bytes=abc-def');

    expect(response.status).toBe(200);
    expect(mockCreateAssetResponse).toHaveBeenCalledWith(
      { id: 'asset_1', mimeType: 'video/webm' },
      { rangeHeader: 'bytes=abc-def' }
    );
  });

  it('returns a 416 with headers only when the range is unsatisfiable', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockGetRuntimeAsset.mockResolvedValue({ id: 'asset_1', mimeType: 'video/webm' });
    mockCreateAssetResponse.mockResolvedValue(
      new Response(null, {
        status: 416,
        headers: { 'Content-Range': 'bytes */1024', 'Accept-Ranges': 'bytes' }
      })
    );

    const response = await request(listening(ownerApp))
      .get(MEDIA_PATH)
      .set('Range', 'bytes=999999-');

    expect(response.status).toBe(416);
    expect(response.headers['content-range']).toBe('bytes */1024');
  });

  it('returns 404 when the object is genuinely missing (NoSuchKey)', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockGetRuntimeAsset.mockResolvedValue({ id: 'asset_1', mimeType: 'video/webm' });
    const notFound = Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    mockCreateAssetResponse.mockRejectedValue(notFound);

    const response = await request(listening(ownerApp)).get(MEDIA_PATH);

    expect(response.status).toBe(404);
  });

  it('returns 500 (not a masked 404) when storage fails for a non-missing reason', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockGetRuntimeAsset.mockResolvedValue({ id: 'asset_1', mimeType: 'video/webm' });
    const denied = Object.assign(new Error('access denied'), { name: 'AccessDenied' });
    mockCreateAssetResponse.mockRejectedValue(denied);

    const response = await request(listening(ownerApp)).get(MEDIA_PATH);

    expect(response.status).toBe(500);
  });

  it('sends a clean 500 with no stale content headers when the stream errors before any bytes', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockGetRuntimeAsset.mockResolvedValue({ id: 'asset_1', mimeType: 'video/webm' });
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('s3 body read failed'));
      }
    });
    mockCreateAssetResponse.mockResolvedValue(
      new Response(failing, {
        status: 200,
        headers: {
          'Content-Type': 'video/webm',
          'Content-Length': '1024',
          'Accept-Ranges': 'bytes'
        }
      })
    );

    const response = await request(listening(ownerApp)).get(MEDIA_PATH);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'media_stream_failed' });
    // The optimistically-set streaming headers must be gone so the client does
    // not wait on a Content-Length that will never be satisfied.
    expect(response.headers['content-length']).not.toBe('1024');
    expect(response.headers['accept-ranges']).toBeUndefined();
  });
});
