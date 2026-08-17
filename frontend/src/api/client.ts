import axios, { AxiosResponse, AxiosError } from 'axios';

import { API_CONFIG, getAuthUrl, getApiBaseUrl } from '../config/api';
import { AppError, mapAxiosError } from '../utils/errorHandler';
import { ensureCsrfToken, isCsrfError, isMutatingMethod, CSRF_HEADER } from './csrf';
import { logger } from '../utils/logger';
import { authNavigation, isAdminRoute, isProductionEnvironment, redirectTo, AUTH_ENDPOINTS } from '../utils/navigation';

import { User, Opportunity, CreateOpportunityRequest, UpdateOpportunityRequest, Session, CreateSessionRequest, UpdateSessionRequest, Booking, BookingWithDetails, UserBookings, RescheduleBookingRequest, CalendarEvent, AvailableSlot, AvailabilityResponse, ConflictCheckResponse, AdminRequest } from './types';

/**
 * Primary API client for all frontend API requests
 * 
 * This axios instance includes:
 * - Request ID generation for tracing
 * - Response time logging
 * - Automatic 401 handling with redirect to login
 * - Cache-busting headers
 * 
 * All API calls should use this instance via the exported functions below.
 */
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

// CSRF: attach the session token to every mutating request, and on a CSRF
// 403 fetch a fresh token and retry the request once (covers token expiry
// and session regeneration after login).
api.interceptors.request.use(async (config) => {
  if (isMutatingMethod(config.method)) {
    const csrfToken = await ensureCsrfToken();
    if (csrfToken) {
      config.headers[CSRF_HEADER] = csrfToken;
    }
  }
  return config;
});

api.interceptors.response.use(undefined, async (error: unknown) => {
  if (isCsrfError(error)) {
    const config = error.config as (typeof error.config & { __csrfRetried?: boolean }) | undefined;
    if (config && !config.__csrfRetried) {
      config.__csrfRetried = true;
      const csrfToken = await ensureCsrfToken(true);
      if (csrfToken) {
        config.headers = config.headers ?? {};
        (config.headers as Record<string, string>)[CSRF_HEADER] = csrfToken;
        return api.request(config);
      }
    }
  }
  return Promise.reject(error);
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
      
      const isAdmin = isAdminRoute();
      const isProduction = isProductionEnvironment();
      
      logger.info('Redirecting to login due to 401 error', {
        requestId: requestId || undefined,
        url: window.location.pathname,
        isAdminRoute: isAdmin,
        isProduction,
      });
      
      authNavigation.toLogin(isAdmin, isProduction);
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
  const response = await api.get('/me');
  return response.data;
};

export const logout = async (): Promise<void> => {
  // Use auth endpoint for logout (separate axios call, so attach the CSRF
  // token explicitly rather than relying on the api instance interceptor)
  const csrfToken = await ensureCsrfToken();
  await axios.post(getAuthUrl(AUTH_ENDPOINTS.LOGOUT), {}, {
    withCredentials: true,
    timeout: API_CONFIG.TIMEOUT,
    headers: csrfToken ? { [CSRF_HEADER]: csrfToken } : undefined,
  });
};

// Demo functions for testing
export const demoLogin = async (): Promise<void> => {
  authNavigation.toDemoLogin();
};

export const demoAdminLogin = async (): Promise<void> => {
  authNavigation.toAdminLogin();
};

export const demoSuperadminLogin = async (): Promise<void> => {
  authNavigation.toSuperadminLogin();
};

/**
 * App-level Okta OIDC login - redirects to the backend's /auth/login, which
 * kicks off the OIDC flow. This is the production login path on Kubera.
 */
export const oidcLogin = async (): Promise<void> => {
  authNavigation.toOidcLogin();
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
  const response = await api.get('/opportunities', { params });
  return response.data;
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

export const getRecordedStudyBrief = async (opportunityId: string): Promise<import('../shared/types').RecordedStudyBrief> => {
  const response = await api.get(`/opportunities/${opportunityId}/recorded-study-brief`);
  return response.data;
};

export const startRecordedStudySession = async (opportunityId: string): Promise<{ session_url: string }> => {
  const response = await api.post(`/opportunities/${opportunityId}/recorded-study-session`);
  return response.data;
};

/**
 * Mint a session for a NATIVE poll or survey.
 *
 * Separate from startRecordedStudySession because the routes are separate: that
 * one mints a recorded session with screen and microphone capture, and refuses
 * anything that is not an unmoderated study. A survey records nothing.
 */
export const startSurveySession = async (opportunityId: string): Promise<{ session_url: string }> => {
  const response = await api.post(`/opportunities/${opportunityId}/survey-session`);
  return response.data;
};

export const getFirstHandStudies = async (): Promise<import('./types').FirstHandStudy[]> => {
  const response = await api.get('/firsthand/studies');
  return response.data.studies ?? [];
};

export const getOpportunitySessionEvents = async (opportunityId: string): Promise<import('./types').SessionEvent[]> => {
  const response = await api.get(`/opportunities/${opportunityId}/session-events`);
  return response.data;
};

export const getMySessionEvents = async (): Promise<import('./types').MySessionEvent[]> => {
  const response = await api.get('/me/session-events');
  return response.data;
};

export const getSessionOutputs = async (
  opportunityId: string,
  sessionId: string,
  attempt?: number
): Promise<import('./types').FirstHandSessionOutputs> => {
  const response = await api.get(
    `/opportunities/${opportunityId}/sessions/${sessionId}/outputs`,
    { params: attempt ? { attempt } : undefined }
  );
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
 * Track a click on an opportunity
 * @param opportunityId - The opportunity ID
 * @param clickType - 'view' (viewed study details) or 'action' (clicked action button)
 */
export const trackOpportunityClick = async (
  opportunityId: string, 
  clickType: 'view' | 'action' = 'action'
): Promise<{ ok: boolean }> => {
  try {
    const response = await api.post(`/opportunities/${opportunityId}/click`, { click_type: clickType });
    return response.data;
  } catch (error) {
    // Don't fail the navigation if tracking fails - just log it
    logger.warn('Click tracking failed', {
      error: error instanceof Error ? error : undefined,
      errorMessage: error instanceof Error ? error.message : String(error),
      opportunityId,
      clickType,
    });
    return { ok: false };
  }
};

export interface OpportunityAnalytics {
  // Combined summary stats
  clicks_total: number;
  clicks_24h: number;
  clicks_7d: number;
  unique_users: number;
  avg_clicks_per_day: number;
  /** null when the previous week had nothing: there is no percentage change from zero. */
  week_over_week_change: number | null;
  
  // Views (user clicked to view study details)
  views_total: number;
  views_24h: number;
  views_7d: number;
  unique_viewers: number;
  
  // Actions (user clicked action button - Open Poll/Survey, Book Session)
  actions_total: number;
  actions_24h: number;
  actions_7d: number;
  unique_actors: number;
  
  // Conversion rate (views -> actions)
  conversion_rate: number;
  
  // Dates
  first_click: string | null;
  last_click: string | null;
  opportunity_created: string;
  
  // Peak info
  peak_day: { date: string; count: number; views?: number; actions?: number } | null;
  peak_hour: { hour: number; hour_label: string; count: number } | null;
  
  // Time series data (with views/actions breakdown)
  clicks_by_day: Array<{ date: string; count: number; views: number; actions: number }>;
  clicks_by_hour: Array<{ hour: number; count: number }>;
  clicks_by_weekday: Array<{ weekday: string; weekday_num: number; count: number }>;
  
  // Period info
  period: number;
  /** Totals for the SELECTED period, so a chart header stops quoting 7 days beside a 30-day chart. */
  period_clicks_total: number;
  period_views_total: number;
  period_actions_total: number;
  /** The zone days and hours were bucketed in. One organisation zone, not the reader's. */
  time_zone: string;
}

export type AnalyticsPeriod = 7 | 14 | 30;

/**
 * Get click analytics for an opportunity (admin only)
 */
export const getOpportunityAnalytics = async (
  opportunityId: string, 
  period: AnalyticsPeriod = 30
): Promise<OpportunityAnalytics> => {
  const response = await api.get(`/opportunities/${opportunityId}/analytics?period=${period}`);
  return response.data;
};

// M7: Dashboard and Settings

export interface RecentBookingItem {
  id: string;
  opportunity_id: string;
  opportunity_title: string;
  session_start: string;
  participant_name: string;
  participant_email: string;
  status: string;
  booked_at: string;
}

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
  sessions_completed: number;
  total_slots: number;
  booked_slots: number;
  available_slots: number;
  recent_bookings?: RecentBookingItem[];
}

/**
 * Get dashboard statistics (admin only)
 */
export const getDashboardStats = async (): Promise<DashboardStats> => {
  const response = await api.get('/admin/dashboard');
  return response.data.data;
};

// NotificationPreference is imported from shared types
// Extended version with nullable id for API responses
export interface NotificationPreferenceResponse {
  id: string | null;
  user_id: string;
  on_book_email: boolean;
  on_cancel_email: boolean;
}

// Alias for backwards compatibility
export type NotificationPreference = NotificationPreferenceResponse;

/**
 * Get user's notification preferences
 */
export const getNotificationPreferences = async (): Promise<NotificationPreferenceResponse> => {
  const response = await api.get('/notification-preferences');
  return response.data.data;
};

/**
 * Update user's notification preferences
 */
export const updateNotificationPreferences = async (preferences: {
  on_book_email: boolean;
  on_cancel_email: boolean;
}): Promise<NotificationPreferenceResponse> => {
  const response = await api.patch('/notification-preferences', preferences);
  return response.data.data;
};

/**
 * Admin Management Functions
 */

/**
 * Request admin access
 */
export const requestAdminAccess = async (): Promise<{ success: boolean; request: AdminRequest; message: string }> => {
  const response = await api.post('/admin/request');
  return response.data;
};

/**
 * Get all admin requests (superadmin only)
 */
export const getAdminRequests = async (status?: 'pending' | 'approved' | 'denied'): Promise<{ success: boolean; requests: AdminRequest[] }> => {
  const params = status ? { status } : {};
  const response = await api.get('/admin/requests', { params });
  return response.data;
};

/**
 * Approve an admin request (superadmin only)
 */
export const approveAdminRequest = async (requestId: string): Promise<{ success: boolean; message: string }> => {
  const response = await api.post(`/admin/requests/${requestId}/approve`);
  return response.data;
};

/**
 * Deny an admin request (superadmin only)
 */
export const denyAdminRequest = async (requestId: string, notes?: string): Promise<{ success: boolean; message: string }> => {
  const response = await api.post(`/admin/requests/${requestId}/deny`, { notes });
  return response.data;
};

/**
 * Get all admins (superadmin only)
 */
export const getAdmins = async (): Promise<{ success: boolean; admins: User[] }> => {
  const response = await api.get('/admin/admins');
  return response.data;
};

/**
 * Revoke admin access (superadmin only)
 */
export const revokeAdminAccess = async (adminId: string): Promise<{ success: boolean; message: string }> => {
  const response = await api.delete(`/admin/admins?id=${adminId}`);
  return response.data;
};

/**
 * Submit feedback
 */
export const submitFeedback = async (data: {
  category: string;
  feedback: string;
  userAgent: string;
  url: string;
}): Promise<{ success: boolean }> => {
  const response = await api.post('/feedback', data);
  return response.data;
};

/**
 * Platform Stats for Homepage KPIs
 */
export interface PlatformStats {
  activeStudies: number;
  participantsRegistered: number;
  rewardsDistributed: number;
}

/**
 * Get platform-wide statistics for homepage KPI display
 */
export const getPlatformStats = async (): Promise<PlatformStats> => {
  const response = await api.get('/stats/platform');
  return response.data;
};

/**
 * Feedback item type
 */
export interface FeedbackItem {
  id: string;
  user_id: string | null;
  user_name: string;
  user_email: string;
  category: 'bug' | 'feature' | 'question' | 'other';
  feedback: string;
  url: string;
  user_agent: string;
  created_at: string;
}

/**
 * Get all feedback (superadmin only)
 */
export const getFeedback = async (): Promise<FeedbackItem[]> => {
  const response = await api.get('/feedback');
  return response.data.data;
};

/**
 * Delete a feedback item (superadmin only)
 */
export const deleteFeedback = async (id: string): Promise<{ success: boolean }> => {
  const response = await api.delete(`/feedback/${id}`);
  return response.data;
};

/**
 * Export feedback as CSV (admin only)
 */
export const exportFeedbackCsv = async (): Promise<void> => {
  redirectTo(`${getApiBaseUrl()}/api/feedback/export`);
};

/**
 * Export bookings as CSV (admin only). researcher_admin sees only their opportunities.
 */
export const exportBookingsCsv = async (): Promise<void> => {
  redirectTo(`${getApiBaseUrl()}/api/admin/export/bookings`);
};

export default api;
