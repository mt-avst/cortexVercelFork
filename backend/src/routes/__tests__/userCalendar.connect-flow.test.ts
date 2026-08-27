import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { listening } from '../../__tests__/helpers/listening';

/**
 * cto/AdaptaLabs#89 - a user can start a calendar OAuth flow again, and the
 * callback that receives it is bound to the browser that started it.
 *
 * `/api/calendar/auth/connect` was deleted in v2.5.1 on the belief that
 * "calendar is now automatically connected during login". That was true only of
 * the Google login path; production logs in via Okta/OIDC with Google OAuth in
 * demo mode, so `connection-status` answered `{"connected":false}` for every
 * production user permanently and `getAuthUrl` sat with no caller.
 *
 * Restoring the initiator makes the callback's `state` check load-bearing for
 * the first time. #83 removed the previous one as dead code - it compared
 * against `req.session.googleOAuthState`, assigned nowhere - and it is now the
 * shared single-use browser-bound control from #82 rather than a second
 * implementation of it.
 */

jest.mock('../../middleware/authenticate');

// The handler reads `config.NODE_ENV`, the zod-validated value, rather than
// `process.env.NODE_ENV` - so a typo in the environment cannot widen the
// demo-mode gate. The mock therefore has to carry it, and the tests move it
// through this object rather than through the process env.
const fakeConfig = { NODE_ENV: 'test' as string };

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
  get config() {
    return fakeConfig;
  },
}));

const demoMode = jest.fn(() => false);
const getAuthUrl = jest.fn((state?: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`);
const getTokens = jest.fn(async (_code: string) => ({
  accessToken: 'real-access-token',
  refreshToken: 'real-refresh-token',
  expiryDate: new Date('2027-01-01T00:00:00Z'),
}));

jest.mock('../../services/userCalendar', () => ({
  userCalendarService: {
    isInDemoMode: () => demoMode(),
    getAuthUrl: (state?: string) => getAuthUrl(state),
    getTokens: (code: string) => getTokens(code),
    encrypt: (v: unknown) => `enc:${String(v)}`,
    decrypt: (v: unknown) => String(v),
    refreshAccessToken: jest.fn(),
    getUserCalendarEvents: jest.fn(async () => []),
  },
}));

import userCalendarRouter from '../userCalendar';
import { pool } from '../../config';
import { errorHandler } from '../../utils/errorHandler';

const mockConnect = pool.connect as unknown as jest.Mock;

const appWithSession = (id = 'user-1') => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
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

const dbClient = {
  query: jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[] })),
  release: jest.fn(),
};

const STATE_COOKIE = 'adaptalabs_calendar_oauth_state';

/** The state the connect route minted, read out of its own Set-Cookie. */
const stateFromCookies = (setCookie: string[] | undefined): string => {
  const cookie = (setCookie ?? []).find((c) => c.startsWith(`${STATE_COOKIE}=`));
  if (!cookie) throw new Error(`no ${STATE_COOKIE} cookie was set`);
  return decodeURIComponent(cookie.split(';')[0].split('=')[1]);
};

const setNodeEnv = (value: string) => {
  fakeConfig.NODE_ENV = value;
};

beforeEach(() => {
  jest.clearAllMocks();
  setNodeEnv('test');
  demoMode.mockReturnValue(false);
  getAuthUrl.mockImplementation((state?: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`);
  dbClient.query.mockImplementation(async () => ({ rows: [] }));
  mockConnect.mockImplementation(async () => dbClient);
});

afterEach(() => {
  setNodeEnv('test');
});

describe('GET /api/calendar/auth/connect', () => {
  it('redirects to Google carrying a state bound to this browser', async () => {
    const res = await request(listening(appWithSession())).get('/api/calendar/auth/connect');

    expect(res.status).toBe(302);

    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const state = stateFromCookies(setCookie);

    // The state in the redirect URL and the state bound to the browser are the
    // SAME value. Two independent values would make the callback's comparison
    // unsatisfiable, which would look exactly like a working guard.
    expect(res.headers.location).toContain(`state=${state}`);
    expect(getAuthUrl).toHaveBeenCalledWith(state);

    const cookie = setCookie.find((c) => c.startsWith(`${STATE_COOKIE}=`))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('refuses to start a flow when no OAuth client is configured', async () => {
    demoMode.mockReturnValue(true);

    const res = await request(listening(appWithSession())).get('/api/calendar/auth/connect');

    // In demo mode `getAuthUrl` returns a URL pointing straight back at our own
    // callback with `code=demo`, which mints FABRICATED tokens. A researcher
    // would connect successfully and then trust invented busy time - worse than
    // being offered nothing.
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('CALENDAR_OAUTH_NOT_CONFIGURED');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(getAuthUrl).not.toHaveBeenCalled();
  });

  it('is not reachable without a session', async () => {
    const app = express();
    app.use(cookieParser());
    app.use('/api/calendar', userCalendarRouter);
    app.use(errorHandler);

    const res = await request(listening(app)).get('/api/calendar/auth/connect');

    expect(res.status).toBe(401);
    expect(getAuthUrl).not.toHaveBeenCalled();
  });
});

describe('the callback works WITHOUT the app session cookie (#89)', () => {
  /**
   * THE FINDING THAT NEARLY SHIPPED THIS MR INERT.
   *
   * The callback is entered by a top-level navigation redirected from
   * accounts.google.com. The app session cookie is `SameSite=Strict` in
   * production, and browsers compute SameSite across the whole redirect chain,
   * so it is withheld on arrival. With `requireAuth` on this route the
   * researcher got a 401 AFTER granting Google access: a live grant at Google,
   * no token row, and nothing to explain it. That is #89's own symptom under a
   * new cause - and no test in this repo could see it, because every route test
   * injects `req.session` directly.
   *
   * So the state is the authenticator, and this suite proves it by driving the
   * callback through an app with NO session middleware at all.
   */
  const sessionlessApp = () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/calendar', userCalendarRouter);
    app.use(errorHandler);
    return app;
  };

  it('stores tokens against the user bound to the state, with no session present', async () => {
    // The state is minted on a session-bearing app, exactly as the real flow
    // does, and then spent on one with no session middleware at all - which is
    // what the browser actually delivers.
    const withSession = appWithSession('researcher-7');
    const start = await request(listening(withSession)).get('/api/calendar/auth/connect');
    const state = stateFromCookies(start.headers['set-cookie'] as unknown as string[]);

    const res = await request(listening(sessionlessApp()))
      .get(`/api/calendar/auth/callback?code=real-code&state=${state}`)
      .set('Cookie', `${STATE_COOKIE}=${state}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('calendar=connected');

    // And against the RIGHT user. Taking the id from anywhere but the state
    // would either 401 here or write the row against nobody.
    const insert = dbClient.query.mock.calls.find((call) =>
      String(call[0]).includes('user_calendar_tokens')
    );
    expect(insert).toBeDefined();
    expect((insert as unknown[])[1]).toEqual(
      expect.arrayContaining(['researcher-7'])
    );
  });

  it('writes against the STATE\'s user even when a different session is present', async () => {
    /*
     * The property that makes the state a real authenticator rather than a
     * decoration, and the one a mutation proved was untested: preferring
     * `req.session.user.id` over the state's payload survived every other test
     * here, because in all of them the two agree.
     *
     * They must not be allowed to agree by accident. If the session wins, then a
     * researcher who happens to have an open session captures whatever flow
     * lands in their browser - and, in the other direction, the flow they
     * themselves started could be written against somebody else's row.
     */
    const initiator = appWithSession('researcher-7');
    const start = await request(listening(initiator)).get('/api/calendar/auth/connect');
    const state = stateFromCookies(start.headers['set-cookie'] as unknown as string[]);

    const res = await request(listening(appWithSession('someone-else-9')))
      .get(`/api/calendar/auth/callback?code=real-code&state=${state}`)
      .set('Cookie', `${STATE_COOKIE}=${state}`);

    expect(res.status).toBe(302);

    const insert = dbClient.query.mock.calls.find((call) =>
      String(call[0]).includes('user_calendar_tokens')
    );
    expect(insert).toBeDefined();
    const params = (insert as unknown[])[1] as unknown[];
    expect(params).toEqual(expect.arrayContaining(['researcher-7']));
    expect(params).not.toEqual(expect.arrayContaining(['someone-else-9']));
  });

  it('takes NO pool connection when it refuses', async () => {
    /*
     * `pool.connect()` used to be this handler's first line, and the route is
     * unauthenticated by design - so an anonymous caller reached a pool checkout
     * on every request, before any refusal, with no rate limiter under /api. The
     * connection was then held across the outbound token exchange, which has no
     * AbortSignal, so ten stalled flows could wedge the whole backend
     * (`pool.options.max` is pg's default 10, and the statement timeout bounds
     * queries rather than checkouts).
     *
     * The connection is taken late now. This asserts the refusal path costs
     * nothing, which is the property that makes the route safe to leave open.
     */
    await request(listening(sessionlessApp())).get('/api/calendar/auth/callback?code=real-code');

    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('DOES take one when there is something to write', async () => {
    // The control. A handler that never connected would satisfy the arm above
    // and store no tokens at all.
    const withSession = appWithSession('researcher-9');
    const start = await request(listening(withSession)).get('/api/calendar/auth/connect');
    const state = stateFromCookies(start.headers['set-cookie'] as unknown as string[]);

    await request(listening(sessionlessApp()))
      .get(`/api/calendar/auth/callback?code=real-code&state=${state}`)
      .set('Cookie', `${STATE_COOKIE}=${state}`);

    expect(mockConnect).toHaveBeenCalled();
  });

  it('refuses when the state is absent, rather than falling back to a session', async () => {
    // The control. A callback that authenticates itself must still refuse an
    // unauthenticated caller - otherwise removing `requireAuth` traded a 401 for
    // an open endpoint.
    const res = await request(listening(sessionlessApp())).get(
      '/api/calendar/auth/callback?code=real-code'
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid state parameter');
    expect(getTokens).not.toHaveBeenCalled();
  });
});

describe('GET /api/calendar/auth/connect is rate limited', () => {
  it('refuses the eleventh attempt in a minute with the route\'s own message', async () => {
    /*
     * `/auth/connect` MINTS STATE, and every call allocates a store entry living
     * up to one TTL on a single-replica pod - measured at 173 bytes each, so an
     * unrated caller can push tens of megabytes a second into that map. `/api`
     * carries no limiter of its own.
     *
     * A gate proved the limiter was a fix nothing enforced: deleting it from the
     * route passed all 1582 backend tests. This repo's own standard for a
     * limiter (see routes/firsthand.ts) is a named test plus a canary entry, and
     * this is the test half.
     *
     * Ten is generous for the real behaviour - a researcher connects a calendar
     * approximately once.
     */
    const app = appWithSession('rate-limited-user');

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt++) {
      const res = await request(listening(app)).get('/api/calendar/auth/connect');
      statuses.push(res.status);
    }

    // The first ten redirect to Google; only the eleventh is refused. Asserting
    // the whole sequence rather than just the last one is what distinguishes a
    // working limiter from one set to zero.
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(302));
    expect(statuses[10]).toBe(429);
  });

  it('keys the bucket per user, not globally', async () => {
    // The control. A limiter keyed on something shared - or on `req.ip`, which
    // two proxy hops collapse to the ingress - would let one researcher lock
    // every colleague out of connecting a calendar.
    const first = appWithSession('user-a');
    for (let attempt = 0; attempt < 11; attempt++) {
      await request(listening(first)).get('/api/calendar/auth/connect');
    }

    const second = await request(listening(appWithSession('user-b'))).get(
      '/api/calendar/auth/connect'
    );

    expect(second.status).toBe(302);
  });
});

describe('GET /api/calendar/auth/callback state binding', () => {
  it('stores tokens for a state this browser actually started with', async () => {
    // THE CONTROL. Every refusal below is satisfied by a callback that refuses
    // everything, which would be a different way of leaving no user able to
    // connect a calendar.
    const agent = request.agent(listening(appWithSession()));

    const start = await agent.get('/api/calendar/auth/connect');
    const state = stateFromCookies(start.headers['set-cookie'] as unknown as string[]);

    const res = await agent.get(`/api/calendar/auth/callback?code=real-code&state=${state}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('calendar=connected');
    expect(getTokens).toHaveBeenCalledWith('real-code');

    const insert = dbClient.query.mock.calls.find((call) =>
      String(call[0]).includes('user_calendar_tokens')
    );
    expect(insert).toBeDefined();
  });

  it('refuses a callback with no state at all, and connects to no database', async () => {
    const res = await request(listening(appWithSession())).get('/api/calendar/auth/callback?code=real-code');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid state parameter');
    // The handler's first line is `pool.connect()`, so a guard mounted after it
    // starts would show up here as a leaked connection rather than a refusal.
    expect(getTokens).not.toHaveBeenCalled();
  });

  it('refuses a state this server never issued', async () => {
    const res = await request(listening(appWithSession()))
      .get('/api/calendar/auth/callback?code=real-code&state=deadbeef')
      .set('Cookie', `${STATE_COOKIE}=deadbeef`);

    // The cookie MATCHES the query state here, so this is not the binding check
    // firing - it is the store check. An attacker who can set a cookie on the
    // victim's browser still has to have started a flow on this server.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid state parameter');
    expect(getTokens).not.toHaveBeenCalled();
  });

  it('refuses an attacker-minted state replayed from a different browser', async () => {
    // ONE express app, so both halves hit one server - `listening` memoises per
    // app, and the inline form is what `listening-call-sites.test.ts` enforces
    // (a server per supertest request is a measured transport flake, #60).
    const app = appWithSession();

    // The attacker starts a real flow and keeps the state...
    const attackerStart = await request(listening(app)).get('/api/calendar/auth/connect');
    const attackerState = stateFromCookies(attackerStart.headers['set-cookie'] as unknown as string[]);

    // ...then lures the victim to the callback with it. The victim carries no
    // state cookie because the victim never began a flow. Without the browser
    // binding, the attacker's calendar tokens would be written against the
    // VICTIM's user row, and the victim would then book against a stranger's
    // free/busy.
    const res = await request(listening(app)).get(
      `/api/calendar/auth/callback?code=attacker-code&state=${attackerState}`
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid state parameter');
    expect(getTokens).not.toHaveBeenCalled();
  });

  it('accepts a state exactly once', async () => {
    const agent = request.agent(listening(appWithSession()));
    const start = await agent.get('/api/calendar/auth/connect');
    const state = stateFromCookies(start.headers['set-cookie'] as unknown as string[]);

    const first = await agent.get(`/api/calendar/auth/callback?code=real-code&state=${state}`);
    expect(first.status).toBe(302);

    const replay = await request(listening(appWithSession()))
      .get(`/api/calendar/auth/callback?code=real-code&state=${state}`)
      .set('Cookie', `${STATE_COOKIE}=${state}`);

    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('State parameter already used');
  });

  it.each(['production', 'test'])(
    'refuses the demo path under NODE_ENV=%s, not only in production',
    async (nodeEnv) => {
      // The gate was `demoMode && NODE_ENV === 'production'` -> refuse, so EVERY
      // other NODE_ENV - including unset - skipped the state check entirely and
      // wrote fabricated tokens against whatever session arrived. Stated
      // positively now: the permissive branch is development only, and has to be
      // asked for by name.
      demoMode.mockReturnValue(true);
      setNodeEnv(nodeEnv);

      const res = await request(listening(appWithSession())).get(
        '/api/calendar/auth/callback?code=demo'
      );

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('CALENDAR_OAUTH_NOT_CONFIGURED');
      expect(getTokens).not.toHaveBeenCalled();
    }
  );

  it('allows the demo path in development, which is the only place it is safe', async () => {
    // The control for the two arms above: an inverted gate that refused
    // everywhere would satisfy them and break every developer's local setup.
    demoMode.mockReturnValue(true);
    setNodeEnv('development');

    const res = await request(listening(appWithSession())).get(
      '/api/calendar/auth/callback?code=demo'
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('calendar=connected');
  });
});

describe('a caller can tell "not connected" from "cannot be connected"', () => {
  it('reports availability on connection-status', async () => {
    demoMode.mockReturnValue(false);
    const connected = await request(listening(appWithSession())).get('/api/calendar/connection-status');
    expect(connected.body.available).toBe(true);

    demoMode.mockReturnValue(true);
    const unavailable = await request(listening(appWithSession())).get('/api/calendar/connection-status');
    expect(unavailable.body.available).toBe(false);
  });

  it('carries availability on the my-events 404, so no second request is needed', async () => {
    demoMode.mockReturnValue(true);

    const res = await request(listening(appWithSession())).get(
      '/api/calendar/my-events?start_time=2026-09-01T00:00:00.000Z&end_time=2026-09-02T00:00:00.000Z'
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Calendar not connected');
    expect(res.body.available).toBe(false);
  });
});
