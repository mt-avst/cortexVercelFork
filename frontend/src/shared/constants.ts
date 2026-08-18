/**
 * AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY
 *
 * Copied from the shared/ directory by frontend/copy-shared-types.js. Nothing
 * runs that script for you: edit the source under shared/, then run
 * `node copy-shared-types.js` from frontend/ and commit the result.
 *
 * Source: See copy-shared-types.js for the source path
 */

// Shared Constants for Adaptalabs Application
// This file contains all application constants used by both frontend and backend

// ============================================================================
// TIME CONSTANTS
// ============================================================================

/**
 * Session duration limits in minutes
 */
export const SESSION_DURATION = {
  /** Minimum session duration in minutes */
  MIN_MINUTES: 5,
  /** Maximum session duration in minutes */
  MAX_MINUTES: 240,
} as const;

/**
 * Time intervals in milliseconds
 */
export const TIME_INTERVALS = {
  /** One minute in milliseconds */
  MINUTE_MS: 60 * 1000,
  /** One hour in milliseconds */
  HOUR_MS: 60 * 60 * 1000,
  /** One day in milliseconds */
  DAY_MS: 24 * 60 * 60 * 1000,
  /** 15 minutes in milliseconds (rate limiting) */
  RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000,
  /** 24 hours in milliseconds (session timeout) */
  SESSION_TIMEOUT_MS: 24 * 60 * 60 * 1000,
} as const;

// ============================================================================
// API CONSTANTS
// ============================================================================

/**
 * API configuration constants
 */
export const API_CONFIG = {
  /** Default API timeout in milliseconds */
  TIMEOUT_MS: 10000,
  /** @deprecated Use TIMEOUT_MS instead. Alias for backwards compatibility */
  TIMEOUT: 10000,
  /** Maximum retry attempts for failed requests */
  MAX_RETRIES: 3,
  /** Delay between retry attempts in milliseconds */
  RETRY_DELAY_MS: 1000,
} as const;

/**
 * HTTP status codes
 */
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TIMEOUT: 408,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

// ============================================================================
// VALIDATION CONSTANTS
// ============================================================================

/**
 * Validation limits and patterns
 */
export const VALIDATION = {
  /** Maximum length for text fields */
  MAX_TEXT_LENGTH: 1000,
  /** Maximum length for titles */
  MAX_TITLE_LENGTH: 200,
  /** Maximum length for descriptions */
  MAX_DESCRIPTION_LENGTH: 5000,
  /** Email validation regex */
  EMAIL_REGEX: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  /** URL validation regex */
  URL_REGEX: /^https?:\/\/.+/,
} as const;

// ============================================================================
// DATABASE CONSTANTS
// ============================================================================

/**
 * Database error codes
 */
export const DB_ERROR_CODES = {
  UNIQUE_CONSTRAINT_VIOLATION: '23505',
  FOREIGN_KEY_CONSTRAINT_VIOLATION: '23503',
  CHECK_CONSTRAINT_VIOLATION: '23514',
  NOT_NULL_CONSTRAINT_VIOLATION: '23502',
  UNDEFINED_TABLE: '42P01',
  UNDEFINED_COLUMN: '42703',
  LOCK_NOT_AVAILABLE: '55P03',
  CONNECTION_FAILURE: '08006',
  /**
   * A value could not be parsed as its column's type - most often a path
   * segment reaching a `uuid` column. Caller error, not server error.
   */
  INVALID_TEXT_REPRESENTATION: '22P02',
} as const;

// ============================================================================
// CALENDAR CONSTANTS
// ============================================================================

/**
 * Calendar and availability configuration
 */
export const CALENDAR_CONFIG = {
  /** Buffer time around calendar queries in milliseconds (24 hours) */
  QUERY_BUFFER_MS: 24 * 60 * 60 * 1000,
  /** Default slot duration in minutes */
  DEFAULT_SLOT_DURATION_MINUTES: 30,
  /** Maximum slots to generate per request */
  MAX_SLOTS_PER_REQUEST: 100,
} as const;

// ============================================================================
// RATE LIMITING CONSTANTS
// ============================================================================

/**
 * Rate limiting configuration
 */
export const RATE_LIMITS = {
  /** Rate limit window in milliseconds */
  WINDOW_MS: TIME_INTERVALS.RATE_LIMIT_WINDOW_MS,
  /** Maximum requests per window */
  MAX_REQUESTS: 100,
  /** Maximum requests per window for auth endpoints */
  MAX_AUTH_REQUESTS: 10,
} as const;

// ============================================================================
// SECURITY CONSTANTS
// ============================================================================

/**
 * Security configuration
 */
export const SECURITY_CONFIG = {
  /** Session cookie max age in milliseconds */
  SESSION_MAX_AGE_MS: TIME_INTERVALS.SESSION_TIMEOUT_MS,
  /** CSRF token expiration in milliseconds */
  CSRF_TOKEN_EXPIRY_MS: TIME_INTERVALS.HOUR_MS,
  /** Password minimum length */
  MIN_PASSWORD_LENGTH: 8,
  /** Maximum login attempts before lockout */
  MAX_LOGIN_ATTEMPTS: 5,
} as const;

// ============================================================================
// PAGINATION CONSTANTS
// ============================================================================

/**
 * Pagination configuration
 */
export const PAGINATION = {
  /** Default page size */
  DEFAULT_PAGE_SIZE: 20,
  /** Maximum page size */
  MAX_PAGE_SIZE: 100,
  /** Minimum page size */
  MIN_PAGE_SIZE: 1,
} as const;

// ============================================================================
// SESSION CONSTANTS
// ============================================================================

/**
 * Session capacity limits
 */
export const SESSION_CAPACITY = {
  /** Minimum session capacity */
  MIN: 1,
  /** Maximum session capacity */
  MAX: 500,
} as const;

// ============================================================================
// LOGGING CONSTANTS
// ============================================================================

/**
 * Logging configuration
 */
export const LOGGING = {
  /** Log levels */
  LEVELS: {
    ERROR: 'error',
    WARN: 'warn',
    INFO: 'info',
    DEBUG: 'debug',
  } as const,
  /** Maximum log message length */
  MAX_MESSAGE_LENGTH: 1000,
} as const;

// ============================================================================
// ENVIRONMENT CONSTANTS
// ============================================================================

/**
 * Environment-specific configuration
 */
export const ENVIRONMENT = {
  DEVELOPMENT: 'development',
  PRODUCTION: 'production',
  TEST: 'test',
} as const;

// ============================================================================
// USER ROLES AND PERMISSIONS
// ============================================================================

/**
 * User roles and permissions
 */
export const USER_ROLES = {
  EMPLOYEE: 'employee',
  RESEARCHER_ADMIN: 'researcher_admin',
  SUPERADMIN: 'superadmin',
} as const;

export const PERMISSIONS = {
  CREATE_OPPORTUNITY: 'create_opportunity',
  EDIT_OPPORTUNITY: 'edit_opportunity',
  DELETE_OPPORTUNITY: 'delete_opportunity',
  VIEW_ALL_OPPORTUNITIES: 'view_all_opportunities',
  MANAGE_SESSIONS: 'manage_sessions',
  VIEW_ANALYTICS: 'view_analytics',
} as const;

// ============================================================================
// OPPORTUNITY TYPES AND STATUSES
// ============================================================================

/**
 * Opportunity types and statuses
 */
export const OPPORTUNITY_TYPES = {
  TEST: 'test',
  POLL: 'poll',
  SURVEY: 'survey',
  QUESTION: 'question',
  INTERVIEW: 'interview',
  UNMODERATED: 'unmoderated',
} as const;

export const OPPORTUNITY_STATUSES = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  CLOSED: 'closed',
} as const;

export const PARTICIPANT_TYPES = {
  ANY: 'any',
  INTERNAL: 'internal',
  EXTERNAL: 'external',
  SPECIFIC: 'specific',
} as const;

// ============================================================================
// BOOKING STATUSES
// ============================================================================

/**
 * Booking statuses
 */
export const BOOKING_STATUSES = {
  BOOKED: 'booked',
  CANCELLED: 'cancelled',
} as const;
