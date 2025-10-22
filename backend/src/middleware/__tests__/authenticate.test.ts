import { Request, Response, NextFunction } from 'express';
import { requireAuth, requireAdmin, optionalAuth } from '../authenticate';
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

  describe('requireAdmin', () => {
    it('should call next() when user is admin', () => {
      const adminUser = generateMockUser({ role: 'researcher_admin' });
      mockReq.session!.user = adminUser;
      
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.user).toEqual(adminUser);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should return 401 when user is not authenticated', () => {
      mockReq.session!.user = undefined;
      
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Authentication required' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 403 when user is not admin', () => {
      const regularUser = generateMockUser({ role: 'employee' });
      mockReq.session!.user = regularUser;
      
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Admin access required' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 when session is null', () => {
      mockReq.session = undefined;
      
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Authentication required' });
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
