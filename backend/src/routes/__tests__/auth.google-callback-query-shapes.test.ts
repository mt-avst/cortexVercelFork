import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';
import session from 'express-session';

/**
 * GET /auth/google-callback REFUSES A NON-STRING code/state.
 * cto/AdaptaLabs#43, and this is the UNAUTHENTICATED site.
 *
 * The route destructured `code` and `state` straight off `req.query`, so an
 * array-valued `code` sailed past `if (!code)` (an array is truthy) into the
 * token-exchange machinery - the same "unauthenticated caller can pick their
 * status code" shape !253 measured on `GET /:id/sessions`.
 *
 * `validateQuery` now runs first. The well-formed arms prove the validator
 * passes a normal query through: an absent code still gets the route's own
 * 400, and a single string code reaches the handler proper (which in a
 * credential-less test environment is the demo-mode-outside-development 500 -
 * a deliberately distinct status from the validator's 400).
 */

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('openid-client', () => ({
  Issuer: { discover: jest.fn() },
}));

describe('GET /auth/google-callback query shapes', () => {
  let app: express.Application;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    jest.resetModules();

    const authRouter = require('../auth').default;

    app = express();
    app.use(express.json());
    app.use(session({
      secret: 'test-secret-long-enough-to-be-accepted-by-the-app',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false },
    }));
    app.use('/auth', authRouter);
  });

  it.each([
    ['a repeated code', '?code=a&code=b'],
    ['a repeated empty code', '?code=&code='],
    ['a bracket-notation code', '?code[]=a&code[]=b'],
    ['a nested-object code', '?code[foo]=bar'],
    ['a repeated state beside a good code', '?code=ok&state=a&state=b'],
    ['a nested-object state beside a good code', '?code=ok&state[foo]=bar'],
  ])('refuses %s with the validator 400', async (_name, shape) => {
    const res = await request(listening(app)).get(`/auth/google-callback${shape}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid query parameters');
  });

  it('still answers the route-owned 400 when code is absent', async () => {
    const res = await request(listening(app)).get('/auth/google-callback');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Authorization code missing');
  });

  it('carries a single well-formed code through to the handler', async () => {
    // No Google credentials in the test environment, so the handler treats
    // every code as a demo login and, outside development mode, refuses with
    // ITS OWN 500 - which is the proof the request got past the validator.
    const res = await request(listening(app)).get('/auth/google-callback?code=demo-code');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Authentication service unavailable');
  });
});
