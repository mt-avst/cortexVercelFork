// Re-export shared types for backend use
export * from '../../../shared/types';

// Backend-specific types that extend shared types
// Note: NotificationPreference and Setting are already defined in shared/types

import { Request } from 'express';
import { SessionUser } from '../../../shared/types';

// Extend Express Request type to include user
export interface AuthRequest extends Request {
  user?: SessionUser;
}

// Extend Express session to include user property
declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
  }
}
