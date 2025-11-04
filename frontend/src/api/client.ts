import axios, { AxiosResponse, AxiosError } from 'axios';

import { API_CONFIG, getAuthUrl } from '../config/api';
import { ApiClient, AppError, mapAxiosError } from '../utils/errorHandler';
import { logger } from '../utils/logger';

import { User, Opportunity, CreateOpportunityRequest, UpdateOpportunityRequest, Session, CreateSessionRequest, UpdateSessionRequest, Booking, BookingWithDetails, UserBookings, RescheduleBookingRequest, CalendarEvent, AvailableSlot, AvailabilityResponse, ConflictCheckResponse } from './types';

// Import the getter functions to ensure dynamic evaluation
import { getApiBaseUrl } from '../config/api';

// Create enhanced API client with error handling
// Use getApiBaseUrl() directly for runtime evaluation instead of frozen API_CONFIG
const apiClient = new ApiClient(getApiBaseUrl() + '/api');

// Legacy axios instance for backward compatibility
const api = axios.create({
  baseURL: getApiBaseUrl() + '/api',
  withCredentials: true,
  timeout: API_CONFIG.TIMEOUT,
  headers: {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  }
});

// Track if we're doing an initial auth check to prevent auto-redirects
let isInitialAuthCheck = false;
const setInitialAuthCheck = (value: boolean) => {
  isInitialAuthCheck = value;
};
// Export so AuthContext can set this flag
(window as any).__setInitialAuthCheck = setInitialAuthCheck;

// Add request interceptor to generate request IDs (for consistency with apiClient)
api.interceptors.request.use(
  (config) => {
    // Generate request ID if not present
    if (!config.headers['X-Request-ID']) {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      config.headers['X-Request-ID'] = requestId;
    }
    
    const startTime = Date.now();
    (config as any).__startTime = startTime;
    
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Add response interceptor to extract request IDs and handle 401s
api.interceptors.response.use(
  (response: AxiosResponse) => {
    // Extract request ID from response headers and store in logger
    const requestId = response.headers['x-request-id'] as string || 
                     response.config.headers?.['X-Request-ID'] as string;
    if (requestId) {
      logger.setRequestId(requestId);
    }
    
    const startTime = (response.config as any).__startTime;
    if (startTime) {
      const responseTime = Date.now() - startTime;
      logger.apiResponse(
        response.config.method || 'GET',
        response.config.url || '',
        response.status,
        responseTime,
        { requestId }
      );
    }
    
    return response;
  },
  (error: AxiosError) => {
    // Extract request ID from error response headers
    const requestId = error.response?.headers?.['x-request-id'] as string ||
                     error.config?.headers?.['X-Request-ID'] as string;
    if (requestId) {
      logger.setRequestId(requestId);
    }
    
    const startTime = (error.config as any)?.__startTime;
    if (startTime) {
      const responseTime = Date.now() - startTime;
      logger.apiError(
        error.config?.method?.toUpperCase() || 'UNKNOWN',
        error.config?.url || '',
        error.response?.status || 0,
        error,
        {
          requestId,
          responseTime,
        }
      );
    }
    
    // Only redirect to login for actual 401s, not during initial load or after login
    // IMPORTANT: Don't auto-redirect during initial auth check to prevent automatic admin login
    if (error.response?.status === 401 && 
        !isInitialAuthCheck &&
        window.location.pathname !== '/' && 
        !window.location.pathname.includes('/auth/')) {
      
      // Determine appropriate login route based on current context
      const isAdminRoute = window.location.pathname.includes('/admin') || 
                          window.location.pathname.includes('/opportunities') ||
                          window.location.pathname.includes('/sessions');
      
      const loginRoute = isAdminRoute ? '/api/auth/admin-login' : '/api/auth/demo-login';
      
      logger.info('Redirecting to login due to 401 error', {
        requestId: requestId || undefined,
        url: window.location.pathname,
        loginRoute,
      });
      window.location.href = getAuthUrl(loginRoute);
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
  // Use auth endpoint for logout
  await axios.post(getAuthUrl('/api/auth/logout'), {}, {
    withCredentials: true,
    timeout: API_CONFIG.TIMEOUT,
  });
};

// Demo functions for testing
export const demoLogin = async (): Promise<void> => {
  // Set a flag to detect when we return from login
  sessionStorage.setItem('loginRedirect', 'true');
  window.location.href = getAuthUrl('/api/auth/demo-login');
};

export const demoUser2Login = async (): Promise<void> => {
  // Set a flag to detect when we return from login
  sessionStorage.setItem('loginRedirect', 'true');
  window.location.href = getAuthUrl('/api/auth/demo-user-2-login');
};

export const demoAdminLogin = async (): Promise<void> => {
  // Set a flag to detect when we return from login
  sessionStorage.setItem('loginRedirect', 'true');
  window.location.href = getAuthUrl('/api/auth/admin-login');
};

/**
 * Google OAuth login - redirects to Google OAuth flow
 */
export const googleLogin = async (): Promise<void> => {
  // Set a flag to detect when we return from login
  sessionStorage.setItem('loginRedirect', 'true');
  window.location.href = getAuthUrl('/api/auth/google-login');
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
  // Use path parameter for ID - backend supports /api/opportunities/:id
  const response = await api.get(`/opportunities/${id}`, { params });
  // Ensure we return a single object, not an array
  const data = response.data;
  if (Array.isArray(data)) {
    // If API returns array, take the first item (or find by ID)
    const opportunity = data.find((opp: Opportunity) => opp.id === id) || data[0];
    if (!opportunity) {
      throw new Error('Opportunity not found');
    }
    return opportunity;
  }
  return data;
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
  const sessions = Array.isArray(data) ? data : [data];
  const response = await api.post('/sessions', { 
    opportunity_id: opportunityId,
    sessions 
  });
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

export const cleanupCancelledBookings = async (): Promise<any> => {
  const response = await api.post('/bookings/cleanup-cancelled');
  return response.data;
};

// Session completion API functions
export const completeSession = async (sessionId: string): Promise<{ message: string; status: string; awaitingApproval: boolean }> => {
  const response = await api.post(`/bookings/sessions/${sessionId}/complete`);
  return response.data;
};

export const getPendingApprovals = async (): Promise<any[]> => {
  const response = await api.get('/bookings/pending-approvals');
  return response.data;
};

export const approveSession = async (bookingId: string, adminNotes?: string): Promise<{ message: string; pointsAwarded: number; newLevel: number; levelUp: boolean; totalPoints: number }> => {
  const response = await api.post(`/bookings/${bookingId}/approve`, { adminNotes });
  return response.data;
};

export const rejectSession = async (bookingId: string, adminNotes?: string): Promise<{ message: string; status: string }> => {
  const response = await api.post(`/bookings/${bookingId}/reject`, { adminNotes });
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
  calendarId?: string,
  opportunityId?: string
): Promise<ConflictCheckResponse> => {
  const response = await api.post('/calendar/check-conflicts', {
    time_slots: timeSlots,
    calendar_id: calendarId,
    opportunity_id: opportunityId
  });
  return response.data;
};

// User Calendar API functions
/**
 * Get user's calendar events for a date range
 */
export const getMyCalendarEvents = async (
  startTime: string,
  endTime: string
): Promise<CalendarEvent[]> => {
  const params = new URLSearchParams({
    start_time: startTime,
    end_time: endTime,
  });
  
  const response = await api.get(`/calendar/my-events?${params}`);
  return response.data;
};

/**
 * Check calendar connection status
 */
export const getCalendarConnectionStatus = async (): Promise<{
  connected: boolean;
  connectedAt: string | null;
}> => {
  const response = await api.get('/calendar/connection-status');
  return response.data;
};

/**
 * Disconnect user's calendar
 */
export const disconnectCalendar = async (): Promise<void> => {
  await api.delete('/calendar/disconnect');
};

// Click tracking API functions (M6)
/**
 * Track a click on a poll or survey opportunity
 */
export const trackOpportunityClick = async (opportunityId: string): Promise<{ ok: boolean }> => {
  try {
    const response = await api.post(`/opportunities/${opportunityId}/click`);
    return response.data;
  } catch (error) {
    // Don't fail the navigation if tracking fails - just log it
    console.warn('Click tracking failed:', error);
    return { ok: false };
  }
};

export interface OpportunityAnalytics {
  clicks_total: number;
  clicks_24h: number;
  clicks_by_day: Array<{ date: string; count: number }>;
}

/**
 * Get click analytics for an opportunity (admin only)
 */
export const getOpportunityAnalytics = async (opportunityId: string): Promise<OpportunityAnalytics> => {
  const response = await api.get(`/opportunities/${opportunityId}/analytics`);
  return response.data;
};

// M7: Dashboard and Settings

export interface DashboardStats {
  total_opportunities: number;
  published_opportunities: number;
  draft_opportunities: number;
  closed_opportunities: number;
  total_bookings: number;
  upcoming_bookings: number;
  past_bookings: number;
  total_participants: number;
  total_sessions: number;
  total_slots: number;
  booked_slots: number;
  available_slots: number;
}

/**
 * Get dashboard statistics (admin only)
 */
export const getDashboardStats = async (): Promise<DashboardStats> => {
  const response = await api.get('/admin/dashboard');
  return response.data.data;
};

export interface NotificationPreference {
  id: string | null;
  user_id: string;
  on_book_email: boolean;
  on_cancel_email: boolean;
}

/**
 * Get user's notification preferences
 */
export const getNotificationPreferences = async (): Promise<NotificationPreference> => {
  const response = await api.get('/notification-preferences');
  return response.data.data;
};

/**
 * Update user's notification preferences
 */
export const updateNotificationPreferences = async (preferences: {
  on_book_email: boolean;
  on_cancel_email: boolean;
}): Promise<NotificationPreference> => {
  const response = await api.patch('/notification-preferences', preferences);
  return response.data.data;
};

export default api;
