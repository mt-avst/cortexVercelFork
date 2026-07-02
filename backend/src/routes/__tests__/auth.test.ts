import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import session from 'express-session';

// Mock the database pool for testing (factory uses only inline jest.fn() to avoid TDZ)
jest.mock('../../config', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  }
}));

// Mock openid-client
jest.mock('openid-client', () => ({
  Issuer: {
    discover: jest.fn()
  }
}));

// Builds a mock OIDC client. callbackParams reflects the *actual* request query
// (mirroring the real openid-client behavior) rather than a hardcoded value, so
// tests exercising missing/invalid state or code are actually falsifiable.
const createMockClient = (overrides: Record<string, any> = {}) => ({
  authorizationUrl: jest.fn((params: any) => {
    const qs = new URLSearchParams({
      client_id: 'test-client-id',
      scope: params.scope,
      state: params.state,
    });
    return `https://test-oidc-provider.com/auth?${qs.toString()}`;
  }),
  callbackParams: jest.fn((req: any) => ({
    state: req.query?.state,
    code: req.query?.code,
  })),
  callback: (jest.fn() as any).mockResolvedValue({ access_token: 'test-token' }),
  userinfo: (jest.fn() as any).mockResolvedValue({
    name: 'Test User',
    email: 'test@example.com',
    department: 'Engineering',
    job_title: 'Developer'
  }),
  ...overrides,
});

// Configures Issuer.discover to resolve a client built from createMockClient(overrides).
// Must be called *before* the first request in a test — the resulting client is cached
// at module scope (mirrors production: the OIDC client is discovered once and reused).
function mockOidc(overrides: Record<string, any> = {}) {
  const { Issuer } = require('openid-client');
  const mockClient = createMockClient(overrides);
  Issuer.discover.mockResolvedValue({
    Client: jest.fn().mockImplementation(() => mockClient),
  });
  return mockClient;
}

// Logs in via the real /auth/login flow to obtain a valid, registered state token,
// exactly as a real client would — the app's CSRF state store only recognizes states
// that were actually issued via /login.
async function loginAndGetState(app: express.Application): Promise<string> {
  const res = await request(app).get('/auth/login').expect(302);
  const url = new URL(res.headers.location);
  return url.searchParams.get('state')!;
}

describe('Authentication Routes', () => {
  let app: express.Application;
  let mockConnect: jest.MockedFunction<any>;

  beforeEach(() => {
    process.env.OIDC_ISSUER = 'https://test-oidc-provider.com';
    process.env.OIDC_CLIENT_ID = 'test-client-id';
    process.env.OIDC_CLIENT_SECRET = 'test-client-secret';
    process.env.OIDC_REDIRECT_URL = 'http://localhost:3001/auth/callback';
    process.env.CORS_ORIGIN = 'http://localhost:3000';
    process.env.NODE_ENV = 'test';

    // auth.ts kicks off OIDC client discovery once at module-load time, so the
    // module must be re-required fresh each test (after the env vars above are
    // set) rather than reused from a shared, already-initialized instance.
    jest.resetModules();

    const { pool } = require('../../config');
    mockConnect = pool.connect;

    const authRouter = require('../auth').default;

    app = express();
    app.use(express.json());
    app.use(session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false }
    }));
    app.use('/auth', authRouter);
  });

  afterEach(() => {
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.OIDC_REDIRECT_URL;
    delete process.env.CORS_ORIGIN;
  });

  describe('GET /auth/login', () => {
    it('should redirect to OIDC provider', async () => {
      mockOidc();

      const response = await request(app)
        .get('/auth/login')
        .expect(302);

      expect(response.headers.location).toContain('https://test-oidc-provider.com');
      expect(response.headers.location).toContain('client_id=test-client-id');
      expect(response.headers.location).toContain('scope=openid+profile+email');
    });

    it('should handle OIDC client initialization errors', async () => {
      const { Issuer } = require('openid-client');
      Issuer.discover.mockRejectedValue(new Error('OIDC discovery failed'));

      await request(app)
        .get('/auth/login')
        .expect(500);
    });
  });

  describe('GET /auth/callback', () => {
    // The callback route upserts the user via pool.connect() -> dbClient.query(...),
    // not pool.query() directly, so tests must configure the *connected client's*
    // query mock, not the pool-level one.
    let mockClientQuery: jest.MockedFunction<any>;

    beforeEach(() => {
      // Default working client; individual tests may override via mockOidc(...)
      // before their first request to inject specific callback/userinfo behavior.
      mockOidc();
      mockClientQuery = jest.fn();
      mockConnect.mockResolvedValue({
        query: mockClientQuery,
        release: jest.fn()
      });
    });

    it('should handle successful authentication', async () => {
      const state = await loginAndGetState(app);

      // Mock user upsert query
      mockClientQuery.mockResolvedValueOnce({
        rows: [{
          id: 'user-123',
          name: 'Test User',
          email: 'test@example.com',
          business_unit: 'Engineering',
          role_title: 'Developer',
          role: 'employee'
        }]
      });

      // Mock notification preferences creation
      mockClientQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .get(`/auth/callback?state=${state}&code=test-code`)
        .expect(302);

      expect(response.headers.location).toBe('http://localhost:3000');
      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        expect.arrayContaining(['Test User', 'test@example.com', 'Engineering', 'Developer'])
      );
    });

    it('should handle invalid state parameter', async () => {
      // A state that was never issued via /login is rejected regardless of code.
      await request(app)
        .get('/auth/callback?state=never-issued-state&code=test-code')
        .expect(400);
    });

    it('should handle missing state parameter', async () => {
      const response = await request(app)
        .get('/auth/callback?code=test-code')
        .expect(400);

      expect(response.body.error).toBe('Invalid state parameter');
    });

    it('should handle OIDC callback errors', async () => {
      mockOidc({
        callback: (jest.fn() as any).mockRejectedValue(new Error('OIDC callback failed')),
      });
      const state = await loginAndGetState(app);

      await request(app)
        .get(`/auth/callback?state=${state}&code=test-code`)
        .expect(500);
    });

    it('should handle database errors during user creation', async () => {
      const state = await loginAndGetState(app);
      mockClientQuery.mockRejectedValueOnce(new Error('Database error'));

      await request(app)
        .get(`/auth/callback?state=${state}&code=test-code`)
        .expect(500);
    });
  });

  describe('POST /auth/logout', () => {
    it('should destroy session and clear cookie', async () => {
      const response = await request(app)
        .post('/auth/logout')
        .expect(200);

      expect(response.body).toEqual({ success: true });
    });

    it('should handle session destruction errors', async () => {
      // Mock session.destroy to fail
      const mockSession = {
        destroy: jest.fn().mockImplementation((callback: any) => {
          callback(new Error('Session destruction failed'));
        }) as any
      };

      const appWithMockSession = express();
      appWithMockSession.use(express.json());
      appWithMockSession.use((req, res, next) => {
        req.session = mockSession as any;
        next();
      });
      appWithMockSession.use('/auth', require('../auth').default);

      await request(appWithMockSession)
        .post('/auth/logout')
        .expect(500);
    });
  });

  describe('Demo Routes (Development Only)', () => {
    // These routes are only registered on the router when NODE_ENV === 'development'
    // *at module-load time* (see auth.ts's top-level `if` block), so the module must
    // be re-required with NODE_ENV already set — setting it in beforeEach alone is a
    // no-op against the already-imported, module-cached router built in the outer
    // beforeEach above (which runs under NODE_ENV='test').
    let demoAuthRouter: any;

    beforeEach(() => {
      process.env.NODE_ENV = 'development';
      jest.resetModules();
      demoAuthRouter = require('../auth').default;
    });

    afterEach(() => {
      process.env.NODE_ENV = 'test';
      jest.resetModules();
    });

    const buildDemoApp = (sessionMiddleware: express.RequestHandler) => {
      const demoApp = express();
      demoApp.use(express.json());
      demoApp.use(sessionMiddleware);
      demoApp.use('/auth', demoAuthRouter);
      return demoApp;
    };

    it('should provide demo user login', async () => {
      const demoApp = buildDemoApp(session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { secure: false },
      }));

      const response = await request(demoApp)
        .get('/auth/demo-login')
        .expect(302);

      expect(response.headers.location).toBe('http://localhost:3000/');
    });

    it('should provide demo admin login', async () => {
      const demoApp = buildDemoApp(session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { secure: false },
      }));

      const response = await request(demoApp)
        .get('/auth/admin-login')
        .expect(302);

      expect(response.headers.location).toBe('http://localhost:3000/admin');
    });

    it('should handle session save errors in demo login', async () => {
      const mockSession = {
        user: null,
        save: jest.fn().mockImplementation((callback: any) => {
          callback(new Error('Session save failed'));
        }) as any
      };

      const appWithMockSession = buildDemoApp((req, res, next) => {
        req.session = mockSession as any;
        next();
      });

      await request(appWithMockSession)
        .get('/auth/demo-login')
        .expect(500);
    });
  });

  describe('Environment Configuration', () => {
    it('should require OIDC configuration', async () => {
      delete process.env.OIDC_ISSUER;
      delete process.env.OIDC_CLIENT_ID;
      delete process.env.OIDC_CLIENT_SECRET;
      delete process.env.OIDC_REDIRECT_URL;
      jest.resetModules();

      const freshApp = express();
      freshApp.use(express.json());
      freshApp.use(session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { secure: false }
      }));
      freshApp.use('/auth', require('../auth').default);

      await request(freshApp)
        .get('/auth/login')
        .expect(500);
    });
  });
});
