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
    discover: jest.fn().mockResolvedValue({
      Client: jest.fn().mockImplementation(() => ({
        authorizationUrl: jest.fn().mockReturnValue('https://oidc-provider.com/auth'),
        callbackParams: jest.fn().mockReturnValue({ state: 'test-state', code: 'test-code' }),
        callback: jest.fn().mockResolvedValue({ access_token: 'test-token' }),
        userinfo: jest.fn().mockResolvedValue({
          name: 'Test User',
          email: 'test@example.com',
          department: 'Engineering',
          job_title: 'Developer'
        })
      })) as any
    }) as any
  }
}));

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
  const mockQuery = pool.query as jest.MockedFunction<typeof pool.query>;
  const mockConnect = pool.connect as jest.MockedFunction<typeof pool.connect>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OIDC_ISSUER = 'https://test-oidc-provider.com';
    process.env.OIDC_CLIENT_ID = 'test-client-id';
    process.env.OIDC_CLIENT_SECRET = 'test-client-secret';
    process.env.OIDC_REDIRECT_URL = 'http://localhost:3001/auth/callback';
    process.env.CORS_ORIGIN = 'http://localhost:3000';
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
      const mockClient = {
        callback: jest.fn().mockRejectedValue(new Error('OIDC callback failed'))
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
        destroy: jest.fn().mockImplementation((callback) => {
          callback(new Error('Session destruction failed'));
        })
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
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    afterEach(() => {
      process.env.NODE_ENV = 'test';
    });

    it('should provide demo user login', async () => {
      const response = await request(app)
        .get('/auth/demo-login')
        .expect(302);

      expect(response.headers.location).toBe('http://localhost:3000');
    });

    it('should provide demo admin login', async () => {
      const response = await request(app)
        .get('/auth/admin-login')
        .expect(302);

      expect(response.headers.location).toBe('http://localhost:3000/admin');
    });

    it('should handle session save errors in demo login', async () => {
      const mockSession = {
        user: null,
        save: jest.fn().mockImplementation((callback) => {
          callback(new Error('Session save failed'));
        })
      };

      const appWithMockSession = express();
      appWithMockSession.use(express.json());
      appWithMockSession.use((req, res, next) => {
        req.session = mockSession as any;
        next();
      });
      appWithMockSession.use('/auth', authRouter);

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
