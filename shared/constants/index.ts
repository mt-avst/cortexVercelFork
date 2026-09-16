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
  /**
   * Ceiling for a researcher's running note on one booking (#79). A policy
   * number, so it is pinned as a literal in
   * bookings.researcher-notes.test.ts - refuse over it, never truncate.
   */
  MAX_RESEARCHER_NOTES_CHARS: 20000,
  /**
   * Ceiling for a moderated opportunity's consent wording (#79). Matches
   * INLINE_STUDY_LIMITS.maxConsentLength so neither consent home can hold a
   * text the other would refuse. A policy number - pinned as a literal in
   * opportunities.moderated-consent.test.ts.
   */
  MAX_MODERATED_CONSENT_CHARS: 10000,
  /**
   * Screener shape ceilings (the eligibility questions an author sets on an
   * opportunity). Policy numbers, kept deliberately small so the screener stays
   * light - pinned as literals in backend/src/validation/__tests__/screener-schema.test.ts,
   * refuse over them, never truncate.
   */
  SCREENER_MIN_QUESTIONS: 1,
  SCREENER_MAX_QUESTIONS: 5,
  SCREENER_MIN_OPTIONS: 2,
  SCREENER_MAX_OPTIONS: 6,
  SCREENER_MAX_PROMPT_CHARS: 300,
  SCREENER_MAX_OPTION_LABEL_CHARS: 120,
  SCREENER_MAX_MESSAGE_CHARS: 1000,
  /**
   * "Roles/skills wanted" ceilings - the structured, display-only audience an
   * author advertises on an opportunity ("Product Manager", "ScriptRunner admin
   * experience"). Policy numbers, kept small so the field stays a light set of
   * chips - pinned as literals in
   * backend/src/validation/__tests__/target-roles-schema.test.ts, refuse over
   * them, never truncate.
   */
  TARGET_ROLES_MAX_COUNT: 10,
  TARGET_ROLE_MAX_CHARS: 60,
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
  /**
   * Postgres cancelled the statement because it hit `statement_timeout`.
   *
   * A new possibility rather than a latent one: nothing in this application
   * set a statement timeout until the FirstHand runtime pool started issuing
   * one per checkout, so before that a slow statement simply ran to
   * completion. Lock waiting counts toward the timeout, so the realistic
   * trigger is contention rather than a slow query.
   */
  QUERY_CANCELED: '57014',
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
// OPPORTUNITY TYPES
// ============================================================================

/**
 * Opportunity types
 */
export const OPPORTUNITY_TYPES = {
  TEST: 'test',
  POLL: 'poll',
  SURVEY: 'survey',
  QUESTION: 'question',
  INTERVIEW: 'interview',
  UNMODERATED: 'unmoderated',
} as const;
