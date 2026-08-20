import { z } from 'zod';
import { CreateSessionRequest, UpdateSessionRequest } from '../types';
import { SESSION_CAPACITY } from '../../../shared/constants';
import { inlineStudySchema } from '../../../shared/firsthand/inline-study';
import { inlineSurveySchema } from '../../../shared/firsthand/survey-authoring';
import {
  EXTERNAL_LINK_PROTOCOL_MESSAGE,
  MEETING_LOCATION_SCHEME_MESSAGE,
  isPublishableExternalLink,
  isSafeMeetingLocation
} from '../../../shared/firsthand/url-safety';
import type { Opportunity } from '../../../shared/types';

// Base schemas
export const UUIDSchema = z.string().uuid();
export const EmailSchema = z.string().email();
export const NonEmptyStringSchema = z.string().min(1);

// User schemas
export const UserSchema = z.object({
  id: UUIDSchema,
  name: NonEmptyStringSchema,
  email: EmailSchema,
  business_unit: z.string().optional(),
  role_title: z.string().optional(),
  role: z.enum(['employee', 'researcher_admin', 'superadmin']),
  created_at: z.string().datetime(),
});

export const SessionUserSchema = z.object({
  id: UUIDSchema,
  name: NonEmptyStringSchema,
  email: EmailSchema,
  business_unit: z.string().optional(),
  role_title: z.string().optional(),
  role: z.enum(['employee', 'researcher_admin', 'superadmin']),
});

// Opportunity schemas
export const OpportunityTypeSchema = z.enum(['test', 'poll', 'survey', 'question', 'interview', 'unmoderated']);
export const OpportunityStatusSchema = z.enum(['draft', 'published', 'closed']);
export const ParticipantTypeSchema = z.enum(['any', 'internal', 'external', 'specific']);

/**
 * Whether a poll or survey runs inside Cortex or hands off to an external
 * service. Ignored by every other type. Absent means external, matching both
 * the column default and every poll and survey that existed before the choice
 * did.
 */
export const DeliveryModeSchema = z.enum(['native', 'external']);

export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

/**
 * The same vocabulary is declared twice - as this enum, which is the gate, and
 * as a union on the shared Opportunity type, which is the published contract.
 * They cannot be one declaration: shared/types is flattened when it is copied
 * to the frontend, so it carries no zod. This assertion fails the build if the
 * two ever disagree, which is the part a comment cannot do.
 */
type SharedDeliveryMode = NonNullable<Opportunity['delivery_mode']>;
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
export const DELIVERY_MODE_MATCHES_SHARED_CONTRACT: MutuallyAssignable<
  DeliveryMode,
  SharedDeliveryMode
> = true;

// Trimmed BEFORE the length checks, not after.
//
// The handlers already store `title.trim()`, so validating the untrimmed value
// let "    " satisfy min(4) and reach storage as ''. For an unmoderated
// opportunity those two fields become the study's title and intro_text, which
// the session contract requires at min(1) - so an all-whitespace title produced
// a study that assembled no session and 500'd every participant who started it.
/**
 * A link this product will hand a participant, checked for its SCHEME as well
 * as its shape.
 *
 * `z.string().url()` is not a protocol check. On zod 3 it accepts
 * `javascript:alert(1)`, `data:text/html,...` and `vbscript:` - all of which
 * parse as URLs - and this field is rendered straight into an `href` on the
 * participant-facing opportunity page. A `researcher_admin` could therefore
 * store script in the Cortex origin and have it run when a participant clicked
 * the call to action. Confirmed by request: `POST /api/opportunities` with
 * `{ type: 'question', status: 'published', external_link_optional:
 * 'javascript:alert(document.domain)' }` returned **201**, and the value came
 * back rendered as `<a href="javascript:...">Answer Question</a>`.
 *
 * ONE accident stopped it executing, not two, and the correction matters: I
 * first wrote that helmet's default CSP was the second. It is not. helmet is
 * mounted on the BACKEND (`backend/src/index.ts`), and the participant page is
 * served by `frontend/nginx.conf`, which sets four security headers and NO
 * Content-Security-Policy - in every environment. So the only thing standing
 * there was Chrome refusing a `javascript:` navigation to `target="_blank"`.
 * Removing that one attribute in the page made the alert fire immediately, with
 * `document.domain` reading the app's own origin.
 *
 * A markup attribute is not a security control, and there was nothing behind
 * it. That is the whole reason this guard is at the boundary rather than left
 * to the browser.
 *
 * Defined once and shared by the create and update schemas so the two cannot
 * drift, which is how one of them would end up the weaker boundary.
 */
/**
 * A session's location, which is EITHER a joining link or a plain place.
 *
 * Not required to be a URL - "Room 3B" and "Zoom, see calendar invite" are
 * ordinary values here, and requiring a URL would refuse every room-number
 * booking. The rule is only that it must not be an EXECUTABLE one.
 *
 * This field had no validation at all, and `MyBookings` decided whether to
 * render it as an `href` with a SUBSTRING test - `str.includes("meet.google.com")`
 * - so `javascript:alert(document.cookie)//meet.google.com` was stored happily
 * and rendered as a link labelled "Join via Google Meet", the `//` turning the
 * allowlisted host into a JavaScript comment. Set once by a researcher on a
 * session, seen by every participant who booked it. Found by the security gate
 * on the external-link fix: the same defect class, one field over.
 */
const meetingLocationSchema = z
  .string()
  .refine(isSafeMeetingLocation, { message: MEETING_LOCATION_SCHEME_MESSAGE });

const externalLinkSchema = z
  .string()
  .url()
  .refine(isPublishableExternalLink, { message: EXTERNAL_LINK_PROTOCOL_MESSAGE });

export const CreateOpportunitySchema = z.object({
  type: OpportunityTypeSchema,
  title: z.string().trim().min(4).max(140),
  purpose_one_liner: z.string().trim().min(10).max(180),
  description_optional: z.string().optional(),
  product_optional: z.string().optional(),
  meeting_location_optional: z.string().optional(),
  default_duration_minutes: z.number().int().min(5).max(240).optional(),
  external_link_optional: externalLinkSchema.optional(),
  delivery_mode: DeliveryModeSchema.optional(),
  firsthand_study_id: z.string().min(1).optional(),
  // Unmoderated only: the study's content authored on the opportunity form
  // itself. The handler creates the study from this and links it, so the author
  // never has to create and launch one separately. Sending it alongside
  // firsthand_study_id is rejected, not resolved by precedence.
  inline_study: inlineStudySchema.optional(),
  // Native poll and survey only: the questions authored on the opportunity
  // form itself, the survey counterpart of inline_study. Same rules - the
  // handler creates the study from this and links it, and a body carrying both
  // this and firsthand_study_id is refused rather than resolved by precedence.
  inline_survey: inlineSurveySchema.optional(),
  participant_type_required: ParticipantTypeSchema.optional(),
  participant_type_specific_details: z.string().optional(),
  status: z.enum(['draft', 'published']).optional(),
  start_date: z.string().datetime().optional().nullable(),
  end_date: z.string().datetime().optional().nullable(),
});

export const UpdateOpportunitySchema = z.object({
  type: OpportunityTypeSchema.optional(),
  title: z.string().trim().min(4).max(140).optional(),
  purpose_one_liner: z.string().trim().min(10).max(180).optional(),
  description_optional: z.string().optional(),
  product_optional: z.string().optional(),
  meeting_location_optional: z.string().optional(),
  default_duration_minutes: z.number().int().min(5).max(240).optional(),
  external_link_optional: externalLinkSchema.optional(),
  delivery_mode: DeliveryModeSchema.optional(),
  firsthand_study_id: z.string().min(1).optional().nullable(),
  // Unmoderated only, and only when the opportunity has no study yet. Saving a
  // draft before writing any tasks is legitimate, so the author has to be able
  // to write them on the way back in - otherwise the errand this feature
  // removes reappears for exactly that path.
  inline_study: inlineStudySchema.optional(),
  // Same as create, and only where the opportunity has no questions yet: saving
  // a draft before writing them is legitimate, so they have to be writable on
  // the way back in.
  inline_survey: inlineSurveySchema.optional(),
  participant_type_required: ParticipantTypeSchema.optional(),
  participant_type_specific_details: z.string().optional(),
  status: OpportunityStatusSchema.optional(),
  start_date: z.string().datetime().optional().nullable(),
  end_date: z.string().datetime().optional().nullable(),
});

export const OpportunitySchema = z.object({
  id: UUIDSchema,
  type: OpportunityTypeSchema,
  title: NonEmptyStringSchema,
  purpose_one_liner: NonEmptyStringSchema,
  description_optional: z.string().optional(),
  product_optional: z.string().optional(),
  meeting_location_optional: z.string().optional(),
  default_duration_minutes: z.number().int().min(5).max(240),
  status: OpportunityStatusSchema,
  owner_user_id: UUIDSchema,
  // Pointed at the guarded field even though nothing reads this schema today.
  // It is NAMED as if it were the canonical opportunity shape, so the next route
  // that reaches for it would otherwise get no scheme check and no `.url()`
  // either.
  external_link_optional: externalLinkSchema.optional(),
  delivery_mode: DeliveryModeSchema.optional(),
  participant_type_required: ParticipantTypeSchema.optional(),
  participant_type_specific_details: z.string().optional(),
  start_date: z.string().datetime().optional().nullable(),
  end_date: z.string().datetime().optional().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// Session schemas
export const CreateSessionSchema = z.object({
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
  capacity: z.number().int().min(SESSION_CAPACITY.MIN).max(SESSION_CAPACITY.MAX),
  location_or_meet_link_optional: meetingLocationSchema.optional(),
}).refine(
  (data) => new Date(data.end_time) > new Date(data.start_time),
  {
    message: "End time must be after start time",
    path: ["end_time"],
  }
);

// Schema for batch session creation (used in POST /api/sessions)
export const CreateSessionsSchema = z.object({
  opportunity_id: UUIDSchema,
  sessions: z.array(CreateSessionSchema).min(1, "At least one session is required"),
});

export const UpdateSessionSchema = z.object({
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional(),
  capacity: z.number().int().min(SESSION_CAPACITY.MIN).max(SESSION_CAPACITY.MAX).optional(),
  location_or_meet_link_optional: meetingLocationSchema.optional(),
}).refine(
  (data) => {
    if (data.start_time && data.end_time) {
      return new Date(data.end_time) > new Date(data.start_time);
    }
    return true;
  },
  {
    message: "End time must be after start time",
    path: ["end_time"],
  }
);

export const SessionSchema = z.object({
  id: UUIDSchema,
  opportunity_id: UUIDSchema,
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
  capacity: z.number().int().min(SESSION_CAPACITY.MIN).max(SESSION_CAPACITY.MAX),
  booked_count: z.number().int().min(0),
  location_or_meet_link_optional: meetingLocationSchema.optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  remaining: z.number().int().optional(),
});

/**
 * Validate session data without Zod (for legacy code paths)
 * Returns array of error messages, empty if valid
 */
export const validateSessionData = (data: CreateSessionRequest | UpdateSessionRequest): string[] => {
  const errors: string[] = [];
  
  if ('start_time' in data && data.start_time !== undefined) {
    const startTime = new Date(data.start_time);
    if (isNaN(startTime.getTime())) {
      errors.push('Start time must be a valid ISO date string');
    }
  }
  
  if ('end_time' in data && data.end_time !== undefined) {
    const endTime = new Date(data.end_time);
    if (isNaN(endTime.getTime())) {
      errors.push('End time must be a valid ISO date string');
    }
  }
  
  if ('start_time' in data && 'end_time' in data && 
      data.start_time !== undefined && data.end_time !== undefined) {
    const startTime = new Date(data.start_time);
    const endTime = new Date(data.end_time);
    if (startTime >= endTime) {
      errors.push('End time must be after start time');
    }
  }
  
  if ('capacity' in data && data.capacity !== undefined) {
    if (!Number.isInteger(data.capacity) || 
        data.capacity < SESSION_CAPACITY.MIN || 
        data.capacity > SESSION_CAPACITY.MAX) {
      errors.push(`Capacity must be an integer between ${SESSION_CAPACITY.MIN} and ${SESSION_CAPACITY.MAX}`);
    }
  }

  /*
   * The location's SCHEME, checked HERE rather than only on the zod schemas
   * above - because this hand-rolled validator is the one that actually runs.
   *
   * `POST /api/opportunities/:id/sessions` calls `validateSessionData`;
   * `CreateSessionsSchema` is imported by that route and never used, which is
   * one of the pre-existing unused-vars this file's suppression entry counts. I
   * hardened the zod schemas first and the four exploit tests still returned
   * 404-then-201: the fix was applied to code nothing reads. The schemas are
   * hardened too, so that adopting them is safe, but this is the boundary.
   *
   * Not required to be a URL - the field holds "Room 3B" as often as a joining
   * link - only required not to be executable. See `isSafeMeetingLocation`.
   */
  if (
    'location_or_meet_link_optional' in data &&
    data.location_or_meet_link_optional !== undefined &&
    !isSafeMeetingLocation(data.location_or_meet_link_optional)
  ) {
    errors.push(MEETING_LOCATION_SCHEME_MESSAGE);
  }

  return errors;
};

// Booking schemas
export const BookingStatusSchema = z.enum(['booked', 'cancelled']);

export const BookingSchema = z.object({
  id: UUIDSchema,
  user_id: UUIDSchema,
  session_id: UUIDSchema,
  status: BookingStatusSchema,
  gcal_event_id: z.string().optional(),
  cancelled_at: z.string().datetime().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const RescheduleBookingSchema = z.object({
  target_session_id: UUIDSchema,
});

// Query parameter schemas
export const OpportunityQuerySchema = z.object({
  type: z.string().optional().transform(val => val === '' ? undefined : val).pipe(OpportunityTypeSchema.optional()),
  q: z.string().optional().transform(val => val === '' ? undefined : val),
  status: z.string().optional().transform(val => val === '' ? undefined : val).pipe(OpportunityStatusSchema.optional()),
});

export const SessionQuerySchema = z.object({
  from: z.string().datetime().optional(),
  include_past: z.string().transform(val => val === 'true').optional(),
});

// Response schemas
export const ErrorResponseSchema = z.object({
  error: NonEmptyStringSchema,
  details: z.array(z.string()).optional(),
});

export const SuccessResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
});

// Validation middleware helper
export const validateRequest = <T>(schema: z.ZodSchema<T>) => {
  return (req: any, res: any, next: any) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation failed',
          details: error.errors.map(err => `${err.path.join('.')}: ${err.message}`),
        });
      }
      next(error);
    }
  };
};

export const validateQuery = <T>(schema: z.ZodSchema<T>) => {
  return (req: any, res: any, next: any) => {
    try {
      req.query = schema.parse(req.query);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Invalid query parameters',
          details: error.errors.map(err => `${err.path.join('.')}: ${err.message}`),
        });
      }
      next(error);
    }
  };
};
