export interface User {
    id: string;
    name: string;
    email: string;
    business_unit?: string;
    role_title?: string;
    role: 'employee' | 'researcher_admin';
    created_at: string;
}
export interface SessionUser {
    id: string;
    name: string;
    email: string;
    business_unit?: string;
    role_title?: string;
    role: 'employee' | 'researcher_admin';
}
export interface NotificationPreference {
    id: string;
    user_id: string;
    on_book_email: boolean;
    on_cancel_email: boolean;
}
export interface Setting {
    id: string;
    key: string;
    value_json: any;
}
export interface Opportunity {
    id: string;
    type: 'test' | 'poll' | 'survey' | 'question';
    title: string;
    purpose_one_liner: string;
    description_optional?: string;
    product_optional?: string;
    default_duration_minutes: number;
    status: 'draft' | 'published' | 'closed';
    owner_user_id: string;
    external_link_optional?: string;
    participant_type_required?: 'any' | 'internal' | 'external' | 'specific';
    participant_type_specific_details?: string;
    created_at: string;
    updated_at: string;
    owner_name?: string;
    owner_email?: string;
    sessions?: Session[];
}
export interface CreateOpportunityRequest {
    type: 'test' | 'poll' | 'survey' | 'question';
    title: string;
    purpose_one_liner: string;
    description_optional?: string;
    product_optional?: string;
    default_duration_minutes?: number;
    external_link_optional?: string;
    participant_type_required?: 'any' | 'internal' | 'external' | 'specific';
    participant_type_specific_details?: string;
    status?: 'draft' | 'published';
}
export interface UpdateOpportunityRequest {
    type?: 'test' | 'poll' | 'survey' | 'question';
    title?: string;
    purpose_one_liner?: string;
    description_optional?: string;
    product_optional?: string;
    default_duration_minutes?: number;
    status?: 'draft' | 'published' | 'closed';
    external_link_optional?: string;
    participant_type_required?: 'any' | 'internal' | 'external' | 'specific';
    participant_type_specific_details?: string;
}
export interface Session {
    id: string;
    opportunity_id: string;
    start_time: string;
    end_time: string;
    capacity: number;
    booked_count: number;
    location_or_meet_link_optional?: string;
    created_at: string;
    updated_at: string;
    remaining?: number;
}
export interface CreateSessionRequest {
    start_time: string;
    end_time: string;
    capacity: number;
    location_or_meet_link_optional?: string;
}
export interface UpdateSessionRequest {
    start_time?: string;
    end_time?: string;
    capacity?: number;
    location_or_meet_link_optional?: string;
}
export interface Booking {
    id: string;
    user_id: string;
    session_id: string;
    status: 'booked' | 'cancelled';
    gcal_event_id?: string;
    cancelled_at?: string;
    created_at: string;
    updated_at: string;
}
export interface BookingWithDetails extends Booking {
    session_start_time: string;
    session_end_time: string;
    session_capacity: number;
    session_location?: string;
    opportunity_title: string;
    opportunity_type: 'test' | 'poll' | 'survey' | 'question';
    opportunity_purpose: string;
    owner_name: string;
    owner_email: string;
}
export interface RescheduleBookingRequest {
    target_session_id: string;
}
export interface CalendarEvent {
    id: string;
    title: string;
    start: string;
    end: string;
    status: string;
    location?: string;
    attendees: Array<{
        email: string;
        name?: string;
        responseStatus: string;
    }>;
}
export interface AvailableSlot {
    start: string;
    end: string;
    duration_minutes: number;
}
export interface AvailabilityResponse {
    available_slots: AvailableSlot[];
    total_slots: number;
    duration_minutes: number;
    time_range: {
        start: string;
        end: string;
    };
}
export interface ConflictCheckResponse {
    has_conflicts: boolean;
    conflicts: Array<{
        slot_index: number;
        start_time: string;
        end_time: string;
        conflicting_events: Array<{
            id: string;
            title: string;
            start: string;
            end: string;
        }>;
    }>;
    total_slots_checked: number;
    conflicting_slots: number;
}
export interface AuthRequest extends Request {
    user?: SessionUser;
}
export interface ErrorResponse {
    error: string;
    details?: string[];
    code?: string;
    timestamp?: string;
    requestId?: string;
}
export interface SuccessResponse {
    success: boolean;
    message?: string;
}
export declare const isUser: (obj: any) => obj is User;
export declare const isSessionUser: (obj: any) => obj is SessionUser;
export declare const isOpportunity: (obj: any) => obj is Opportunity;
export declare const isSession: (obj: any) => obj is Session;
export declare const isBooking: (obj: any) => obj is Booking;
export type OpportunityType = 'test' | 'poll' | 'survey' | 'question';
export type OpportunityStatus = 'draft' | 'published' | 'closed';
export type ParticipantType = 'any' | 'internal' | 'external' | 'specific';
export type UserRole = 'employee' | 'researcher_admin';
export type BookingStatus = 'booked' | 'cancelled';
//# sourceMappingURL=index.d.ts.map