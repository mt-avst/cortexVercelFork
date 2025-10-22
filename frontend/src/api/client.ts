import axios from 'axios';

import { API_CONFIG, getAuthUrl } from '../config/api';
import { ApiClient, AppError, mapAxiosError } from '../utils/errorHandler';

import { User, Opportunity, CreateOpportunityRequest, UpdateOpportunityRequest, Session, CreateSessionRequest, UpdateSessionRequest, Booking, BookingWithDetails, UserBookings, RescheduleBookingRequest, CalendarEvent, AvailableSlot, AvailabilityResponse, ConflictCheckResponse } from './types';

// Create enhanced API client with error handling
const apiClient = new ApiClient(API_CONFIG.BASE_URL + '/api');

// Legacy axios instance for backward compatibility
const api = axios.create({
  baseURL: API_CONFIG.BASE_URL + '/api',
  withCredentials: true,
  timeout: API_CONFIG.TIMEOUT,
  headers: {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  }
});

// Add response interceptor to handle 401s
api.interceptors.response.use(
  (response) => response,
  (error) => {
    // Only redirect to login for actual 401s, not during initial load or after login
    if (error.response?.status === 401 && 
        window.location.pathname !== '/' && 
        !window.location.pathname.includes('/auth/')) {
      window.location.href = '/auth/login';
    }
    return Promise.reject(error);
  }
);

/**
 * Get current user information
 * 
 * Fetches the authenticated user's profile data from the API.
 * Automatically handles authentication errors and redirects to login if needed.
 * 
 * @returns Promise resolving to User object
 * @throws {UnauthorizedError} If user is not authenticated
 * @throws {AppError} For other API errors
 */
export const getMe = async (): Promise<User> => {
  return apiClient.get<User>('/me');
};

export const logout = async (): Promise<void> => {
  // Use direct axios call since logout is not under /api prefix
  await axios.post(getAuthUrl('/auth/logout'), {}, {
    withCredentials: true,
    timeout: API_CONFIG.TIMEOUT,
  });
};

// Demo functions for testing
export const demoLogin = async (): Promise<void> => {
  // Set a flag to detect when we return from login
  sessionStorage.setItem('loginRedirect', 'true');
  window.location.href = getAuthUrl('/auth/demo-login');
};

export const demoAdminLogin = async (): Promise<void> => {
  // Set a flag to detect when we return from login
  sessionStorage.setItem('loginRedirect', 'true');
  window.location.href = getAuthUrl('/auth/admin-login');
};

/**
 * Fetch opportunities with optional filtering
 * 
 * Retrieves a list of opportunities with support for filtering by type,
 * search query, and status. Non-admin users only see published opportunities.
 * 
 * @param params - Optional filtering parameters
 * @param params.type - Filter by opportunity type (test, poll, survey, question)
 * @param params.q - Search query for title and purpose
 * @param params.status - Filter by status (draft, published, closed)
 * @returns Promise resolving to array of Opportunity objects
 * @throws {AppError} For API errors
 */
export const getOpportunities = async (params?: {
  type?: string;
  q?: string;
  status?: string;
}): Promise<Opportunity[]> => {
  return apiClient.get<Opportunity[]>('/opportunities', { params });
};

export const getOpportunity = async (id: string, params?: { _t?: number }): Promise<Opportunity> => {
  const response = await api.get(`/opportunities/${id}`, { params });
  return response.data;
};

export const createOpportunity = async (data: CreateOpportunityRequest): Promise<Opportunity> => {
  const response = await api.post('/opportunities', data);
  return response.data;
};

export const updateOpportunity = async (id: string, data: UpdateOpportunityRequest): Promise<Opportunity> => {
  const response = await api.patch(`/opportunities/${id}`, data);
  return response.data;
};

export const deleteOpportunity = async (id: string): Promise<void> => {
  await api.delete(`/opportunities/${id}`);
};

export const duplicateOpportunity = async (id: string): Promise<Opportunity> => {
  const response = await api.post(`/opportunities/${id}/duplicate`);
  return response.data;
};

// Session API functions
export const getSessions = async (opportunityId: string, params?: {
  from?: string;
  include_past?: boolean;
}): Promise<Session[]> => {
  const response = await api.get(`/opportunities/${opportunityId}/sessions`, { params });
  return response.data;
};

export const createSessions = async (opportunityId: string, data: CreateSessionRequest | CreateSessionRequest[]): Promise<Session[]> => {
  const response = await api.post(`/opportunities/${opportunityId}/sessions`, data);
  return response.data;
};

export const updateSession = async (sessionId: string, data: UpdateSessionRequest): Promise<Session> => {
  const response = await api.patch(`/sessions/${sessionId}`, data);
  return response.data;
};

export const deleteSession = async (sessionId: string): Promise<void> => {
  await api.delete(`/sessions/${sessionId}`);
};

export const closeOpportunityIfPast = async (opportunityId: string): Promise<void> => {
  await api.post(`/opportunities/${opportunityId}/close-if-past`);
};

export const deleteAllSessions = async (opportunityId: string): Promise<{ message: string; deleted_count: number }> => {
  const response = await api.delete(`/opportunities/${opportunityId}/sessions`);
  return response.data;
};

// Booking API functions
export const bookSession = async (sessionId: string): Promise<Booking> => {
  const response = await api.post(`/bookings/sessions/${sessionId}/book`);
  return response.data;
};

export const cancelBooking = async (bookingId: string): Promise<void> => {
  await api.post(`/bookings/${bookingId}/cancel`);
};

export const rescheduleBooking = async (bookingId: string, data: RescheduleBookingRequest): Promise<void> => {
  await api.post(`/bookings/${bookingId}/reschedule`, data);
};

export const getMyBookings = async (): Promise<UserBookings> => {
  const response = await api.get('/bookings/my/bookings');
  return response.data;
};

export const getMyBookingsDebug = async (): Promise<any> => {
  const response = await api.get('/bookings/my/bookings/debug');
  return response.data;
};

export const cleanupCancelledBookings = async (): Promise<any> => {
  const response = await api.post('/bookings/cleanup-cancelled');
  return response.data;
};

export const getOpportunityBookings = async (opportunityId: string): Promise<BookingWithDetails[]> => {
  const response = await api.get(`/bookings/opportunities/${opportunityId}/bookings`);
  return response.data;
};

// Calendar API functions
export const getCalendarEvents = async (
  startTime: string, 
  endTime: string, 
  calendarId?: string
): Promise<CalendarEvent[]> => {
  const params = new URLSearchParams({
    start_time: startTime,
    end_time: endTime
  });
  
  if (calendarId) {
    params.append('calendar_id', calendarId);
  }
  
  const response = await api.get(`/calendar/events?${params}`);
  return response.data;
};

export const getAvailability = async (
  startTime: string,
  endTime: string,
  durationMinutes: number,
  calendarId?: string,
  excludeWeekends?: boolean
): Promise<AvailabilityResponse> => {
  const params = new URLSearchParams({
    start_time: startTime,
    end_time: endTime,
    duration_minutes: durationMinutes.toString()
  });
  
  if (calendarId) {
    params.append('calendar_id', calendarId);
  }
  
  if (excludeWeekends) {
    params.append('exclude_weekends', 'true');
  }
  
  const response = await api.get(`/calendar/availability?${params}`);
  return response.data;
};

export const checkConflicts = async (
  timeSlots: Array<{ start_time: string; end_time: string }>,
  calendarId?: string
): Promise<ConflictCheckResponse> => {
  const response = await api.post('/calendar/check-conflicts', {
    time_slots: timeSlots,
    calendar_id: calendarId
  });
  return response.data;
};

export default api;
