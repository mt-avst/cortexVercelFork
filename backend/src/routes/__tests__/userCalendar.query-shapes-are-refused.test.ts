import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

/**
 * routes/userCalendar.ts REFUSES A NON-STRING QUERY SHAPE ON BOTH ROUTES THAT
 * READ ONE. cto/AdaptaLabs#43 - which located this site in
 * services/userCalendar.ts; the services file has no query read, the router
 * does, at the OAuth callback (`code`, `state`) and my-events
 * (`start_time`, `end_time`).
 *
 * The callback is the one worth the test: an array `code` is truthy past
 * `if (!code)` and would land in the token exchange. `validateQuery` refuses a
 * non-string `code` (and `state`) shape before any of that runs. (The old
 * session-state comparison this comment used to cite was dead code, removed in
 * #83.)
 *
 * Refusal arms assert no database connection was ever taken - the callback
 * handler's FIRST line is `pool.connect()`, so mounting the validator after
 * the handler starts would show up here as a leaked connect.
 */

jest.mock('../../middleware/authenticate');

// `config.NODE_ENV` gates the development-only demo path in the callback
// (cto/AdaptaLabs#89), so the mock has to carry it.
const fakeConfig = { NODE_ENV: 'development' as string };

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
  get config() {
    return fakeConfig;
  },
}));

jest.mock('../../services/userCalendar', () => ({
  userCalendarService: {
    isInDemoMode: jest.fn(() => true),
    getTokens: jest.fn(async () => ({
      accessToken: 'at',
      refreshToken: null,
      expiryDate: new Date('2027-01-01T00:00:00Z'),
    })),
    encrypt: jest.fn((v: unknown) => `enc:${String(v)}`),
    decrypt: jest.fn((v: unknown) => String(v)),
    refreshAccessToken: jest.fn(),
    getUserCalendarEvents: jest.fn(async () => []),
  },
}));

import userCalendarRouter from '../userCalendar';
import { pool } from '../../config';
import { errorHandler } from '../../utils/errorHandler';

const mockConnect = pool.connect as unknown as jest.Mock;

const appWithSession = (id: string) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user: { id: string; name: string; email: string; role: string } } }).session = {
      user: { id, name: 'A', email: 'a@example.com', role: 'employee' },
    };
    next();
  });
  app.use('/api/calendar', userCalendarRouter);
  app.use(errorHandler);
  return app;
};

/** No session: pins that `requireAuth` runs before `validateQuery` on my-events. */
const anonymousApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/calendar', userCalendarRouter);
  app.use(errorHandler);
  return app;
};

const dbClient = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  dbClient.query.mockImplementation(async () => ({ rows: [] }));
  mockConnect.mockImplementation(async () => dbClient);
});

describe('requireAuth runs before the validator (mount order)', () => {
  it('refuses an anonymous hostile-shaped callback at the validator, taking no connection', async () => {
    // This route deliberately has NO `requireAuth` (cto/AdaptaLabs#89): it is
    // entered by a top-level navigation redirected from accounts.google.com,
    // and the app session cookie is SameSite=Strict in production, so it is
    // withheld across that redirect chain - `requireAuth` here would 401 the
    // researcher after they had already granted Google access. The single-use
    // browser-bound OAuth state is the authenticator instead, and it carries
    // the initiating user's id server-side.
    //
    // So the anonymous refusal now comes from the validator rather than from
    // auth, and what still matters is that it happens BEFORE the handler's
    // first line, which is `pool.connect()`.
    const res = await request(listening(anonymousApp())).get('/api/calendar/auth/callback?code[]=a&code[]=b');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid query parameters');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('still refuses an anonymous well-formed callback', async () => {
    // The control for the test above: dropping `requireAuth` must not have made
    // this route open.
    //
    // This suite runs the service mock in DEMO mode with
    // `fakeConfig.NODE_ENV = 'development'`, which is the one configuration that
    // skips the state check - and on that path the handler still requires a
    // session, so the refusal is a 401. The non-demo path refuses a missing
    // state with a 400 instead; that arm lives in
    // userCalendar.connect-flow.test.ts, which drives the callback through an
    // app with no session middleware at all.
    const res = await request(listening(anonymousApp())).get('/api/calendar/auth/callback?code=abc');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  it('answers 401, not the validator 400, for an anonymous hostile-shaped my-events', async () => {
    const res = await request(listening(anonymousApp())).get('/api/calendar/my-events?start_time[]=a&start_time[]=b');

    expect(res.status).toBe(401);
    expect(res.body.error).not.toBe('Invalid query parameters');
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

describe('GET /api/calendar/auth/callback query shapes', () => {
  it.each([
    ['a repeated code', '?code=a&code=b'],
    ['a nested-object code', '?code[foo]=bar'],
    ['a repeated state beside a good code', '?code=ok&state=a&state=b'],
    ['a bracket-notation state beside a good code', '?code=ok&state[]=a&state[]=b'],
  ])('refuses %s without taking a database connection', async (_name, shape) => {
    const res = await request(listening(appWithSession('user-1')))
      .get(`/api/calendar/auth/callback${shape}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid query parameters');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('still completes the callback for a single well-formed code', async () => {
    // Demo mode under NODE_ENV=development, which is the one configuration that
    // skips the state check (the service mock above returns `isInDemoMode: true`
    // and `fakeConfig.NODE_ENV` is 'development'). The state-bound path is
    // covered end to end in userCalendar.connect-flow.test.ts.
    const res = await request(listening(appWithSession('user-1')))
      .get('/api/calendar/auth/callback?code=abc&state=xyz');

    // The handler ran end to end: stored tokens, then redirected.
    expect(res.status).toBe(302);
    expect(dbClient.query).toHaveBeenCalled();
    expect(dbClient.release).toHaveBeenCalled();
  });
});

describe('GET /api/calendar/my-events query shapes', () => {
  it.each([
    ['a repeated start_time', '?start_time=a&start_time=b&end_time=2026-01-02T00:00:00Z'],
    ['a nested-object start_time', '?start_time[foo]=bar&end_time=2026-01-02T00:00:00Z'],
    ['a bracket-notation end_time', '?start_time=2026-01-01T00:00:00Z&end_time[]=a&end_time[]=b'],
  ])('refuses %s without taking a database connection', async (_name, shape) => {
    const res = await request(listening(appWithSession('user-1')))
      .get(`/api/calendar/my-events${shape}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid query parameters');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('carries a single well-formed window through to the token lookup', async () => {
    const res = await request(listening(appWithSession('user-1')))
      .get('/api/calendar/my-events?start_time=2026-01-01T00:00:00Z&end_time=2026-01-02T00:00:00Z');

    // Empty token rows from the mock: the handler got past validation and
    // answered its own not-connected 404.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Calendar not connected');
  });
});
