// Re-export shared types for frontend use
export * from '../../../shared/types';

// Import specific types for frontend-specific interfaces
import { BookingWithDetails } from '../../../shared/types';

// Frontend-specific types that extend shared types
export interface UserBookings {
  upcoming: BookingWithDetails[];
  past: BookingWithDetails[];
}
