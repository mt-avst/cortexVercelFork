import { Request, Response, NextFunction } from 'express';

// The admin gates now re-read the live role from the DB (#14), so the pool must
// be mocked before importing the middleware.
const mockQuery = jest.fn();
jest.mock('../../config', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import { requireAuth, requireAdmin, requireSuperadmin, optionalAuth } from '../authenticate';
import { generateMockUser } from '../../../../shared/test-utils';

// Mock session
const mockSession = {
  user: undefined,
  destroy: jest.fn(),
  regenerate: jest.fn(),
  save: jest.fn(),
  touch: jest.fn(),
  reload: jest.fn(),
  resetMaxAge: jest.fn(),
  cookie: {
    originalMaxAge: 86400000,
    expires: null,
    httpOnly: true,
    secure: false,
    sameSite: 'lax' as const
  },
  id: 'test-session-id',
};

describe('Authentication Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {
      session: mockSession,
      user: undefined,
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
    jest.clearAllMocks();
  });

  describe('requireAuth', () => {
    it('should call next() when user is authenticated', () => {
      const user = generateMockUser();
      mockReq.session!.user = user;
      
      requireAuth(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.user).toEqual(user);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should return 401 when user is not authenticated', () => {
      mockReq.session!.user = undefined;
      
      requireAuth(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Authentication required' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 when session is null', () => {
      mockReq.session = undefined;
      
      requireAuth(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Authentication required' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 when session is undefined', () => {
      mockReq.session = undefined;
      
      requireAuth(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Authentication required' });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  // The DB returns exactly one row carrying the current role.
  const dbReturnsRole = (role: string) =>
    mockQuery.mockResolvedValueOnce({ rows: [{ role }] });

  describe('requireAdmin', () => {
    it('should call next() when user is admin', async () => {
      const adminUser = generateMockUser({ role: 'researcher_admin' });
      mockReq.session!.user = adminUser;
      dbReturnsRole('researcher_admin');

      await requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.user).toEqual(adminUser);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should return 401 when user is not authenticated', async () => {
      mockReq.session!.user = undefined;

      await requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Authentication required' });
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should return 403 when user is not admin', async () => {
      const regularUser = generateMockUser({ role: 'employee' });
      mockReq.session!.user = regularUser;
      dbReturnsRole('employee');

      await requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Admin access required' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 when session is null', async () => {
      mockReq.session = undefined;

      await requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Authentication required' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    // #14 liveness: the gate must trust the live DB role, not the one stamped
    // into the session at login.
    it('rejects a revoked admin whose database role was downgraded after login', async () => {
      // Session still carries the role the user had when they logged in.
      const revokedAdmin = generateMockUser({ role: 'researcher_admin' });
      mockReq.session!.user = revokedAdmin;
      // The DB says they have since been demoted.
      dbReturnsRole('employee');

      await requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Admin access required' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    // CONTROL for the test above: an admin whose DB role still qualifies passes,
    // proving the rejection is the downgrade and not the query itself.
    it('admits a still-valid admin whose database role still qualifies', async () => {
      const validAdmin = generateMockUser({ role: 'researcher_admin' });
      mockReq.session!.user = validAdmin;
      dbReturnsRole('researcher_admin');

      await requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('fails closed with 401 when the user no longer exists in the DB', async () => {
      const ghost = generateMockUser({ role: 'researcher_admin' });
      mockReq.session!.user = ghost;
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('fails closed with 503 when the role check cannot reach the DB', async () => {
      const admin = generateMockUser({ role: 'researcher_admin' });
      mockReq.session!.user = admin;
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      await requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('requireSuperadmin', () => {
    it('admits a live superadmin', async () => {
      const superadmin = generateMockUser({ role: 'superadmin' });
      mockReq.session!.user = superadmin;
      dbReturnsRole('superadmin');

      await requireSuperadmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('rejects a superadmin whose database role was downgraded after login', async () => {
      const revoked = generateMockUser({ role: 'superadmin' });
      mockReq.session!.user = revoked;
      dbReturnsRole('researcher_admin');

      await requireSuperadmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Superadmin access required' });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('optionalAuth', () => {
    it('should attach user and call next() when user is authenticated', () => {
      const user = generateMockUser();
      mockReq.session!.user = user;
      
      optionalAuth(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.user).toEqual(user);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should call next() without attaching user when not authenticated', () => {
      mockReq.session!.user = undefined;
      
      optionalAuth(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.user).toBeUndefined();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should call next() when session is null', () => {
      mockReq.session = undefined;
      
      optionalAuth(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.user).toBeUndefined();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should call next() when session is undefined', () => {
      mockReq.session = undefined;
      
      optionalAuth(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.user).toBeUndefined();
      expect(mockRes.status).not.toHaveBeenCalled();
    });
  });
});
