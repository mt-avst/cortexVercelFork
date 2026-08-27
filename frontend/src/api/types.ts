// Re-export shared types for frontend use
export * from '@shared/types';

// Import specific types for frontend-specific interfaces
import { BookingWithDetails, AdminRequest } from '@shared/types';

// Explicitly re-export AdminRequest to ensure TypeScript picks it up
export type { AdminRequest };

// Frontend-specific types that extend shared types
export interface UserBookings {
  upcoming: BookingWithDetails[];
  past: BookingWithDetails[];
}

/**
 * One row of GET /api/bookings/opportunities/:id/bookings - the owner's (or a
 * superadmin's) roster of who booked, fed to the analytics Participants tab
 * (#79). This is the ADMIN shape: it names the participant and carries
 * `researcher_notes`, neither of which any participant-facing booking route
 * returns. Typed here rather than in shared/ because only this side reads it.
 */
export interface OpportunityBookingRow {
  id: string;
  user_id: string;
  session_id: string;
  status: string;
  completion_status: string | null;
  session_start_time: string;
  session_end_time: string;
  participant_name: string | null;
  participant_email: string | null;
  business_unit: string | null;
  role_title: string | null;
  researcher_notes: string | null;
  researcher_notes_updated_at: string | null;
  cancelled_at?: string;
  created_at: string;
  updated_at: string;
}

/** What PUT /api/bookings/:bookingId/notes answers with. */
export interface ResearcherNotesResponse {
  researcher_notes: string | null;
  researcher_notes_updated_at: string | null;
}
