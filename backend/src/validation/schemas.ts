import { z } from 'zod';
import { CreateSessionRequest, UpdateSessionRequest } from '../types';
import { SESSION_CAPACITY, VALIDATION } from '../../../shared/constants';
import { inlineStudySchema } from '../../../shared/firsthand/inline-study';
import { inlineSurveySchema } from '../../../shared/firsthand/survey-authoring';
import {
  EXTERNAL_LINK_PROTOCOL_MESSAGE,
  MEETING_LOCATION_SCHEME_MESSAGE,
  isPublishableExternalLink,
  isSafeMeetingLocation
} from '../../../shared/firsthand/url-safety';
import { screenerSchema } from '../../../shared/screener';
import { targetRolesSchema } from '../../../shared/target-roles';
import type { Opportunity, Screener } from '../../../shared/types';

// Base schemas
export const UUIDSchema = z.string().uuid();

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

/**
 * Same guard for the screener. The zod shape (screenerSchema, in shared/screener)
 * and the shared Screener interface are declared separately and this assertion
 * fails the build if the two ever disagree.
 */
export const SCREENER_MATCHES_SHARED_CONTRACT: MutuallyAssignable<
  z.infer<typeof screenerSchema>,
  Screener
> = true;

/**
 * Same guard for the display-only roles/skills field. The zod shape
 * (targetRolesSchema, in shared/target-roles) and the shared field type are
 * declared separately; this fails the build if they ever disagree.
 */
export const TARGET_ROLES_MATCHES_SHARED_CONTRACT: MutuallyAssignable<
  z.infer<typeof targetRolesSchema>,
  NonNullable<Opportunity['target_roles']>
> = true;

/**
 * The body of PATCH /api/me/profile - the caller updating their OWN roles/skills
 * profile. It reuses `targetRolesSchema` verbatim (same trim/caps/dedupe and the
 * same curated vocabulary) so the profile and an opportunity's target_roles are
 * one vocabulary, which is what makes matching a straight intersection. `null`
 * (or an empty list, which the store collapses to null) clears the profile.
 * `.strict()` so an unexpected field is a 400, not silently ignored - this route
 * writes only the caller's own row and should accept only the one field.
 */
export const profileUpdateSchema = z
  .object({
    profile_roles: targetRolesSchema.nullable(),
  })
  .strict();

export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

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
  // Moderated consent (#79): live sessions and interviews only, refused for
  // every other type at the route boundary (the schema cannot see the type on
  // PATCH, so the rule lives with the handler's other type rules). The
  // template pair is a CLAIM about which approved wording consent_text is,
  // resolved server-side exactly as the studies path resolves its own - the
  // stored value comes from resolution, never from the client.
  consent_text: z
    .string()
    .trim()
    .min(1)
    .max(VALIDATION.MAX_MODERATED_CONSENT_CHARS)
    .optional(),
  consent_template_id: z.string().max(64).optional().nullable(),
  consent_template_version: z.number().int().min(1).optional().nullable(),
  participant_type_required: ParticipantTypeSchema.optional(),
  participant_type_specific_details: z.string().optional(),
  // Structured, display-only advertised audience ("roles/skills wanted").
  // Trimmed, capped and deduped by targetRolesSchema. Public - no redaction.
  // Stored as JSONB on the opportunity.
  target_roles: targetRolesSchema.optional(),
  // Eligibility screener. Absent means no screener; when present it must pass
  // screenerSchema (at least one question, a way to pass each, a screen-out
  // somewhere). The handler stores it as JSONB on the opportunity.
  screener: screenerSchema.optional(),
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
  /**
   * Optimistic-concurrency precondition for the LINKED STUDY, not for the
   * opportunity: the `updated_at` the form was served when it loaded that
   * study, echoed back so an in-place rewrite can be refused with 409 rather
   * than silently overwriting a colleague.
   *
   * DECLARED, and that is the whole reason this line exists. This schema is
   * `z.object`, not strict, so an undeclared key is stripped in silence - the
   * precondition would simply never arrive, the write would proceed under the
   * fail-open, and nothing anywhere would say so. A silently-dropped safety
   * field is worse than an absent one.
   *
   * The PATCH handler destructures it out of the body before the generic field
   * loop, which maps every remaining key straight to a column name.
   *
   * `offset: true` accepts both the `Z` the API serves and a `+00:00` a client
   * may have round-tripped it into.
   */
  expected_study_updated_at: z.string().datetime({ offset: true }).optional(),
  // Moderated consent (#79) - same rules as create, plus null to CLEAR:
  // removing consent from a draft is legitimate authoring, and the handler
  // nulls the template pair with it so the row cannot claim a template for
  // wording it no longer holds.
  consent_text: z
    .string()
    .trim()
    .min(1)
    .max(VALIDATION.MAX_MODERATED_CONSENT_CHARS)
    .optional()
    .nullable(),
  consent_template_id: z.string().max(64).optional().nullable(),
  consent_template_version: z.number().int().min(1).optional().nullable(),
  participant_type_required: ParticipantTypeSchema.optional(),
  participant_type_specific_details: z.string().optional(),
  // Structured, display-only advertised audience ("roles/skills wanted"). Null
  // clears it; an array replaces it wholesale after passing targetRolesSchema.
  target_roles: targetRolesSchema.optional().nullable(),
  // Eligibility screener. Null clears it (removes the screener); an object
  // replaces it wholesale after passing screenerSchema.
  screener: screenerSchema.optional().nullable(),
  status: OpportunityStatusSchema.optional(),
  start_date: z.string().datetime().optional().nullable(),
  end_date: z.string().datetime().optional().nullable(),
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

/**
 * THE MOST TIME WINDOWS ONE REQUEST MAY CARRY.
 *
 * cto/AdaptaLabs#22. Three routes accept an array of time windows and NONE of
 * them bounded its length:
 *
 *   `POST /api/sessions`                        - `sessions`
 *   `POST /api/opportunities/:id/sessions`      - the body, array or single
 *   `POST /api/calendar/check-conflicts`        - `time_slots`
 *
 * The only thing stopping a million-element array was `express.json()`'s 100 kB
 * default body limit, which nobody chose and which moves the moment somebody
 * raises it for an unrelated reason. That is an accident, not a control - so
 * `backend/src/index.ts` now names its limit explicitly and this names the one
 * that actually belongs to the payload.
 *
 * ONE CONSTANT FOR ALL THREE because they are one batch of time windows at
 * three stages - checked for conflicts, then created against an opportunity -
 * authored by the same admin in the same UI. Three numbers would drift, and
 * this file has already watched a per-route bound drift once.
 *
 * WHAT EACH COSTS PER ELEMENT, which is why the number is not larger:
 * `POST /api/sessions` runs one overlap query AND one INSERT per element,
 * sequentially and OUTSIDE a transaction; `/opportunities/:id/sessions` runs an
 * O(N^2) in-memory overlap scan; `check-conflicts` spreads the array into
 * `Math.min(...)`, which is an argument list and so has a real engine ceiling
 * somewhere above this.
 *
 * 200. A study's slot batch is a working week or two of appointments - a month
 * of half-hour slots over an eight-hour day is about 320, and nothing in the
 * product authors that in one request today. All three routes are `requireAdmin`,
 * so this bounds an authenticated colleague's mistake rather than an attack.
 *
 * REFUSES rather than taking the first 200: silently creating part of a batch
 * would leave an admin's calendar half-populated with nothing saying which half.
 * The caller's recourse is obvious - send fewer - so a 400 is actionable.
 *
 * Written as a NUMBER HERE and asserted as the same number in the tests rather
 * than derived from this constant.
 */
export const MAX_TIME_SLOTS_PER_REQUEST = 200;

/**
 * Validate session data without Zod (for legacy code paths)
 * Returns array of error messages, empty if valid
 *
 * NO future-time rule HERE, on purpose: this validator is shared with the
 * UPDATE path (routes/sessions.ts PATCH, plus the create sites), where
 * refusing a past instant would wrongly block editing a session that has
 * already started - correcting a capacity or a meeting link mid-session is
 * legitimate. The create-only rule lives in `validateNewSessionData` below
 * (cto/AdaptaLabs#90), which every CREATE site calls instead.
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
   * `POST /api/opportunities/:id/sessions` calls `validateNewSessionData`;
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

/**
 * How far in the past a NEW session's start may lie, in milliseconds.
 *
 * Not zero, deliberately: a researcher picking "now" from the UI, plus a
 * request in flight, plus ordinary clock skew between browser and server,
 * must not be refused for arriving seconds late. One minute absorbs all of
 * that; a session genuinely authored for the past is hours or days out.
 * Pinned as a literal in sessions.create-refuses-the-past.test.ts.
 */
export const NEW_SESSION_PAST_GRACE_MS = 60_000;

/**
 * The CREATE-ONLY session validator: everything `validateSessionData` checks,
 * plus required time fields, plus the rule that a new session must not start
 * in the past.
 *
 * cto/AdaptaLabs#90. The future-time rule was browser-only (the manual
 * add-slot control in AdminSessionManager), so both create routes accepted a
 * 1999 session from an authenticated admin's direct call. That was WORSE
 * than clutter: the booking route's temporal guard reads `end_time`
 * (bookings.ts, `new Date(session.end_time) <= new Date()`), so a session
 * with a past start and a future end was fully BOOKABLE - the security gate
 * demonstrated it, correcting an earlier claim here that bookings refused a
 * past start. A separate function rather than a flag, because the shared
 * validator serves the UPDATE path where a past start already on a session
 * is legitimate, and a boolean argument is the shape that gets pasted
 * wrongly.
 *
 * Required-and-typed HERE rather than in the shared validator, because on
 * UPDATE an absent field means "unchanged" while on CREATE it used to mean a
 * 500 from the NOT NULL constraint. A non-string gets the same sentence as
 * an unparseable string: `new Date(null)` is the epoch, not NaN, so without
 * the type check `null` would earn the past-start sentence instead of a type
 * error.
 *
 * NaN needs no guard on the past-start comparison - NaN < x is false for
 * every x, so an unparseable string is refused once, by the shared
 * validator's own arm, and never double-reported. (A review gate proved an
 * explicit isNaN clause here inert by deleting it under the full suite.)
 */
export const validateNewSessionData = (data: CreateSessionRequest): string[] => {
  const errors: string[] = [];

  for (const [field, label] of [
    ['start_time', 'Start time'],
    ['end_time', 'End time'],
  ] as const) {
    const value = (data as unknown as Record<string, unknown>)[field];
    if (value === undefined) {
      errors.push(`${label} is required`);
    } else if (typeof value !== 'string') {
      errors.push(`${label} must be a valid ISO date string`);
    }
  }
  if (errors.length > 0) {
    return errors;
  }

  errors.push(...validateSessionData(data));

  const start = new Date(data.start_time);
  if (start.getTime() < Date.now() - NEW_SESSION_PAST_GRACE_MS) {
    errors.push('Start time must not be in the past');
  }

  return errors;
};

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

/**
 * QUERY-SHAPE SCHEMAS for the routes that read `req.query` directly
 * (cto/AdaptaLabs#43).
 *
 * Express parses `?x=a&x=b` into a string ARRAY and `?x[foo]=bar` into an
 * OBJECT, so `req.query.x as string` asserts something the parser does not
 * promise. Each schema below says only what the route actually relies on:
 * every parameter is an OPTIONAL BARE STRING. Required-ness, format and
 * range stay in the routes, which already own those refusals and their
 * response wording - the schema's job is the SHAPE, so an array or object
 * is refused at the boundary instead of becoming a dropped WHERE filter, a
 * pg type error 500, or a comma-joined value nobody chose.
 *
 * `z.object` (non-strict) also strips keys a route never reads, so a
 * validated `req.query` holds exactly the parameters listed here.
 *
 * `query-reads-go-through-a-validator.test.ts` is the structural scan that
 * fails when a route segment reads `req.query` without naming a mechanism;
 * the per-route `.query-shapes` suites prove each mounting behaviourally.
 */

/** GET /api/admin/requests - the cosmetic status display filter. */
export const adminRequestsQuerySchema = z.object({
  status: z.string().optional(),
});

/**
 * GET /api/admin/dashboard - the "Show all researchers" scope toggle (Decision
 * 2). A bare optional string for the SHAPE; the route owns which values mean
 * what ('all' widens, 'mine' scopes to the caller, anything else is the role
 * default), so a stray value is inert rather than a 400.
 */
export const adminDashboardQuerySchema = z.object({
  scope: z.string().optional(),
});

/** DELETE /api/admin/admins - the target user id. */
export const adminRevokeAdminQuerySchema = z.object({
  id: z.string().optional(),
});

/**
 * The two OAuth callback landings: GET /auth/google-callback (unauthenticated)
 * and GET /api/calendar/auth/callback. Same two parameters, same shape rule.
 */
export const oauthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
});

/** GET /api/calendar/my-events - the caller's own conflict window. */
export const userCalendarEventsQuerySchema = z.object({
  start_time: z.string().optional(),
  end_time: z.string().optional(),
});

/** GET /api/calendar/events - admin calendar read, ownership-gated in-route. */
export const calendarEventsQuerySchema = z.object({
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  calendar_id: z.string().optional(),
});

/** GET /api/calendar/availability. */
export const calendarAvailabilityQuerySchema = z.object({
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  duration_minutes: z.string().optional(),
  calendar_id: z.string().optional(),
  exclude_weekends: z.string().optional(),
});
