import axios, { AxiosResponse, AxiosError, InternalAxiosRequestConfig } from 'axios';

import { API_CONFIG, getAuthUrl, getApiBaseUrl } from '../config/api';
import { ensureCsrfToken, isCsrfError, isMutatingMethod, CSRF_HEADER } from './csrf';
import { logger } from '../utils/logger';
import { getVisitorNonce } from '../utils/visitorNonce';
import { authNavigation, isAdminRoute, isProductionEnvironment, redirectTo, AUTH_ENDPOINTS } from '../utils/navigation';

import { User, Opportunity, CreateOpportunityRequest, UpdateOpportunityRequest, Session, CreateSessionRequest, Booking, UserBookings, RescheduleBookingRequest, CalendarEvent, AvailabilityResponse, AdminRequest, OpportunityBookingRow, ResearcherNotesResponse, PendingApprovalBooking } from './types';

/** Request-timing config, stamped by the request interceptor and read back by the response/error interceptors. */
type TimedRequestConfig = InternalAxiosRequestConfig & { __startTime?: number };

declare global {
  interface Window {
    __setInitialAuthCheck?: (value: boolean) => void;
  }
}

declare module 'axios' {
  export interface AxiosRequestConfig {
    /**
     * Opt out of the global 401 -> login redirect (below) for this one
     * request. Used only by checkParticipateVisit and markOpportunityOpened,
     * whose docblocks promise a 401 never surfaces to the viewer - without
     * this flag the shared response interceptor would redirect to login on
     * their behalf regardless of what either function returns or catches.
     */
    skipAuthRedirect?: boolean;
  }
}

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
window.__setInitialAuthCheck = setInitialAuthCheck;

// Add request interceptor to generate request IDs (for consistency with apiClient)
api.interceptors.request.use(
  (config) => {
    // Generate request ID if not present
    if (!config.headers['X-Request-ID']) {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      config.headers['X-Request-ID'] = requestId;
    }
    
    const startTime = Date.now();
    (config as TimedRequestConfig).__startTime = startTime;

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
    
    const startTime = (response.config as TimedRequestConfig).__startTime;
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
    
    const startTime = (error.config as TimedRequestConfig | undefined)?.__startTime;
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
    // skipAuthRedirect opts a single request out entirely - see checkParticipateVisit and
    // markOpportunityOpened below, which fail closed and must never bounce the viewer to login.
    if (error.response?.status === 401 &&
        !isInitialAuthCheck &&
        !error.config?.skipAuthRedirect &&
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
  // Decision 2: 'mine' scopes an admin's studies table to their own studies,
  // 'all' widens it to every researcher. Ignored for non-admins.
  scope?: 'mine' | 'all';
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
      throw new Error('Study not found');
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

/**
 * `study_copy_failed` (cto/AdaptaLabs#161) is response-only and transient -
 * not a stored Opportunity field - set only when the linked FirstHand study
 * could not be cloned and the copy came out questionless. Absent on a normal
 * duplicate, never `false`.
 */
export const duplicateOpportunity = async (
  id: string
): Promise<Opportunity & { study_copy_failed?: boolean }> => {
  const response = await api.post(`/opportunities/${id}/duplicate`);
  return response.data;
};

/**
 * D13 AI study drafting (docs/AI-STUDY-DRAFTING-SPEC.md). One step of one
 * type or step, in the same shape `inline_study`/`inline_survey` are already
 * declared in - see `frontend/src/lib/opportunity-authoring/apply-draft.ts`
 * for how a whole draft maps onto the form.
 */
export interface DraftedOpportunityStep {
  type: string;
  prompt: string;
  options?: string[];
  config?: Record<string, number | string>;
  helper_text?: string;
  is_required?: boolean;
}

/**
 * What `POST /opportunities/draft-from-brief` returns as `draft` - the same
 * shape a real create POST would accept, consent already filled from the
 * template and status already forced to 'draft'. Deliberately NOT
 * `CreateOpportunityRequest`: that shared interface has not kept up with the
 * backend's own create schema (it is missing `delivery_mode`, `inline_study`
 * and `inline_survey`), and widening it is a separate, larger change than
 * this feature.
 */
export interface DraftedOpportunity {
  type: 'test' | 'poll' | 'survey' | 'question' | 'interview' | 'unmoderated';
  delivery_mode?: 'native' | 'external';
  title: string;
  purpose_one_liner: string;
  description_optional?: string;
  product_optional?: string;
  participant_type_required?: 'any' | 'internal' | 'external' | 'specific';
  participant_type_specific_details?: string;
  default_duration_minutes?: number;
  external_link_optional?: string;
  status: 'draft';
  consent_text?: string;
  consent_template_id?: string | null;
  consent_template_version?: number | null;
  inline_study?: {
    target_url?: string;
    consent_text: string;
    consent_template_id?: string;
    consent_template_version?: number;
    estimated_duration_minutes?: number;
    steps: DraftedOpportunityStep[];
  };
  inline_survey?: {
    consent_text: string;
    consent_template_id?: string;
    consent_template_version?: number;
    estimated_duration_minutes?: number;
    steps: DraftedOpportunityStep[];
  };
}

export interface DraftOpportunityResponse {
  draft: DraftedOpportunity;
  /** Things the model inferred rather than read off the brief. */
  assumptions: string[];
  /** Things the brief did not say, left for the researcher to fill in. */
  gaps: string[];
  /** Field names the draft actually populated, for the review panel. */
  filled: string[];
}

/**
 * Ask the backend to draft an opportunity from a plain-English brief.
 * Server-side only - the Anthropic key never reaches the browser. Writes
 * nothing: the caller applies the result to the (unsaved) form and the
 * researcher's own save is what persists anything, exactly as today.
 *
 * A longer timeout than the shared default (10s): a real drafting call
 * reasons over the brief before answering and can legitimately take longer
 * than an ordinary CRUD request.
 */
export const draftOpportunityFromBrief = async (
  brief: string,
  hints?: { type?: string; delivery_mode?: 'native' | 'external' }
): Promise<DraftOpportunityResponse> => {
  const response = await api.post(
    '/opportunities/draft-from-brief',
    { brief, ...(hints ? { hints } : {}) },
    { timeout: 60000 }
  );
  return response.data;
};

/**
 * Whether the AI drafting panel may show at all (D13). Reads the same
 * unauthenticated `/api/health` field the beta manifest gates - see
 * `backend/src/index.ts`. Fails CLOSED on any error (network, 5xx, a
 * malformed body): the panel hiding is always the safe outcome, never an
 * error the researcher has to make sense of.
 */
export const getAiDraftingAvailable = async (): Promise<boolean> => {
  try {
    const response = await api.get('/health');
    return response.data?.aiDrafting === true;
  } catch {
    return false;
  }
};

export const getRecordedStudyBrief = async (opportunityId: string): Promise<import('@shared/types').RecordedStudyBrief> => {
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

/**
 * Submit a participant's screener answers and get the auto-evaluated verdict.
 *
 * The verdict is what the three apply chokepoints enforce against, so this is
 * the only way past a screener. Latest answer wins - a screened-out participant
 * may retake. `answers` maps each questionId to the chosen optionId.
 */
export const submitScreener = async (
  opportunityId: string,
  answers: Record<string, string>
): Promise<import('@shared/types').ScreenerSubmitResponse> => {
  const response = await api.post(`/opportunities/${opportunityId}/screener`, { answers });
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

/**
 * The answers this opportunity collected, for its owner.
 *
 * Scoped to the opportunity rather than the study on purpose: a study is
 * reusable by an opportunity its author did not create, so the study-wide
 * results span participants recruited by other researchers and stay
 * superadmin-only.
 */
export const getOpportunitySurveyResults = async (
  opportunityId: string
): Promise<{ title: string; results: import('../components/survey/SurveyResults').SurveyResultsData }> => {
  const response = await api.get(
    `/opportunities/${encodeURIComponent(opportunityId)}/survey-results`
  );
  return response.data;
};

/**
 * The CSV export is a plain link rather than an axios call, so the browser
 * performs the download with the session cookie attached and honours the
 * Content-Disposition filename. That means building the absolute URL the same
 * way the client's baseURL is built, not reusing a relative path.
 */
export const opportunitySurveyResultsCsvUrl = (opportunityId: string): string =>
  `${getApiBaseUrl()}/api/opportunities/${encodeURIComponent(opportunityId)}/survey-results.csv`;

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

export const deleteSession = async (sessionId: string): Promise<void> => {
  await api.delete(`/sessions/${sessionId}`);
};

export const deleteAllSessions = async (opportunityId: string): Promise<{ message: string; deleted_count: number }> => {
  const response = await api.delete(`/opportunities/${opportunityId}/sessions`);
  return response.data;
};

// Booking API functions
export const bookSession = async (
  sessionId: string,
  options?: { consentAccepted?: boolean; consentTextSeen?: string }
): Promise<Booking> => {
  // consent_accepted travels only as the literal true - the server refuses
  // anything else on an opportunity carrying consent, and an opportunity
  // without consent ignores it entirely (#79 step 1b). The echoed wording
  // rides with it: the server refuses an acceptance whose text differs from
  // the row's, so a consent edited mid-read cannot be "accepted" unseen.
  const response = await api.post(
    `/bookings/sessions/${sessionId}/book`,
    options?.consentAccepted === true
      ? { consent_accepted: true, consent_text_seen: options.consentTextSeen ?? '' }
      : {}
  );
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

export const getPendingApprovals = async (): Promise<PendingApprovalBooking[]> => {
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

// Typed as the admin roster row it actually returns - the old
// `BookingWithDetails[]` annotation described the participant-side shape and
// had no caller to notice (#79 gave this function its first one).
export const getOpportunityBookings = async (opportunityId: string): Promise<OpportunityBookingRow[]> => {
  const response = await api.get(`/bookings/opportunities/${opportunityId}/bookings`);
  return response.data;
};

export const updateBookingResearcherNotes = async (
  bookingId: string,
  researcherNotes: string
): Promise<ResearcherNotesResponse> => {
  const response = await api.put(`/bookings/${bookingId}/notes`, { researcher_notes: researcherNotes });
  return response.data;
};

// Booking artefact API functions (#79 step 3) - recordings and transcripts a
// researcher ingests onto a booking after a moderated session. The wire shapes
// are the SHARED contract (shared/types), written by serializeArtifact on the
// backend and read here.
export const getBookingArtifacts = async (
  bookingId: string
): Promise<import('./types').BookingArtifact[]> => {
  const response = await api.get(
    `/bookings/${encodeURIComponent(bookingId)}/artifacts`
  );
  return response.data;
};

export const presignBookingArtifact = async (
  bookingId: string,
  body: {
    kind: import('./types').BookingArtifactKind;
    file_name: string;
    mime_type: string;
    file_size_bytes: number;
    consent_attestation_reason?: string;
  }
): Promise<import('./types').BookingArtifactPresignResponse> => {
  const response = await api.post(
    `/bookings/${encodeURIComponent(bookingId)}/artifacts/presign`,
    body
  );
  return response.data;
};

export const finalizeBookingArtifact = async (
  bookingId: string,
  objectKey: string
): Promise<import('./types').BookingArtifact> => {
  const response = await api.post(
    `/bookings/${encodeURIComponent(bookingId)}/artifacts/finalize`,
    { object_key: objectKey }
  );
  return response.data;
};

export const deleteBookingArtifact = async (
  bookingId: string,
  artifactId: string
): Promise<void> => {
  await api.delete(
    `/bookings/${encodeURIComponent(bookingId)}/artifacts/${encodeURIComponent(artifactId)}`
  );
};

/**
 * Playback URL for the gated media route. Built from the client's own
 * configured base - the same rule as opportunitySurveyResultsCsvUrl and the
 * backend's own URL minting: never from window.location, whose host an
 * embedded or proxied context does not control.
 */
export const bookingArtifactMediaUrl = (
  bookingId: string,
  artifactId: string
): string =>
  `${getApiBaseUrl()}/api/bookings/${encodeURIComponent(bookingId)}/artifacts/${encodeURIComponent(artifactId)}/media`;

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
 *
 * `available` reports whether connecting is possible on this deployment at all
 * (cto/AdaptaLabs#89): false means no Google OAuth client is configured, so
 * offering a Connect control would send the user to a 503.
 */
export const getCalendarConnectionStatus = async (): Promise<{
  connected: boolean;
  connectedAt: string | null;
  available?: boolean;
}> => {
  const response = await api.get('/calendar/connection-status');
  return response.data;
};

/**
 * Where to send the browser to start connecting a personal Google calendar.
 *
 * A full-page navigation rather than an axios call: the route answers a 302 to
 * Google's consent screen, and XHR cannot follow a cross-origin redirect into a
 * page the user has to interact with. Built the same way as the CSV export URL
 * above, and for the same reason.
 */
export const calendarConnectUrl = (): string => `${getApiBaseUrl()}/api/calendar/auth/connect`;

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
    // Send a first-party per-visitor nonce (#125) so anonymous distinct-visitor
    // counts survive the proxy. Omitted when storage is unavailable; the server
    // then falls back to ip_hash. Opaque id, no PII - see getVisitorNonce.
    const visitorNonce = getVisitorNonce();
    const response = await api.post(`/opportunities/${opportunityId}/click`, {
      click_type: clickType,
      ...(visitorNonce ? { visitor_nonce: visitorNonce } : {}),
    });
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

/**
 * Shared base path for every #168 "New since your last visit" endpoint, so a
 * late contract tweak to the path is a one-line change in one place.
 */
const PARTICIPATE_BASE_PATH = '/participate';

export interface ParticipateVisitResponse {
  newOpportunityIds: string[];
}

/**
 * "New since your last visit" (cto/AdaptaLabs#168). Called once per
 * Participate page mount, independently of the study list fetch - see
 * Home.tsx. Marks this visit server-side and answers which of the
 * currently-visible studies were published since the visit before last and
 * have not yet been opened - see markOpportunityOpened below for what clears
 * that "opened" state, across every study type.
 *
 * Fails closed, the same shape as getAiDraftingAvailable above: a badge is
 * cosmetic, never worth failing or delaying the list for, so a 401, 429,
 * 503, a network error, or an e2e mock with no route for this at all, all
 * answer "nothing new" rather than surfacing anywhere. This function only
 * adds a logger.debug line (dev-only) on top - it does not log alone. The
 * shared response interceptor above already runs logger.apiError (error
 * level) on any failed request, this one included, before the rejection
 * ever reaches this catch; a missed badge is silent to the VIEWER, not to
 * the logs. skipAuthRedirect on the request stops a 401 here from also
 * bouncing the viewer to login via that shared interceptor.
 */
export const checkParticipateVisit = async (): Promise<ParticipateVisitResponse> => {
  try {
    const response = await api.post(`${PARTICIPATE_BASE_PATH}/visit`, undefined, { skipAuthRedirect: true });
    const ids = response.data?.newOpportunityIds;
    return { newOpportunityIds: Array.isArray(ids) ? ids : [] };
  } catch (error) {
    logger.debug('Participate visit check failed', {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return { newOpportunityIds: [] };
  }
};

/**
 * "New since your last visit" (cto/AdaptaLabs#168), the other half: clears
 * an opportunity's own New badge the moment a signed-in participant opens
 * it, for every study type - not just the poll/survey/unmoderated subset the
 * existing `trackOpportunityClick(id, 'view')` call above records for
 * analytics, which this is deliberately separate from (see
 * OpportunityDetail.tsx for where both fire, and why). The response body is
 * ignorable - callers only care whether the call happened, not what it
 * answers.
 *
 * Fire-and-forget and fails closed: this clears a cosmetic badge, not a
 * navigation gate, so a 401, 404 (not published/visible), 429, a 5xx or a
 * network error must never surface to the viewer. The caller does not need
 * to await or catch this. As with checkParticipateVisit above, the debug
 * line here is in addition to the shared response interceptor's own
 * error-level log for the same failed request, not instead of it, and
 * skipAuthRedirect on the request is what keeps a 401 here from also
 * bouncing the viewer to login: without it, opening an expired session on a
 * poll/survey/recorded/question detail page - the one page where this call
 * is often the only session-requiring request - would redirect on its
 * behalf even though this function itself never rejects.
 */
export const markOpportunityOpened = async (opportunityId: string): Promise<void> => {
  try {
    await api.post(`${PARTICIPATE_BASE_PATH}/opened/${opportunityId}`, undefined, { skipAuthRedirect: true });
  } catch (error) {
    logger.debug('Participate opened-marker failed', {
      errorMessage: error instanceof Error ? error.message : String(error),
      opportunityId,
    });
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
export const getDashboardStats = async (
  // Decision 2: the "Show all researchers" toggle. 'mine' scopes the snapshot
  // counts to the caller's own studies, 'all' widens them to every researcher.
  scope?: 'mine' | 'all'
): Promise<DashboardStats> => {
  const response = await api.get('/admin/dashboard', { params: scope ? { scope } : undefined });
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

export interface FeedbackListResult {
  items: FeedbackItem[];
  has_more: boolean;
}

/**
 * Get all feedback. EVERY ADMIN, not just a superadmin.
 *
 * This comment said "superadmin only" and was wrong - the route is
 * `requireAdmin`, and Admin.tsx renders the Feedback tab for researcher_admins
 * on purpose. It read as a specification and it was a mistake, which is the
 * expensive kind: the next reader tightening the route to match would have
 * removed a tab those admins are meant to see. cto/AdaptaLabs#15.
 *
 * `deleteFeedback` below IS superadmin-only, and that asymmetry is deliberate.
 *
 * Bounded since cto/AdaptaLabs#81: the server caps the list at its
 * FEEDBACK_LIST_LIMIT newest rows and reports `has_more` when rows exist past
 * the cap. The full set is only reachable through the streamed CSV export.
 */
export const getFeedback = async (): Promise<FeedbackListResult> => {
  const response = await api.get('/feedback');
  return {
    items: response.data.data,
    // Strict equality, not truthiness: a backend that predates #81 sends no
    // has_more at all, and `undefined` must read as "nothing known to be cut
    // off", not as a truncation notice over a complete list.
    has_more: response.data.has_more === true,
  };
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
