import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';

/**
 * GET /auth/google-callback VALIDATES THE OAuth STATE. cto/AdaptaLabs#82.
 *
 * The route destructured `code` and `state` and then never referenced `state`
 * again, so it performed NO CSRF/state validation. The route is unauthenticated
 * and ends in `req.session.regenerate()` + `req.session.user = ...` +
 * `Set-Cookie`, so a forged top-level GET to
 * `/auth/google-callback?code=<attacker code>` logged the victim's browser into
 * the ATTACKER's Google identity - classic login CSRF / session fixation.
 *
 * These tests drive the PRODUCTION path (GOOGLE_OAUTH_* set, so
 * isGoogleOAuthDemoMode() is false), with `fetch` mocked to return an
 * attacker-controlled identity - the same shape the #43 security gate used to
 * demonstrate the exploit end to end. The sibling OIDC `/callback` already
 * validates state (auth.test.ts) and this suite brings the Google callback to
 * the same bar.
 */

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('openid-client', () => ({
  Issuer: { discover: jest.fn() },
}));

// The callback encrypts and stores calendar tokens; stub the service so the
// test needs no ENCRYPTION_KEY and exercises the session/redirect path.
jest.mock('../../services/userCalendar', () => ({
  userCalendarService: {
    encrypt: jest.fn((value: string) => `enc:${value}`),
    getTokens: jest.fn(),
  },
}));

const ATTACKER_EMAIL = 'attacker@evil.example';

/**
 * A db client whose every query resolves to a single row carrying an id and a
 * role - enough for the SELECT-then-UPDATE existing-user branch and every
 * INSERT ... RETURNING id in the handler.
 */
function mockDbClient() {
  return {
    query: jest
      .fn<() => Promise<{ rows: Array<{ id: string; role: string }> }>>()
      .mockResolvedValue({ rows: [{ id: 'attacker-user-id', role: 'employee' }] }),
    release: jest.fn(),
  };
}

type FetchResponseLike = { ok: boolean; json: () => Promise<Record<string, unknown>> };

/**
 * fetch mock for the production Google exchange: the token endpoint first, then
 * userinfo returning the ATTACKER's identity.
 */
function installAttackerFetch() {
  const fetchMock = jest
    .fn<() => Promise<FetchResponseLike>>()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'attacker-access', refresh_token: 'attacker-refresh', expires_in: 3600 }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'attacker-google-id', email: ATTACKER_EMAIL, name: 'Attacker' }),
    });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('GET /auth/google-callback state validation (login CSRF, #82)', () => {
  let app: express.Application;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    process.env.NODE_ENV = 'test';
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-google-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-google-client-secret';
    process.env.CORS_ORIGIN = 'http://localhost:3000';
    jest.resetModules();

    const { pool } = require('../../config');
    pool.connect.mockResolvedValue(mockDbClient());

    const authRouter = require('../auth').default;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(session({
      secret: 'test-secret-long-enough-to-be-accepted-by-the-app',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false },
    }));
    app.use('/auth', authRouter);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  });

  it('refuses a forged callback with NO state and creates no session', async () => {
    installAttackerFetch();

    const res = await request(listening(app)).get('/auth/google-callback?code=attacker-code');

    expect(res.status).toBe(400);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a callback whose state was never issued by this server', async () => {
    installAttackerFetch();

    const res = await request(listening(app)).get(
      '/auth/google-callback?code=attacker-code&state=never-issued-by-us'
    );

    expect(res.status).toBe(400);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses an attacker-minted state replayed from a different browser', async () => {
    // The attacker begins their OWN Google login and captures a valid, unused
    // state plus the cookie it set - on THEIR browser.
    const attacker = request.agent(listening(app));
    const login = await attacker.get('/auth/google-login').expect(302);
    const state = new URL(login.headers.location).searchParams.get('state');
    expect(state).toBeTruthy();

    // The victim's browser (no adaptalabs_oauth_state cookie) is lured to the
    // callback with the attacker's state and code. Before the fix this logged
    // the victim in as the attacker; the browser binding now refuses it.
    installAttackerFetch();
    const victim = await request(listening(app)).get(
      `/auth/google-callback?code=attacker-code&state=${state}`
    );

    expect(victim.status).toBe(400);
    expect(victim.headers['set-cookie']).toBeUndefined();
  });

  it('accepts a state minted by google-login exactly once then refuses a replay', async () => {
    // A real browser keeps the state cookie /google-login set, so the SAME agent
    // must drive the callback - a plain client would drop the cookie and be
    // refused (which is exactly the login-CSRF the binding closes).
    const agent = request.agent(listening(app));
    const login = await agent.get('/auth/google-login').expect(302);
    const state = new URL(login.headers.location).searchParams.get('state');
    expect(state).toBeTruthy();

    installAttackerFetch();
    const ok = await agent.get(`/auth/google-callback?code=real-code&state=${state}`);
    expect(ok.status).toBe(302);
    expect(ok.headers['set-cookie']).toBeDefined();

    // Replaying the same state is refused - it is consumed and its cookie cleared.
    installAttackerFetch();
    const replay = await agent.get(`/auth/google-callback?code=real-code&state=${state}`);
    expect(replay.status).toBe(400);
    expect(replay.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a consumed state even when the browser re-sends the state cookie', async () => {
    // Isolates the single-use flag from the cookie-clearing: capture the state
    // cookie, consume the state once, then replay WITH the original cookie
    // re-attached. Binding passes, so only the `used` flag can refuse it.
    const agent = request.agent(listening(app));
    const login = await agent.get('/auth/google-login').expect(302);
    const state = new URL(login.headers.location).searchParams.get('state')!;
    const setCookies = login.headers['set-cookie'] as unknown as string[];
    const stateCookie = setCookies
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('adaptalabs_oauth_state='))!;
    expect(stateCookie).toBeTruthy();

    installAttackerFetch();
    const ok = await agent.get(`/auth/google-callback?code=real-code&state=${state}`);
    expect(ok.status).toBe(302);

    installAttackerFetch();
    const replay = await request(listening(app))
      .get(`/auth/google-callback?code=real-code&state=${state}`)
      .set('Cookie', stateCookie);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('State parameter already used');
  });
});
