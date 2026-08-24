import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// #14: route suites use the session-trusting auth double (see middleware/__mocks__/authenticate.ts);
// the real gate now re-reads the DB role, which their positional pool mock cannot satisfy.
jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

// The in-memory store lives outside src and is not transformed under jest, so it
// is mocked. getAllMockSessions returns [] - the session is always absent, which
// is the "no such session" case under test.
jest.mock('../../../../demo/mock-data', () => ({
  getAllMockSessions: jest.fn(() => []),
  getMockOpportunity: jest.fn(),
  addMockSessions: jest.fn(),
  getMockSessions: jest.fn(),
  updateMockSession: jest.fn(),
  deleteMockSession: jest.fn(),
}));

import sessionsRouter from '../sessions';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';

const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * THE DEV-ONLY MOCK PATH MUST NOT BE AN EXISTENCE ORACLE EITHER. cto/AdaptaLabs#33.
 *
 * When no database is configured (development/test only), PATCH and DELETE
 * /api/sessions/:id fall to an in-memory store. That path used to answer 404 to
 * EVERYONE for a session that does not exist, while answering 403 for one that
 * exists but is not yours - so a researcher_admin could tell the two apart,
 * which is exactly the oracle the database path closes (!215, #28). This pins
 * the two paths to the same disposition: only a superadmin gets the honest 404;
 * everyone else gets 403 for both cases.
 *
 * A GUARANTEED-ABSENT id is used, so `getAllMockSessions()` (the real in-memory
 * store) never contains it and the "no such session" branch is the one under
 * test. `isDatabaseAvailable` is forced false to reach the mock path at all.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const appAs = (role: Role) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user: { id: string; name: string; email: string; role: Role } } }).session = {
      user: { id: 'u-1', name: 'A', email: 'a@example.com', role },
    };
    next();
  });
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
};

const ABSENT = 'no-such-session-000000000000';

beforeEach(() => {
  // clearAllMocks, NOT resetAllMocks: reset would wipe the getAllMockSessions
  // factory implementation (-> undefined -> `.find` throws -> a 500 that masks
  // what this test checks). clear resets call history but keeps the impl.
  jest.clearAllMocks();
  mockIsDatabaseAvailable.mockResolvedValue(false as never);
});

describe('mock path: PATCH /api/sessions/:id for a session that does not exist', () => {
  const patch = (role: Role) =>
    request(listening(appAs(role))).patch(`/api/sessions/${ABSENT}`).send({ capacity: 2 });

  it('answers 403 to a researcher_admin, not 404, so existence does not leak', async () => {
    const res = await patch('researcher_admin').expect(403);
    expect(res.body.error).toBe('Only the owner can edit this session');
  });

  it('answers 404 to a superadmin, who is entitled to the truth', async () => {
    await patch('superadmin').expect(404);
  });
});

describe('mock path: DELETE /api/sessions/:id for a session that does not exist', () => {
  const del = (role: Role) => request(listening(appAs(role))).delete(`/api/sessions/${ABSENT}`);

  it('answers 403 to a researcher_admin, not 404, so existence does not leak', async () => {
    const res = await del('researcher_admin').expect(403);
    expect(res.body.error).toBe('Only the owner can delete this session');
  });

  it('answers 404 to a superadmin, who is entitled to the truth', async () => {
    await del('superadmin').expect(404);
  });
});
