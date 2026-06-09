import { z } from 'zod';
import { CreateSessionRequest, UpdateSessionRequest } from '../types';
import { SESSION_CAPACITY } from '../../../shared/constants';

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

export const CreateOpportunitySchema = z.object({
  type: OpportunityTypeSchema,
  title: z.string().min(4).max(140),
  purpose_one_liner: z.string().min(10).max(180),
  description_optional: z.string().optional(),
  product_optional: z.string().optional(),
  meeting_location_optional: z.string().optional(),
  default_duration_minutes: z.number().int().min(5).max(240).optional(),
  external_link_optional: z.string().url().optional(),
  firsthand_study_id: z.string().min(1).optional(),
  participant_type_required: ParticipantTypeSchema.optional(),
  participant_type_specific_details: z.string().optional(),
  status: z.enum(['draft', 'published']).optional(),
  start_date: z.string().datetime().optional().nullable(),
  end_date: z.string().datetime().optional().nullable(),
});

export const UpdateOpportunitySchema = z.object({
  type: OpportunityTypeSchema.optional(),
  title: z.string().min(4).max(140).optional(),
  purpose_one_liner: z.string().min(10).max(180).optional(),
  description_optional: z.string().optional(),
  product_optional: z.string().optional(),
  meeting_location_optional: z.string().optional(),
  default_duration_minutes: z.number().int().min(5).max(240).optional(),
  external_link_optional: z.string().url().optional(),
  firsthand_study_id: z.string().min(1).optional().nullable(),
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
  external_link_optional: z.string().optional(),
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
  location_or_meet_link_optional: z.string().optional(),
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
  location_or_meet_link_optional: z.string().optional(),
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
  location_or_meet_link_optional: z.string().optional(),
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
