import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

import { listening } from '../../__tests__/helpers/listening';

// #14: route suites use the session-trusting auth double - see
// middleware/__mocks__/authenticate.ts.
jest.mock('../../middleware/authenticate');

// The pool is mocked and its query spy asserted un-called on a 200: the whole
// point of this endpoint is that a draft writes NOTHING to Postgres.
jest.mock('../../config', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn()
  }
}));

// The drafting SERVICE itself (the model call, the retry loop, consent
// filling, link stripping) is unit-tested with the SDK mocked in
// services/__tests__/study-drafter.test.ts. This file is the route: guard
// order, the limiter, body validation, dormancy, and the no-DB-write
// guarantee - so the service is mocked wholesale here.
jest.mock('../../services/study-drafter', () => {
  const actual = jest.requireActual('../../services/study-drafter') as typeof import('../../services/study-drafter');
  return {
    ...actual,
    draftOpportunityFromBrief: jest.fn(),
    isAiDraftingConfigured: jest.fn()
  };
});

import { pool } from '../../config';
import {
  draftOpportunityFromBrief,
  isAiDraftingConfigured,
  DraftRejectedError
} from '../../services/study-drafter';
import opportunitiesRouter, { resetParticipantRouteLimits } from '../opportunities';
import { errorHandler } from '../../utils/errorHandler';
import type { DraftResult } from '../../services/study-drafter';

const mockQuery = pool.query as jest.MockedFunction<typeof pool.query>;
const mockDraft = draftOpportunityFromBrief as jest.MockedFunction<
  typeof draftOpportunityFromBrief
>;
const mockConfigured = isAiDraftingConfigured as jest.MockedFunction<
  typeof isAiDraftingConfigured
>;

const VALID_BRIEF =
  'Do first-time admins understand the new board view well enough to set one up without help?';

const SAMPLE_RESULT: DraftResult = {
  draft: {
    type: 'poll',
    title: 'Board view discoverability',
    purpose_one_liner: 'Understand whether admins can self-serve the new board view',
    status: 'draft'
  },
  assumptions: [],
  gaps: [],
  filled: ['type', 'title', 'purpose_one_liner']
};

/** Builds a fresh app carrying the given session user (or none, unauthenticated). */
const buildApp = (
  sessionUser: { id: string; role: string } | null
): express.Express => {
  const app = express();
  app.use(express.json());
  // requireAdmin/optionalAuth only read req.session.user (see
  // middleware/__mocks__/authenticate.ts) - a plain stub is enough, and this
  // narrow cast is scoped to the one assignment rather than the whole handler.
  app.use((req, _res, next) => {
    (
      req as unknown as {
        session: { user?: { id: string; role: string; name: string; email: string } };
      }
    ).session = sessionUser
      ? { user: { ...sessionUser, name: 'Test', email: 't@example.com' } }
      : {};
    next();
  });
  app.use('/api/opportunities', opportunitiesRouter);
  app.use(errorHandler);
  return app;
};

describe('POST /api/opportunities/draft-from-brief', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfigured.mockReturnValue(true);
    mockDraft.mockResolvedValue(SAMPLE_RESULT);
    for (const id of ['admin-1', 'admin-2', 'admin-3', 'admin-rate-limit', 'participant-1']) {
      resetParticipantRouteLimits(id);
    }
  });

  describe('auth guard', () => {
    it('401s with no session', async () => {
      const app = buildApp(null);

      const response = await request(listening(app))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: VALID_BRIEF });

      expect(response.status).toBe(401);
      expect(mockDraft).not.toHaveBeenCalled();
    });

    it('403s as a signed-in participant', async () => {
      const app = buildApp({ id: 'participant-1', role: 'participant' });

      const response = await request(listening(app))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: VALID_BRIEF });

      expect(response.status).toBe(403);
      expect(mockDraft).not.toHaveBeenCalled();
    });

    it('200s for a researcher_admin', async () => {
      const app = buildApp({ id: 'admin-1', role: 'researcher_admin' });

      const response = await request(listening(app))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: VALID_BRIEF });

      expect(response.status).toBe(200);
    });
  });

  describe('body validation', () => {
    const app = buildApp({ id: 'admin-1', role: 'researcher_admin' });

    it('400s on a brief under 20 characters', async () => {
      const response = await request(listening(app))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: 'too short' }); // 9 chars

      expect(response.status).toBe(400);
      expect(mockDraft).not.toHaveBeenCalled();
    });

    it('400s on a brief over 8000 characters', async () => {
      const response = await request(listening(app))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: 'a'.repeat(8001) });

      expect(response.status).toBe(400);
      expect(mockDraft).not.toHaveBeenCalled();
    });

    it('400s on an unknown hint value', async () => {
      const response = await request(listening(app))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: VALID_BRIEF, hints: { type: 'not-a-real-type' } });

      expect(response.status).toBe(400);
      expect(mockDraft).not.toHaveBeenCalled();
    });

    it('400s on an unrecognised body field', async () => {
      const response = await request(listening(app))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: VALID_BRIEF, publish: true });

      expect(response.status).toBe(400);
      expect(mockDraft).not.toHaveBeenCalled();
    });

    it('accepts a brief at exactly the 20 character floor', async () => {
      const response = await request(listening(app))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: 'x'.repeat(20) });

      expect(response.status).toBe(200);
    });
  });

  describe('dormancy', () => {
    it('503s with no error body other than drafting_unavailable when not configured', async () => {
      mockConfigured.mockReturnValue(false);
      const app = buildApp({ id: 'admin-1', role: 'researcher_admin' });

      const response = await request(listening(app))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: VALID_BRIEF });

      expect(response.status).toBe(503);
      expect(response.body.error).toBe('drafting_unavailable');
      expect(mockDraft).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('429s on the eleventh call in a minute for one admin', async () => {
      const app = buildApp({ id: 'admin-rate-limit', role: 'researcher_admin' });

      for (let i = 0; i < 10; i++) {
        const ok = await request(listening(app))
          .post('/api/opportunities/draft-from-brief')
          .send({ brief: VALID_BRIEF });
        expect(ok.status).toBe(200);
      }

      const eleventh = await request(listening(app))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: VALID_BRIEF });

      expect(eleventh.status).toBe(429);
    });

    it('does not share a bucket between two different admins', async () => {
      const appOne = buildApp({ id: 'admin-2', role: 'researcher_admin' });
      const appThree = buildApp({ id: 'admin-3', role: 'researcher_admin' });

      for (let i = 0; i < 10; i++) {
        await request(listening(appOne))
          .post('/api/opportunities/draft-from-brief')
          .send({ brief: VALID_BRIEF });
      }

      const response = await request(listening(appThree))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: VALID_BRIEF });

      expect(response.status).toBe(200);
    });
  });

  describe('no database write', () => {
    it('never touches the opportunities pool on a 200', async () => {
      const app = buildApp({ id: 'admin-1', role: 'researcher_admin' });

      const response = await request(listening(app))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: VALID_BRIEF });

      expect(response.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('never touches the pool even when the service rejects the draft', async () => {
      mockDraft.mockRejectedValue(new DraftRejectedError(['title: too short']));
      const app = buildApp({ id: 'admin-1', role: 'researcher_admin' });

      const response = await request(listening(app))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: VALID_BRIEF });

      expect(response.status).toBe(422);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('response shape', () => {
    it('passes the service result straight through', async () => {
      const app = buildApp({ id: 'admin-1', role: 'researcher_admin' });

      const response = await request(listening(app))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: VALID_BRIEF, hints: { type: 'poll' } });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(SAMPLE_RESULT);
      expect(mockDraft).toHaveBeenCalledWith({ brief: VALID_BRIEF, hints: { type: 'poll' } });
    });
  });

  describe('the no-leak error path (security pass)', () => {
    // Pins errorHandler's existing production behaviour against a raw throw
    // from the drafting service - e.g. the Anthropic client itself throwing
    // (a network fault, a malformed response, anything not already caught as
    // a DraftUnavailableError/DraftRejectedError). The generic-message branch
    // only fires under NODE_ENV=production; asserted explicitly rather than
    // assumed from the surrounding test run.
    const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    });

    it('a raw throw from the client answers 500 "Internal server error" with no key, brief or model text leaked', async () => {
      process.env.NODE_ENV = 'production';
      const leakyMessage =
        'Anthropic request failed: key sk-ant-api03-super-secret-value, ' +
        `model claude-opus-5, brief "${VALID_BRIEF}"`;
      mockDraft.mockRejectedValue(new Error(leakyMessage));
      const app = buildApp({ id: 'admin-1', role: 'researcher_admin' });

      const response = await request(listening(app))
        .post('/api/opportunities/draft-from-brief')
        .send({ brief: VALID_BRIEF });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Internal server error');
      const body = JSON.stringify(response.body);
      expect(body).not.toMatch(/sk-ant/i);
      expect(body).not.toMatch(/claude-opus-5/i);
      expect(body).not.toContain(VALID_BRIEF);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
