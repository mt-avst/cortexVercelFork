// Re-export shared types for frontend use
export * from '../shared/types';

// Import specific types for frontend-specific interfaces
import { BookingWithDetails, AdminRequest } from '../shared/types';

// Explicitly re-export AdminRequest to ensure TypeScript picks it up
export type { AdminRequest };

// Frontend-specific types that extend shared types
export interface UserBookings {
  upcoming: BookingWithDetails[];
  past: BookingWithDetails[];
}
