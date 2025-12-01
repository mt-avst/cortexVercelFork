import { Request, Response, NextFunction } from 'express';
import { SessionUser } from '../types';

// Note: Express Request extension is defined in ../types/index.ts

// Middleware to require authentication
export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  req.user = req.session.user;
  next();
};

// Middleware to require admin role (researcher_admin or superadmin)
export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (req.session.user.role !== 'researcher_admin' && req.session.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  req.user = req.session.user;
  next();
};

// Middleware to require superadmin role only
export const requireSuperadmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (req.session.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required' });
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
