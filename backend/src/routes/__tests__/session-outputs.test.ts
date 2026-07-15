import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

// Mock the database pool for testing (factory uses only inline jest.fn() to avoid TDZ)
jest.mock('../../config', () => ({
  pool: {
    query: jest.fn(),
  }
}));

// Without this, isDatabaseAvailable() resolves false in the test process (no
// DATABASE_URL), and the route returns 503 before exercising pool.query at all.
jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

jest.mock('../../utils/firsthand-client', () => {
  class MockFirstHandHttpError extends Error {
    constructor(public readonly status: number, message: string) {
      super(message);
      this.name = 'FirstHandHttpError';
    }
  }
  return {
    isFirstHandConfigured: jest.fn(),
    firstHandGet: jest.fn(),
    FirstHandHttpError: MockFirstHandHttpError,
  };
});

import sessionOutputsRouter from '../session-outputs';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { isFirstHandConfigured, firstHandGet, FirstHandHttpError } from '../../utils/firsthand-client';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as jest.MockedFunction<any>;
const mockIsDatabaseAvailable = isDatabaseAvailable as jest.MockedFunction<any>;
const mockIsFirstHandConfigured = isFirstHandConfigured as jest.MockedFunction<any>;
const mockFirstHandGet = firstHandGet as jest.MockedFunction<any>;

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

const outputsFixture = {
  contract_version: '1.0',
  session: {
    session_id: 'session_abc',
    logical_session_id: 'session_abc',
    attempt_number: 1,
    study_id: 'study_123',
    study_title: 'Checkout flow study',
    participant: { participant_id: 'user_42', display_name: 'Jane Doe' },
    session_status: 'completed',
    started_at: '2026-07-15T10:00:00.000Z',
    completed_at: '2026-07-15T10:14:30.000Z',
    transcript_status: 'complete',
    transcript_failure_message: null
  },
  attempts: [],
  steps: [],
  transcript: null,
  assets: []
};

const OUTPUTS_PATH = '/api/opportunities/opp-1/sessions/session_abc/outputs';

function mockOwnershipRow(ownerUserId = 'owner-user-id') {
  mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: ownerUserId }] });
}

function mockScopingHit() {
  mockQuery.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
}

describe('GET /api/opportunities/:id/sessions/:sessionId/outputs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    mockIsDatabaseAvailable.mockResolvedValue(true);
    mockIsFirstHandConfigured.mockReturnValue(true);
  });

  it('returns 401 when unauthenticated', async () => {
    const response = await request(buildApp(null)).get(OUTPUTS_PATH);

    expect(response.status).toBe(401);
    expect(mockFirstHandGet).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin role', async () => {
    const response = await request(buildApp(employeeUser)).get(OUTPUTS_PATH);

    expect(response.status).toBe(403);
    expect(mockFirstHandGet).not.toHaveBeenCalled();
  });

  it('returns 403 for an admin who does not own the opportunity', async () => {
    mockOwnershipRow('owner-user-id');

    const response = await request(buildApp(otherAdminUser)).get(OUTPUTS_PATH);

    expect(response.status).toBe(403);
    expect(mockFirstHandGet).not.toHaveBeenCalled();
  });

  it('allows a superadmin who does not own the opportunity', async () => {
    mockOwnershipRow('owner-user-id');
    mockScopingHit();
    mockFirstHandGet.mockResolvedValue(outputsFixture);

    const response = await request(buildApp(superadminUser)).get(OUTPUTS_PATH);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(outputsFixture);
  });

  it('returns 404 when the opportunity does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const response = await request(ownerApp).get(OUTPUTS_PATH);

    expect(response.status).toBe(404);
    expect(mockFirstHandGet).not.toHaveBeenCalled();
  });

  it('returns 503 when FirstHand is not configured', async () => {
    mockIsFirstHandConfigured.mockReturnValue(false);
    mockOwnershipRow();

    const response = await request(ownerApp).get(OUTPUTS_PATH);

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('FirstHand integration not configured');
    expect(mockFirstHandGet).not.toHaveBeenCalled();
  });

  it('returns 503 when the database is unavailable', async () => {
    mockIsDatabaseAvailable.mockResolvedValue(false);

    const response = await request(ownerApp).get(OUTPUTS_PATH);

    expect(response.status).toBe(503);
    expect(mockFirstHandGet).not.toHaveBeenCalled();
  });

  it('returns 404 when the session does not belong to the opportunity', async () => {
    mockOwnershipRow();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const response = await request(ownerApp).get(OUTPUTS_PATH);

    expect(response.status).toBe(404);
    expect(mockFirstHandGet).not.toHaveBeenCalled();
  });

  it('proxies the outputs for the opportunity owner', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockFirstHandGet.mockResolvedValue(outputsFixture);

    const response = await request(ownerApp).get(OUTPUTS_PATH);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(outputsFixture);
    expect(mockFirstHandGet).toHaveBeenCalledWith('/api/sessions/session_abc/outputs');
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('opportunity_session_events'),
      ['opp-1', 'session_abc']
    );
  });

  it('forwards a valid attempt query parameter', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockFirstHandGet.mockResolvedValue(outputsFixture);

    const response = await request(ownerApp).get(`${OUTPUTS_PATH}?attempt=2`);

    expect(response.status).toBe(200);
    expect(mockFirstHandGet).toHaveBeenCalledWith('/api/sessions/session_abc/outputs?attempt=2');
  });

  it('returns 400 for an invalid attempt value', async () => {
    mockOwnershipRow();
    mockScopingHit();

    const response = await request(ownerApp).get(`${OUTPUTS_PATH}?attempt=abc`);

    expect(response.status).toBe(400);
    expect(mockFirstHandGet).not.toHaveBeenCalled();
  });

  it('maps a FirstHand 404 to a 404', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockFirstHandGet.mockRejectedValue(new FirstHandHttpError(404, 'FirstHand GET returned 404'));

    const response = await request(ownerApp).get(OUTPUTS_PATH);

    expect(response.status).toBe(404);
  });

  it('maps a FirstHand 503 to a 503', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockFirstHandGet.mockRejectedValue(new FirstHandHttpError(503, 'FirstHand GET returned 503'));

    const response = await request(ownerApp).get(OUTPUTS_PATH);

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('FirstHand integration unavailable');
  });

  it('maps an unexpected FirstHand error to a 500', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockFirstHandGet.mockRejectedValue(new FirstHandHttpError(500, 'FirstHand GET returned 500'));

    const response = await request(ownerApp).get(OUTPUTS_PATH);

    expect(response.status).toBe(500);
  });

  it('maps a network error to a 500', async () => {
    mockOwnershipRow();
    mockScopingHit();
    mockFirstHandGet.mockRejectedValue(new Error('FirstHand GET failed: network error'));

    const response = await request(ownerApp).get(OUTPUTS_PATH);

    expect(response.status).toBe(500);
  });
});
