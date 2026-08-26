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

// Mock crypto.randomBytes only — preserve the rest of the real module (createHash etc.),
// which express-session needs internally to hash/compare session state on every request.
// randomBytes always returning 'mock-state' means the OIDC state token issued by /login
// is always the literal string 'mock-state' in this file.
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomBytes: jest.fn(() => ({
    toString: jest.fn(() => 'mock-state'),
  })),
}));

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

// Logs in via the real /auth/login flow, as a browser would: the returned agent
// holds the cookies /login set - the session and the browser-bound
// `adaptalabs_oauth_state` cookie the callback now requires (cto/AdaptaLabs#82) -
// so the SAME agent must drive the callback request.
async function loginAgent(
  app: express.Application
): Promise<{ agent: ReturnType<typeof request.agent>; state: string }> {
  const agent = request.agent(listening(app));
  const res = await agent.get('/auth/login').expect(302);
  const url = new URL(res.headers.location);
  return { agent, state: url.searchParams.get('state')! };
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
      expect(response.headers.location).toContain('state=mock-state');
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
      const { agent, state } = await loginAgent(app);

      // Mock user upsert query
      mockClientQuery.mockResolvedValueOnce(createMockQueryResult([mockUser]));
      // Mock notification preferences creation
      mockClientQuery.mockResolvedValueOnce(createMockQueryResult([]));

      const response = await agent
        .get('/auth/callback')
        .query({ code: 'auth-code', state })
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
      const { agent, state } = await loginAgent(app);

      await agent
        .get('/auth/callback')
        .query({ code: 'auth-code', state })
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
