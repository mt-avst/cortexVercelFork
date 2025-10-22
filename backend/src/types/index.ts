// Re-export shared types for backend use
export * from '../../../shared/types';

// Backend-specific types that extend shared types
// Note: NotificationPreference and Setting are already defined in shared/types

// Extend Express session to include user property
declare module 'express-session' {
  interface SessionData {
    user?: import('../../../shared/types').SessionUser;
  }
}
