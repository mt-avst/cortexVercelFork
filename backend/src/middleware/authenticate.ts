import { Request, Response, NextFunction } from 'express';
import { SessionUser, AuthRequest } from '../types';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

// Middleware to require authentication
export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  req.user = req.session.user;
  next();
};

// Middleware to require admin role
export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (req.session.user.role !== 'researcher_admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  req.user = req.session.user;
  next();
};

// Optional authentication - attaches user if session exists
export const optionalAuth = (req: Request, res: Response, next: NextFunction) => {
  if (req.session?.user) {
    req.user = req.session.user;
  }
  next();
};
