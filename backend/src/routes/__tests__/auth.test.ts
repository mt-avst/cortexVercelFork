import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import session from 'express-session';
import authRouter from '../auth';
import { pool } from '../../config';

// Mock the database pool for testing
jest.mock('../../config', () => ({
  pool: {
    query: jest.fn() as any,
    connect: jest.fn() as any
  }
})) as any;

// Mock openid-client
jest.mock('openid-client', () => ({
  Issuer: {
    discover: jest.fn() as jest.MockedFunction<any>
  }
}));

// Setup mock client after module import
const createMockClient = () => {
  const mockCallback = jest.fn();
  (mockCallback as any).mockResolvedValue({ access_token: 'test-token' });
  
  const mockUserinfo = jest.fn();
  (mockUserinfo as any).mockResolvedValue({
    name: 'Test User',
    email: 'test@example.com',
    department: 'Engineering',
    job_title: 'Developer'
  });
  
  return {
    authorizationUrl: jest.fn().mockReturnValue('https://oidc-provider.com/auth'),
    callbackParams: jest.fn().mockReturnValue({ state: 'test-state', code: 'test-code' }),
    callback: mockCallback as any,
    userinfo: mockUserinfo as any
  };
};

const app = express();
app.use(express.json());
app.use(session({
  secret: 'test-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

app.use('/auth', authRouter);

describe('Authentication Routes', () => {
  const mockQuery = pool.query as jest.MockedFunction<any>;
  const mockConnect = pool.connect as jest.MockedFunction<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OIDC_ISSUER = 'https://test-oidc-provider.com';
    process.env.OIDC_CLIENT_ID = 'test-client-id';
    process.env.OIDC_CLIENT_SECRET = 'test-client-secret';
    process.env.OIDC_REDIRECT_URL = 'http://localhost:3001/auth/callback';
    process.env.CORS_ORIGIN = 'http://localhost:3000';
    
    // Setup default OIDC mock
    const { Issuer } = require('openid-client');
    Issuer.discover.mockResolvedValue({
      Client: jest.fn().mockImplementation(() => createMockClient())
    });
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
      const response = await request(app)
        .get('/auth/login')
        .expect(302);

      expect(response.headers.location).toContain('https://test-oidc-provider.com');
      expect(response.headers.location).toContain('client_id=test-client-id');
      expect(response.headers.location).toContain('scope=openid+profile+email');
    });

    it('should handle OIDC client initialization errors', async () => {
      // Mock OIDC client initialization failure
      const { Issuer } = require('openid-client');
      Issuer.discover.mockRejectedValueOnce(new Error('OIDC discovery failed'));

      await request(app)
        .get('/auth/login')
        .expect(500);
    });
  });

  describe('GET /auth/callback', () => {
    let mockClient: any;

    beforeEach(() => {
      mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      mockConnect.mockResolvedValue(mockClient);
    });

    it('should handle successful authentication', async () => {
      // Mock user upsert query
      mockQuery.mockResolvedValueOnce({
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
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .get('/auth/callback?state=test-state&code=test-code')
        .expect(302);

      expect(response.headers.location).toBe('http://localhost:3000');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        expect.arrayContaining(['Test User', 'test@example.com', 'Engineering', 'Developer'])
      );
    });

    it('should handle invalid state parameter', async () => {
      await request(app)
        .get('/auth/callback?state=invalid-state&code=test-code')
        .expect(400);
    });

    it('should handle missing state parameter', async () => {
      await request(app)
        .get('/auth/callback?code=test-code')
        .expect(400);
    });

    it('should handle OIDC callback errors', async () => {
      const { Issuer } = require('openid-client');
      const mockCallback = jest.fn();
      (mockCallback as any).mockRejectedValue(new Error('OIDC callback failed'));
      const mockClient = {
        callback: mockCallback
      };
      Issuer.discover.mockResolvedValueOnce({
        Client: jest.fn().mockReturnValue(mockClient)
      });

      await request(app)
        .get('/auth/callback?state=test-state&code=test-code')
        .expect(500);
    });

    it('should handle database errors during user creation', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Database error'));

      await request(app)
        .get('/auth/callback?state=test-state&code=test-code')
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
      appWithMockSession.use('/auth', authRouter);

      await request(appWithMockSession)
        .post('/auth/logout')
        .expect(500);
    });
  });

  describe('Demo Routes (Development Only)', () => {
    // These routes are only registered on the router when NODE_ENV === 'development'
    // *at module-load time* (see auth.ts's top-level `if` block), so the module must
    // be re-required with NODE_ENV already set — setting it in beforeEach alone is a
    // no-op against the already-imported, module-cached `authRouter`.
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

      await request(app)
        .get('/auth/login')
        .expect(500);
    });
  });
});
