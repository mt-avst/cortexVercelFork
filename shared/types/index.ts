// Shared Type Definitions for Adaptalabs Application
// This file contains all common interfaces used by both frontend and backend

// Conditional import for Express types (only in backend context)
type ExpressRequest = typeof import('express') extends { Request: infer T } ? T : never;

// ============================================================================
// USER TYPES
// ============================================================================

export interface User {
  id: string;
  name: string;
  email: string;
  business_unit?: string;
  role_title?: string;
  role: 'employee' | 'researcher_admin' | 'superadmin';
  created_at: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  business_unit?: string;
  role_title?: string;
  role: 'employee' | 'researcher_admin' | 'superadmin';
}

/**
 * The admin-role set, written down once (cto/AdaptaLabs#57).
 *
 * "Which roles are admin" used to be spelled inline at 16 runtime sites, so the
 * set could drift by editing one string and nothing would fail across the
 * others - a gate measured a one-character deletion of `superadmin` that 1301
 * tests still passed. A single predicate turns that one-character edit into a
 * failure across every admin gate at once.
 *
 * The set membership itself - that BOTH `researcher_admin` and `superadmin` are
 * admins - is pinned in the mutation canary (`is-admin-role-includes-*`), the
 * property that had no enforcement anywhere until this predicate existed.
 *
 * Takes a bare string (and null/undefined) so the DB-sourced role reads
 * (`userResult.rows[0].role`) and the session reads (`req.user?.role`) call it
 * the same way. This is NOT the Postgres CHECK, the Zod `z.enum` or the type
 * union - those are the same set stated for other consumers and stay as they
 * are; this replaces only the runtime TypeScript predicates.
 */
export function isAdminRole(role: string | null | undefined): boolean {
  return role === 'researcher_admin' || role === 'superadmin';
}

export interface AdminRequest {
  id: string;
  user_id: string;
  requested_at: string;
  requested_role: 'researcher_admin' | 'superadmin';
  status: 'pending' | 'approved' | 'denied';
  reviewed_by?: string;
  reviewed_at?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  email?: string;
  name?: string;
  current_role?: string;
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
  type: 'test' | 'poll' | 'survey' | 'question' | 'interview' | 'unmoderated';
  title: string;
  purpose_one_liner: string;
  description_optional?: string;
  product_optional?: string;
  default_duration_minutes: number;
  status: 'draft' | 'published' | 'closed';
  owner_user_id?: string; // Admin responses only - stripped from public/participant responses
  external_link_optional?: string;
  // Nullable: the column is nullable, the update schema accepts null to clear
  // the link, and the API returns null for an opportunity with no study.
  firsthand_study_id?: string | null;
  // Whether a poll or survey runs inside Cortex or hands off to an external
  // service. Declared because the opportunity routes return the row with
  // `SELECT *` / `RETURNING *`, so this column is already on every response -
  // including the types that ignore it - and an undeclared response field is
  // how a client ends up depending on one nobody meant to publish. Not on the
  // request interfaces yet: it becomes writable with the authoring toggle.
  delivery_mode?: 'native' | 'external';
  meeting_location_optional?: string;
  participant_type_required?: 'any' | 'internal' | 'external' | 'specific';
  participant_type_specific_details?: string;
  start_date?: string; // Study start date for external link types
  end_date?: string; // Study end date for countdown display
  // Moderated consent (#79). On every response (SELECT * / RETURNING *), and
  // deliberately PUBLIC: a participant must read the wording before booking -
  // the verdict lives in backend/src/utils/publicOpportunity.ts.
  consent_text?: string | null;
  consent_template_id?: string | null;
  consent_template_version?: number | null;
  created_at: string;
  updated_at: string;
  /**
   * The LINKED STUDY's `updated_at` after this write - not the opportunity's,
   * which is the field above.
   *
   * Present only on the responses to a create or an update that actually wrote
   * a study, and absent otherwise. That distinction is load-bearing rather
   * than tidy: a client reading a present-but-null field as "there is no
   * study" would clear the optimistic-concurrency precondition it should have
   * kept, and the next save would go through the fail-open with nothing
   * anywhere recording that the protection had been dropped. Absent means
   * "this response says nothing about the study".
   *
   * It exists for a caller that saves repeatedly and cannot reload between
   * saves - the authoring form's autosave. A successful save moves the study's
   * revision, so without this the save after it is refused as stale against
   * its own predecessor.
   */
  linked_study_updated_at?: string;
  // Admin responses only (populated by API joins) - stripped from public/participant responses
  owner_name?: string;
  owner_email?: string;
  sessions?: Session[];
  clicks_total?: number; // Click count for polls/surveys (M6)
  /**
   * The signed-in participant's own completion of THIS study, present only on
   * native survey/poll/one-question responses (the three types that leave no
   * booking) and only when someone is signed in (audit row 10). `completed` is
   * true once they have answered - the detail page then shows the completion
   * and drops the Start button, and the home row reads "Completed" - and false
   * (or the whole object absent) means they can still take part. `completedAt`
   * is the ISO timestamp of that completion, or null.
   */
  completion?: {
    completed: boolean;
    completedAt: string | null;
  };
}

export interface CreateOpportunityRequest {
  type: 'test' | 'poll' | 'survey' | 'question' | 'interview' | 'unmoderated';
  title: string;
  purpose_one_liner: string;
  description_optional?: string;
  product_optional?: string;
  default_duration_minutes?: number;
  external_link_optional?: string;
  firsthand_study_id?: string;
  meeting_location_optional?: string;
  participant_type_required?: 'any' | 'internal' | 'external' | 'specific';
  participant_type_specific_details?: string;
  status?: 'draft' | 'published';
  start_date?: string;
  end_date?: string;
  // Moderated consent (#79): live sessions and interviews only; refused at the
  // route boundary for every other type. The template pair is a claim resolved
  // server-side - see resolveModeratedConsentWrite.
  consent_text?: string;
  consent_template_id?: string | null;
  consent_template_version?: number | null;
}

export interface UpdateOpportunityRequest {
  type?: 'test' | 'poll' | 'survey' | 'question' | 'interview' | 'unmoderated';
  title?: string;
  purpose_one_liner?: string;
  description_optional?: string;
  product_optional?: string;
  default_duration_minutes?: number;
  status?: 'draft' | 'published' | 'closed';
  external_link_optional?: string;
  // Nullable: the column is nullable, the update schema accepts null to clear
  // the link, and the API returns null for an opportunity with no study.
  firsthand_study_id?: string | null;
  meeting_location_optional?: string;
  participant_type_required?: 'any' | 'internal' | 'external' | 'specific';
  participant_type_specific_details?: string;
  start_date?: string;
  end_date?: string;
  // Moderated consent (#79). Null clears the wording, and the handler nulls
  // the template pair with it.
  consent_text?: string | null;
  consent_template_id?: string | null;
  consent_template_version?: number | null;
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
  /**
   * Whether the participant actually took part, and whether a researcher has
   * confirmed it. Returned by GET /bookings/my/bookings (the query is
   * `SELECT b.*`) and by the approvals endpoints, but it was missing from this
   * type, so My Bookings could not show a participant whether the session they
   * attended had been confirmed - which is what AdaptaBits points hang off.
   */
  completion_status?: 'pending' | 'completed' | 'approved' | 'rejected';
  completed_at?: string;
  gcal_event_id?: string;
  cancelled_at?: string;
  reminder_sent_at?: string; // ISO timestamp when reminder email was sent
  /**
   * Consent acceptance (#79 step 1b), written at booking when the opportunity
   * carried consent wording, null otherwise. The pair and the hash pin WHAT
   * was accepted; on both participant projections deliberately - it is the
   * participant's record too.
   */
  consent_accepted_at?: string | null;
  consent_template_id?: string | null;
  consent_template_version?: number | null;
  consent_text_snapshot_hash?: string | null;
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
  opportunity_type: 'test' | 'poll' | 'survey' | 'question' | 'interview' | 'unmoderated';
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

// AuthRequest is Express-specific and should be imported separately in backend
// For frontend compatibility, we don't export it from shared types
// Backend should import it like: import { Request } from 'express'; interface AuthRequest extends Request { user?: SessionUser; }

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
// FORM TYPES
// ============================================================================

export interface OpportunityFormData {
  // Basic Info Tab
  type: 'test' | 'poll' | 'survey' | 'question' | 'interview' | 'unmoderated' | '';
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
  start_date?: string;
  end_date?: string;

  // Task List tab (unmoderated type)
  firsthand_study_id?: string;

  // Questions tab (native poll and survey). Whether the participant answers
  // inside Cortex or is handed off to an external service.
  delivery_mode?: 'native' | 'external';
}

export interface FirstHandStudy {
  id: string;
  title: string;
  intro_text: string;
  consent_text: string;
  brand_name?: string;
  estimated_duration_minutes?: number | null;
  locale?: string;
  status?: 'draft' | 'launched' | 'archived';
  /**
   * Which authoring vocabulary the study is written in, and so which
   * opportunities can run it. Optional only for rows serialised before the
   * column existed; the API always sends it now. The reuse pickers filter on
   * it, and the API refuses a mismatch regardless - the picker is not the
   * boundary.
   */
  kind?: 'recorded' | 'survey';
  // The authoring user. Null on a study created before owners existed: those
  // stay editable by any admin until the first save claims them. See
  // canWriteStudy in backend/src/firsthand/studies-repository.ts.
  owner_user_id?: string | null;
  /**
   * The study whose content was copied to create this one. Authoring
   * provenance only, never an authorisation key - see migration 0012. Present
   * on every study read; null means authored from blank, or the study
   * predates copy-on-select. Write-once at create: nothing can set or clear it
   * on an existing study, which is why UpdateStudyInput does not carry it.
   */
  copied_from_study_id?: string | null;
  /**
   * Which approved consent wording this study runs on: a template id
   * (`recorded-default`, `survey-default`) or the sentinel `custom`, with the
   * version of that template alongside. Null on both means the provenance was
   * never established, and the application reads that as unapproved rather
   * than as approved-by-default - see shared/firsthand/consent-templates.ts
   * and migration 0013.
   *
   * Maintained by the repository from `consent_text` itself. A client may send
   * them as a CLAIM, which is checked against the wording before it is
   * believed; they are not independently writable, because a classification
   * that could be set without the text it describes is a classification that
   * can lie.
   */
  consent_template_id?: string | null;
  consent_template_version?: number | null;
  /**
   * How many authored steps the study has, excluding the machine-appended
   * `end` marker. LIST-ONLY: returned by GET /api/firsthand/studies so the
   * study picker can show a count without loading every study's steps, and
   * deliberately absent from the single-study read, which already returns the
   * steps themselves.
   */
  authored_step_count?: number;
  created_at?: string;
  updated_at?: string;
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
  /** Error object - use errorMessage for string error messages */
  error?: Error | unknown;
  /** Human-readable error message string */
  errorMessage?: string;
  /** Additional error details */
  errorDetails?: { name?: string; message?: string; stack?: string } | Record<string, unknown>;
  [key: string]: unknown;
}

// ============================================================================
// FIRSTHAND INTEGRATION TYPES
// ============================================================================

export interface SessionEvent {
  id: string;
  opportunity_id: string;
  participant_user_id: string | null;
  firsthand_session_id: string;
  event_type: 'session_started' | 'session_completed' | 'session_abandoned' | 'session_failed';
  occurred_at: string;
  payload?: Record<string, unknown>;
  received_at: string;
  participant_name?: string;
  participant_email?: string;
}

export interface MySessionEvent {
  id: string;
  opportunity_id: string;
  opportunity_title: string;
  /** The study format, so My bookings can name it instead of assuming unmoderated. */
  type: OpportunityType;
  firsthand_session_id: string;
  event_type: 'session_started' | 'session_completed' | 'session_abandoned' | 'session_failed';
  occurred_at: string;
  received_at: string;
}

export type FirstHandTranscriptStatus =
  | 'not_requested'
  | 'queued'
  | 'processing'
  | 'complete'
  | 'failed';

/**
 * What a participant is told about a recorded study before they start it,
 * served by GET /api/opportunities/:id/recorded-study-brief.
 *
 * Counts and constants only. It carries no step prompt and no target_url by
 * design: a participant who reads the tasks up front rehearses the route, and
 * the recording captures a performance instead of a first encounter.
 *
 * There is deliberately no duration here. Unmoderated studies have no duration
 * field in the authoring form, so `opportunities.default_duration_minutes`
 * falls to its column default for every one of them - stating that number to a
 * participant above a consent button would be inventing a figure no researcher
 * chose. Add it back when a researcher can actually set it.
 */
export interface RecordedStudyBrief {
  task_count: number;
  records_screen_and_voice: boolean;
  requires_chromium: boolean;
  /**
   * Minutes, or null when the researcher did not state one. Null is the common
   * case for studies authored before the field existed, and it must render as
   * nothing rather than as a number: this figure sits above a consent button.
   */
  estimated_duration_minutes: number | null;
}

export interface FirstHandStepResponse {
  text: string | null;
  selected_option: string | null;
  saved_at: string;
}

export interface FirstHandOutputStep {
  step_id: string;
  order: number;
  type: string;
  prompt: string;
  response: FirstHandStepResponse | null;
}

export interface FirstHandTranscriptSegment {
  id: string;
  step_id: string | null;
  speaker: 'system' | 'participant';
  speaker_label: string;
  text: string;
  timestamp: string;
}

export interface FirstHandTranscript {
  body: string;
  created_at: string;
  source: string;
  segments: FirstHandTranscriptSegment[];
}

export interface FirstHandAssetMeta {
  asset_id: string;
  file_name: string;
  mime_type: string;
  file_size_bytes: number;
  duration_seconds: number | null;
  uploaded_at: string;
  /** Short-lived signed media URL (HMAC, ~15 min TTL) for inline playback; null when the asset is not playable */
  media_url: string | null;
}

export interface FirstHandSessionAttempt {
  attempt_number: number;
  session_id: string;
  session_status: string;
  started_at: string | null;
  completed_at: string | null;
  transcript_status: FirstHandTranscriptStatus;
}

export interface FirstHandSessionOutputs {
  contract_version: string;
  session: {
    session_id: string;
    logical_session_id: string;
    attempt_number: number;
    study_id: string;
    study_title: string;
    participant: { participant_id: string; display_name: string };
    session_status: string;
    started_at: string | null;
    completed_at: string | null;
    transcript_status: FirstHandTranscriptStatus;
    transcript_failure_message: string | null;
  };
  attempts: FirstHandSessionAttempt[];
  steps: FirstHandOutputStep[];
  transcript: FirstHandTranscript | null;
  assets: FirstHandAssetMeta[];
}

// ============================================================================
// BOOKING ARTEFACTS (#79) - recordings and transcripts of a moderated session,
// ingested by the researcher after the call
// ============================================================================

export type BookingArtifactKind = 'recording' | 'transcript';

/**
 * One row of GET /api/bookings/:bookingId/artifacts, and the 201 body of
 * finalize. This is the whole wire shape by design: `relative_path` and `etag`
 * never leave the server (the media route mints URLs and verifies integrity
 * server-side), so a field added here must also be added to
 * `serializeArtifact` in backend/src/routes/booking-artifacts.ts - the map is
 * field-by-field precisely so a new column does not ride along unreviewed.
 */
export interface BookingArtifact {
  id: string;
  booking_id: string;
  kind: BookingArtifactKind;
  file_name: string;
  mime_type: string;
  file_size_bytes: number;
  uploaded_by: string | null;
  /**
   * The uploader's display name, joined at list time; null when the uploader
   * row is gone or the response (e.g. finalize's 201) did not join users.
   * Callers wanting a name after an upload re-list rather than patching one in.
   */
  uploaded_by_name: string | null;
  uploaded_at: string | null;
  consent_attested_by: string | null;
  consent_attested_at: string | null;
  consent_attestation_reason: string | null;
}

/** What POST /api/bookings/:bookingId/artifacts/presign answers with. */
export interface BookingArtifactPresignResponse {
  mode: 's3';
  objectKey: string;
  uploadUrl: string;
  validUntil: string;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

export type OpportunityType = 'test' | 'poll' | 'survey' | 'question' | 'interview' | 'unmoderated';
