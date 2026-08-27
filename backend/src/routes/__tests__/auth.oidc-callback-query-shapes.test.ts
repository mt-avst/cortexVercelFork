import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';
import session from 'express-session';

/**
 * GET /auth/callback (OIDC) REFUSES A NON-STRING code/state. cto/AdaptaLabs#84.
 *
 * This route reads its query through `oidcClient.callbackParams(req)`, which
 * parses `req.url` with querystring and yields ARRAYS for repeated parameters -
 * invisible to #43's `req.query`-read structural scan, which only sees direct
 * `req.query` reads in routes/*.ts. So a repeated `code` reached the token
 * exchange as `['a','b']` after !287, with nothing flagging it.
 *
 * `validateQuery` now runs as middleware BEFORE the handler, so a malformed
 * SHAPE is refused with a 400 before `callbackParams` (and the token exchange)
 * ever runs. It does not narrow what `callbackParams` reads - that is `req.url` -
 * it refuses the request outright, exactly as the sibling `google-callback` does.
 *
 * The well-formed arm proves the validator passes a normal query through: with
 * no OIDC provider configured in the test environment, a single string code
 * reaches the handler and gets its own 500 (a deliberately distinct status from
 * the validator's 400).
 */

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('openid-client', () => ({
  Issuer: { discover: jest.fn() },
}));

describe('GET /auth/callback (OIDC) query shapes', () => {
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
    const res = await request(listening(app)).get(`/auth/callback${shape}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid query parameters');
  });

  it('carries a single well-formed code through to the handler', async () => {
    // No OIDC provider is configured in the test environment, so the handler
    // reaches its own 500 - which is the proof the request got past the
    // validator (a distinct status from the validator's 400).
    const res = await request(listening(app)).get('/auth/callback?code=abc&state=xyz');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Authentication service unavailable');
  });
});
