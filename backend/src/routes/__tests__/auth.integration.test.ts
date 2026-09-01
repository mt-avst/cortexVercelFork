import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { generateMockUser, createMockQueryResult } from '../../../../shared/test-utils';

// Mock the database pool
jest.mock('../../config', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn(),
  },
}));

// Mock openid-client
jest.mock('openid-client', () => ({
  Issuer: {
    discover: jest.fn(),
  },
}));

// The nonce the state guard mints, pinned so /auth/login's redirect carries a
// known literal. 32 bytes, because that is what the guard asks for.
const MOCK_NONCE_BYTE = 7;
const MOCK_STATE = '07'.repeat(32);

// Mock crypto.randomBytes only — preserve the rest of the real module (createHash etc.),
// which express-session needs internally to hash/compare session state on every request.
//
// IT RETURNS A REAL BUFFER, and that is not a detail. This mock used to answer
// every call with `{ toString: () => 'mock-state' }`, which is not a Buffer and
// cannot be used as one: once the state guard began sealing its cookie
// (cto/AdaptaLabs#92) the 12-byte AES IV came back as that object and
// `createCipheriv` threw, so /auth/login answered 500. A fixture that returns
// something the real API cannot return is a fixture that will eventually lie
// about the code under it - so the size is honoured, and only the 32-byte call
// (the guard's nonce) is made deterministic.
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto') as typeof import('crypto');
  return {
    ...actual,
    randomBytes: jest.fn((size: number) =>
      size === 32 ? Buffer.alloc(32, MOCK_NONCE_BYTE) : actual.randomBytes(size)
    ),
  };
});

// Builds a mock OIDC client. callbackParams reflects the *actual* request query
// (mirroring real openid-client behavior) rather than a hardcoded value, so tests
// exercising missing/invalid state are actually falsifiable.
function createMockClient(overrides: Record<string, any> = {}) {
  return {
    authorizationUrl: jest.fn((params: any) => `https://oidc-provider.com/auth?state=${params.state}`),
    callbackParams: jest.fn((req: any) => ({
      code: req.query?.code,
      state: req.query?.state,
    })),
    callback: jest.fn().mockResolvedValue({ access_token: 'access-token', id_token: 'id-token' }),
    userinfo: jest.fn().mockResolvedValue({
      name: 'Test User',
      email: 'test@example.com',
      department: 'Engineering',
      job_title: 'Developer',
    }),
    ...overrides,
  };
}

// Configures Issuer.discover to resolve a client built from createMockClient(overrides).
// Must be called *before* the first request in a test — the resulting client is cached
// at module scope (mirrors production: the OIDC client is discovered once and reused).
function mockOidc(overrides: Record<string, any> = {}) {
  const mockClient = createMockClient(overrides);
  require('openid-client').Issuer.discover.mockResolvedValue({
    Client: jest.fn().mockReturnValue(mockClient),
  });
  return mockClient;
}

// The login flow's state cookie name, carrying the `__Host-` prefix (#94).
// Written as a literal here, and again in the sibling suites, deliberately: an
// expectation derived from the module under test would follow that module if
// the prefix were ever dropped, and the prefix is the control.
const LOGIN_STATE_COOKIE = '__Host-adaptalabs_oauth_state';

const stateCookieFrom = (setCookie: string[] | undefined): string => {
  const cookie = (setCookie ?? [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith(`${LOGIN_STATE_COOKIE}=`));
  if (!cookie) throw new Error(`no ${LOGIN_STATE_COOKIE} cookie was set`);
  return cookie;
};

// Drives the real /auth/login flow, then hands back the state AND the
// browser-bound state cookie so the caller can re-present it on the callback,
// exactly as a browser does (cto/AdaptaLabs#82).
//
// The cookie is returned rather than left to a `request.agent` jar because
// since #94 it is `Secure` unconditionally, and supertest's jar silently drops
// a Secure cookie over http - measured, against an insecure control that
// round-trips. A real browser DOES send it (localhost is a trustworthy origin)
// and production is https, so this is the harness being stricter than the
// world, not a behaviour change. A caller that omits the cookie is refused,
// which is the login-CSRF the binding closes and is asserted below.
async function beginLogin(
  app: express.Application
): Promise<{ state: string; stateCookie: string }> {
  const res = await request(listening(app)).get('/auth/login').expect(302);
  const url = new URL(res.headers.location);
  return {
    state: url.searchParams.get('state')!,
    stateCookie: stateCookieFrom(res.headers['set-cookie'] as unknown as string[]),
  };
}

describe('Auth Routes Integration Tests', () => {
  let app: express.Application;
  let mockPool: any;

  beforeEach(() => {
    // auth.ts kicks off OIDC client discovery once at module-load time and caches
    // the result, so the module must be re-required fresh each test rather than
    // reused from a shared, already-initialized instance.
    jest.resetModules();
    mockPool = require('../../config').pool;

    // Create a fresh app instance for each test
    app = express();
    app.use(cookieParser());
    app.use(session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false },
    }));

    // Import and use auth routes
    const authRoutes = require('../auth').default;
    app.use('/auth', authRoutes);
  });

  describe('GET /auth/login', () => {
    it('should redirect to OIDC provider', async () => {
      mockOidc();

      const response = await request(listening(app))
        .get('/auth/login')
        .expect(302);

      expect(response.headers.location).toContain('https://oidc-provider.com/auth');
      expect(response.headers.location).toContain(`state=${MOCK_STATE}`);
    });

    it('should handle OIDC client initialization error', async () => {
      require('openid-client').Issuer.discover.mockRejectedValue(new Error('Discovery failed'));

      await request(listening(app))
        .get('/auth/login')
        .expect(500);
    });
  });

  describe('GET /auth/callback', () => {
    // The callback route upserts the user via pool.connect() -> dbClient.query(...),
    // not pool.query() directly, so tests must configure the *connected client's*
    // query mock, not the pool-level one.
    let mockClientQuery: jest.Mock;

    beforeEach(() => {
      mockOidc();
      mockClientQuery = jest.fn();
      mockPool.connect.mockResolvedValue({
        query: mockClientQuery,
        release: jest.fn(),
      });
    });

    it('should handle successful OIDC callback', async () => {
      const mockUser = generateMockUser();
      const { state, stateCookie } = await beginLogin(app);

      // Mock user upsert query
      mockClientQuery.mockResolvedValueOnce(createMockQueryResult([mockUser]));
      // Mock notification preferences creation
      mockClientQuery.mockResolvedValueOnce(createMockQueryResult([]));

      const response = await request(listening(app))
        .get('/auth/callback')
        .query({ code: 'auth-code', state })
        .set('Cookie', stateCookie)
        .expect(302);

      expect(response.headers.location).toBe('http://localhost:3000');
      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        expect.arrayContaining(['Test User', 'test@example.com', 'Engineering', 'Developer'])
      );
    });

    it('should handle missing state parameter', async () => {
      const response = await request(listening(app))
        .get('/auth/callback')
        .query({ code: 'auth-code' })
        .expect(400);

      expect(response.body.error).toBe('Invalid state parameter');
    });

    it('should handle invalid state parameter', async () => {
      // A state that was never issued via /login is rejected regardless of code.
      const response = await request(listening(app))
        .get('/auth/callback')
        .query({ code: 'auth-code', state: 'never-issued-state' })
        .expect(400);

      expect(response.body.error).toBe('Invalid state parameter');
    });

    it('should handle OIDC callback error', async () => {
      mockOidc({
        callback: jest.fn().mockRejectedValue(new Error('OIDC callback failed')),
      });
      const { state, stateCookie } = await beginLogin(app);

      await request(listening(app))
        .get('/auth/callback')
        .query({ code: 'auth-code', state })
        .set('Cookie', stateCookie)
        .expect(500);
    });
  });

  describe('POST /auth/logout', () => {
    it('should destroy the session and return success', async () => {
      const response = await request(listening(app))
        .post('/auth/logout')
        .expect(200);

      expect(response.body).toEqual({ success: true });
    });
  });

  // GET /auth/me was removed from this router — current-user lookup now lives at
  // GET /api/me (see src/routes/api.ts), which the frontend already calls. That
  // route has no dedicated test coverage yet; that's a separate gap, not something
  // to fake here against a route that no longer exists.

  describe('Demo Routes (Development Only)', () => {
    // These routes are only registered on the router when NODE_ENV === 'development'
    // *at module-load time* (see auth.ts's top-level `if` block), so the module must
    // be re-required with NODE_ENV already set — the outer beforeEach's require runs
    // under NODE_ENV='test' and won't have them.
    let demoAuthRoutes: any;

    beforeEach(() => {
      process.env.NODE_ENV = 'development';
      jest.resetModules();
      demoAuthRoutes = require('../auth').default;
    });

    afterEach(() => {
      process.env.NODE_ENV = 'test';
      jest.resetModules();
    });

    const buildDemoApp = () => {
      const demoApp = express();
      demoApp.use(session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { secure: false },
      }));
      demoApp.use('/auth', demoAuthRoutes);
      return demoApp;
    };

    it('should log the demo user in and redirect home', async () => {
      const demoApp = buildDemoApp();

      const response = await request(listening(demoApp))
        .get('/auth/demo-login')
        .expect(302);

      expect(response.headers.location).toBe('http://localhost:3000/');
    });

    it('should log the demo admin in and redirect to /admin', async () => {
      const demoApp = buildDemoApp();

      const response = await request(listening(demoApp))
        .get('/auth/admin-login')
        .expect(302);

      expect(response.headers.location).toBe('http://localhost:3000/admin');
    });
  });
});
