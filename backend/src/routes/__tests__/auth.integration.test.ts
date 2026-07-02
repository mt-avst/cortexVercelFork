import request from 'supertest';
import express from 'express';
import session from 'express-session';
import App from '../../index';
import { generateMockUser } from '../../../../shared/test-utils';
import { createMockDbClient, createMockQueryResult } from '../../../../shared/test-utils';

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
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomBytes: jest.fn(() => ({
    toString: jest.fn(() => 'mock-state'),
  })),
}));

describe('Auth Routes Integration Tests', () => {
  let app: express.Application;
  let mockPool: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = require('../../config').pool;
    
    // Create a fresh app instance for each test
    app = express();
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
      const mockIssuer = {
        Client: jest.fn().mockImplementation(() => ({
          authorizationUrl: jest.fn(() => 'https://oidc-provider.com/auth?state=mock-state'),
        })),
      };
      
      require('openid-client').Issuer.discover.mockResolvedValue(mockIssuer);

      const response = await request(app)
        .get('/auth/login')
        .expect(302);

      expect(response.headers.location).toContain('https://oidc-provider.com/auth');
      expect(response.headers.location).toContain('state=mock-state');
    });

    it('should handle OIDC client initialization error', async () => {
      require('openid-client').Issuer.discover.mockRejectedValue(new Error('Discovery failed'));

      await request(app)
        .get('/auth/login')
        .expect(500);
    });
  });

  describe('GET /auth/callback', () => {
    it('should handle successful OIDC callback', async () => {
      const mockUser = generateMockUser();
      const mockTokens = {
        access_token: 'access-token',
        id_token: 'id-token',
      };

      const mockClient = {
        callbackParams: jest.fn(() => ({ code: 'auth-code', state: 'mock-state' })),
        callback: jest.fn().mockResolvedValue({
          access_token: mockTokens.access_token,
          id_token: mockTokens.id_token,
        }),
        userinfo: jest.fn().mockResolvedValue({
          sub: mockUser.id,
          name: mockUser.name,
          email: mockUser.email,
          business_unit: mockUser.business_unit,
          role_title: mockUser.role_title,
        }),
      };

      const mockIssuer = {
        Client: jest.fn().mockReturnValue(mockClient),
      };

      require('openid-client').Issuer.discover.mockResolvedValue(mockIssuer);

      // Mock database queries
      mockPool.query
        .mockResolvedValueOnce(createMockQueryResult([mockUser])) // User lookup
        .mockResolvedValueOnce(createMockQueryResult([mockUser])); // User creation/update

      const response = await request(app)
        .get('/auth/callback')
        .query({ code: 'auth-code', state: 'mock-state' })
        .expect(302);

      expect(response.headers.location).toBe('http://localhost:3000/');
      expect(mockClient.callback).toHaveBeenCalled();
      expect(mockClient.userinfo).toHaveBeenCalled();
    });

    it('should handle missing state parameter', async () => {
      const response = await request(app)
        .get('/auth/callback')
        .query({ code: 'auth-code' })
        .expect(400);

      expect(response.body.error).toBe('Missing state parameter');
    });

    it('should handle missing code parameter', async () => {
      const response = await request(app)
        .get('/auth/callback')
        .query({ state: 'mock-state' })
        .expect(400);

      expect(response.body.error).toBe('Missing authorization code');
    });

    it('should handle OIDC callback error', async () => {
      const mockClient = {
        callbackParams: jest.fn(() => ({ code: 'auth-code', state: 'mock-state' })),
        callback: jest.fn().mockRejectedValue(new Error('OIDC callback failed')),
      };

      const mockIssuer = {
        Client: jest.fn().mockReturnValue(mockClient),
      };

      require('openid-client').Issuer.discover.mockResolvedValue(mockIssuer);

      await request(app)
        .get('/auth/callback')
        .query({ code: 'auth-code', state: 'mock-state' })
        .expect(500);
    });
  });

  describe('GET /auth/logout', () => {
    it('should logout user and redirect', async () => {
      const mockUser = generateMockUser();
      
      // Mock session with user
      const response = await request(app)
        .get('/auth/logout')
        .expect(302);

      expect(response.headers.location).toBe('http://localhost:3000/');
    });
  });

  describe('GET /auth/me', () => {
    it('should return user data when authenticated', async () => {
      const mockUser = generateMockUser();
      
      // Mock session with user
      const response = await request(app)
        .get('/auth/me')
        .expect(200);

      expect(response.body).toEqual(mockUser);
    });

    it('should return 401 when not authenticated', async () => {
      const response = await request(app)
        .get('/auth/me')
        .expect(401);

      expect(response.body.error).toBe('Not authenticated');
    });
  });

  describe('POST /auth/demo-login', () => {
    it('should login demo user', async () => {
      const mockUser = generateMockUser({ 
        email: 'demo@example.com',
        name: 'Demo User',
        role: 'employee'
      });

      mockPool.query.mockResolvedValue(createMockQueryResult([mockUser]));

      const response = await request(app)
        .post('/auth/demo-login')
        .send({ email: 'demo@example.com' })
        .expect(200);

      expect(response.body).toEqual(mockUser);
    });

    it('should handle missing email', async () => {
      const response = await request(app)
        .post('/auth/demo-login')
        .send({})
        .expect(400);

      expect(response.body.error).toBe('Email is required');
    });

    it('should handle invalid email format', async () => {
      const response = await request(app)
        .post('/auth/demo-login')
        .send({ email: 'invalid-email' })
        .expect(400);

      expect(response.body.error).toBe('Invalid email format');
    });

    it('should handle user not found', async () => {
      mockPool.query.mockResolvedValue(createMockQueryResult([]));

      const response = await request(app)
        .post('/auth/demo-login')
        .send({ email: 'nonexistent@example.com' })
        .expect(404);

      expect(response.body.error).toBe('User not found');
    });

    it('should handle database error', async () => {
      mockPool.query.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/auth/demo-login')
        .send({ email: 'demo@example.com' })
        .expect(500);

      expect(response.body.error).toBe('Database operation failed');
    });
  });

  describe('POST /auth/admin-login', () => {
    it('should login admin user', async () => {
      const mockAdmin = generateMockUser({ 
        email: 'admin@example.com',
        name: 'Admin User',
        role: 'researcher_admin'
      });

      mockPool.query.mockResolvedValue(createMockQueryResult([mockAdmin]));

      const response = await request(app)
        .post('/auth/admin-login')
        .send({ email: 'admin@example.com' })
        .expect(200);

      expect(response.body).toEqual(mockAdmin);
    });

    it('should reject non-admin users', async () => {
      const mockUser = generateMockUser({ 
        email: 'user@example.com',
        role: 'employee'
      });

      mockPool.query.mockResolvedValue(createMockQueryResult([mockUser]));

      const response = await request(app)
        .post('/auth/admin-login')
        .send({ email: 'user@example.com' })
        .expect(403);

      expect(response.body.error).toBe('Admin access required');
    });
  });
});
