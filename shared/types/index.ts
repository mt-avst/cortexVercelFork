// Shared Type Definitions for Adaptalabs Application
// This file contains all common interfaces used by both frontend and backend

import { Request } from 'express';

// ============================================================================
// USER TYPES
// ============================================================================

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

// ============================================================================
// OPPORTUNITY TYPES
// ============================================================================

export interface Opportunity {
  id: string;
  type: 'test' | 'poll' | 'survey' | 'question' | 'interview';
  title: string;
  purpose_one_liner: string;
  description_optional?: string;
  product_optional?: string;
  default_duration_minutes: number;
  status: 'draft' | 'published' | 'closed';
  owner_user_id: string;
  external_link_optional?: string;
  meeting_location_optional?: string;
  participant_type_required?: 'any' | 'internal' | 'external' | 'specific';
  participant_type_specific_details?: string;
  created_at: string;
  updated_at: string;
  // Frontend-specific fields (populated by API joins)
  owner_name?: string;
  owner_email?: string;
  sessions?: Session[];
  clicks_total?: number; // Click count for polls/surveys (M6)
}

export interface CreateOpportunityRequest {
  type: 'test' | 'poll' | 'survey' | 'question' | 'interview';
  title: string;
  purpose_one_liner: string;
  description_optional?: string;
  product_optional?: string;
  default_duration_minutes?: number;
  external_link_optional?: string;
  meeting_location_optional?: string;
  participant_type_required?: 'any' | 'internal' | 'external' | 'specific';
  participant_type_specific_details?: string;
  status?: 'draft' | 'published';
}

export interface UpdateOpportunityRequest {
  type?: 'test' | 'poll' | 'survey' | 'question' | 'interview';
  title?: string;
  purpose_one_liner?: string;
  description_optional?: string;
  product_optional?: string;
  default_duration_minutes?: number;
  status?: 'draft' | 'published' | 'closed';
  external_link_optional?: string;
  meeting_location_optional?: string;
  participant_type_required?: 'any' | 'internal' | 'external' | 'specific';
  participant_type_specific_details?: string;
}

// ============================================================================
// SESSION TYPES
// ============================================================================

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
  remaining: number; // Computed field: capacity - booked_count
}

export interface CreateSessionRequest {
  start_time: string; // ISO string
  end_time: string; // ISO string
  capacity: number;
  location_or_meet_link_optional?: string;
}

export interface UpdateSessionRequest {
  start_time?: string; // ISO string
  end_time?: string; // ISO string
  capacity?: number;
  location_or_meet_link_optional?: string;
}

// ============================================================================
// BOOKING TYPES
// ============================================================================

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
  // Joined fields from session and opportunity
  session_start_time: string;
  session_end_time: string;
  session_capacity: number;
  session_location?: string;
  opportunity_title: string;
  opportunity_type: 'test' | 'poll' | 'survey' | 'question' | 'interview';
  opportunity_purpose: string;
  owner_name: string;
  owner_email: string;
}

export interface RescheduleBookingRequest {
  target_session_id: string;
}

// ============================================================================
// CALENDAR TYPES
// ============================================================================

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  startTime: Date;
  endTime: Date;
  description?: string;
  status: string;
  location?: string;
  meetLink?: string;
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

// ============================================================================
// AUTH TYPES
// ============================================================================

export interface AuthRequest extends Request {
  user?: SessionUser;
}

// ============================================================================
// ERROR HANDLING TYPES
// ============================================================================

// Standard error response interface
export interface ErrorResponse {
  error: string;
  details?: string[];
  code?: string;
  timestamp: string;
  requestId?: string;
}

// Base error class
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code?: string;
  public readonly details?: string[];
  public readonly requestId?: string;

  constructor(
    message: string, 
    statusCode: number = 500, 
    code?: string,
    details?: string[],
    requestId?: string
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.isOperational = true;
    this.code = code;
    this.details = details;
    this.requestId = requestId;

    Error.captureStackTrace(this, this.constructor);
  }
}

// Specific error classes
export class ValidationError extends AppError {
  constructor(message: string, details?: string[]) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class TimeoutError extends AppError {
  constructor(message: string = 'Request timeout') {
    super(message, 408, 'TIMEOUT');
  }
}

export class NetworkError extends AppError {
  constructor(message: string = 'Network error') {
    super(message, 0, 'NETWORK_ERROR');
  }
}

// ============================================================================
// API RESPONSE TYPES
// ============================================================================

export interface SuccessResponse {
  success: boolean;
  message?: string;
}

// ============================================================================
// TYPE GUARDS
// ============================================================================

export const isUser = (obj: any): obj is User => {
  return obj && typeof obj.id === 'string' && typeof obj.name === 'string' && typeof obj.email === 'string';
};

export const isSessionUser = (obj: any): obj is SessionUser => {
  return obj && typeof obj.id === 'string' && typeof obj.name === 'string' && typeof obj.email === 'string';
};

export const isOpportunity = (obj: any): obj is Opportunity => {
  return obj && typeof obj.id === 'string' && typeof obj.title === 'string' && typeof obj.purpose_one_liner === 'string';
};

export const isSession = (obj: any): obj is Session => {
  return obj && typeof obj.id === 'string' && typeof obj.opportunity_id === 'string' && typeof obj.start_time === 'string';
};

export const isBooking = (obj: any): obj is Booking => {
  return obj && typeof obj.id === 'string' && typeof obj.user_id === 'string' && typeof obj.session_id === 'string';
};

// ============================================================================
// FORM TYPES
// ============================================================================

export interface OpportunityFormData {
  // Basic Info Tab
  type: 'test' | 'poll' | 'survey' | 'question' | 'interview' | '';
  title: string;
  purpose_one_liner: string;
  default_duration_minutes: number;
  status: 'draft' | 'published';
  
  // Content Details Tab
  description_optional?: string;
  product_optional?: string;
  meeting_location_optional?: string;
  participant_type_required?: 'any' | 'internal' | 'external' | 'specific';
  participant_type_specific_details?: string;
  
  // External Link Tab
  external_link_optional?: string;
}

export interface SessionFormData {
  start_time: string;
  end_time: string;
  capacity: number;
  location_or_meet_link_optional?: string;
}

// ============================================================================
// LOGGING TYPES
// ============================================================================

export interface LogContext {
  userId?: string;
  sessionId?: string;
  requestId?: string;
  userAgent?: string;
  ip?: string;
  method?: string;
  url?: string;
  statusCode?: number;
  responseTime?: number;
  error?: Error;
  [key: string]: any;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

export type OpportunityType = 'test' | 'poll' | 'survey' | 'question' | 'interview';
export type OpportunityStatus = 'draft' | 'published' | 'closed';
export type ParticipantType = 'any' | 'internal' | 'external' | 'specific';
export type UserRole = 'employee' | 'researcher_admin';
export type BookingStatus = 'booked' | 'cancelled';
