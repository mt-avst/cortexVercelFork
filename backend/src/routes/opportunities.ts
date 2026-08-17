import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

import { pool } from '../config';
import { requireAdmin, requireAuth, optionalAuth } from '../middleware/authenticate';
import { getMockOpportunities, getMockOpportunity, addMockOpportunity, updateMockOpportunity, deleteMockOpportunity, addMockSessions, getMockSessions } from '../../../demo/mock-data';
import { logger } from '../utils/logger';
import { isDatabaseAvailable } from '../utils/database';
import { 
  CreateOpportunitySchema, 
  UpdateOpportunitySchema, 
  CreateSessionsSchema,
  validateRequest,
  validateSessionData
} from '../validation/schemas';
import { AppError, ValidationError, NotFoundError, ForbiddenError, asyncHandler } from '../utils/errorHandler';
import { toPublicOpportunity, toPublicSession } from '../utils/publicOpportunity';
import { createSession } from '../firsthand/session-create';
import { findParticipantSessionForOpportunity } from '../firsthand/runtime-repository';
import { listResponsesForOpportunity } from '../firsthand/survey-results-repository';
import { aggregateSurveyResults } from '../firsthand/survey-results';
import { toCsvContentDisposition, toResponsesCsv } from '../firsthand/survey-csv';
import {
  claimStudyIfUnowned,
  countStudyTasks,
  createStudy,
  getStudyById,
  deleteStudyUnchecked,
  isStudiesPersistenceConfigured
} from '../firsthand/studies-repository';
import type { RecordedStudyBrief } from '../../../shared/types';
import type { StudyStep } from '../../../shared/firsthand/contract';
import { toStudySteps, type InlineStudy } from '../../../shared/firsthand/inline-study';
import { toSurveySteps, type InlineSurvey } from '../../../shared/firsthand/survey-authoring';
import type { StudyKind } from '../../../shared/firsthand/study-input';
import type { DeliveryMode } from '../validation/schemas';
import { autoCloseOpportunityIfNeeded } from '../utils/opportunityLifecycle';
import { ANALYTICS_TIME_ZONE, toAnalyticsDateString, weekOverWeekChange } from '../utils/analytics-dates';
import { resolveStudyDuration } from '../firsthand/study-duration';

import { Opportunity, CreateOpportunityRequest, UpdateOpportunityRequest, Session, CreateSessionRequest } from '../types';

const router: Router = Router();

// Shared by the create and update publish guards. Both endpoints accept an
// inline study, and the guard only fires when no study is linked - which is
// exactly when authoring one is available - so the same wording is correct at
// both sites.
const UNMODERATED_STUDY_REQUIRED =
  'Add at least one prompt to the task list, or link an existing task list, before publishing';

/**
 * The native counterpart. A poll or survey delivered inside Cortex has no
 * external link to require, so what it needs instead is the questions.
 */
export const NATIVE_SURVEY_STUDY_REQUIRED =
  'Add questions, or link an existing set of questions, before publishing';

/**
 * Which study vocabulary an opportunity of this shape can run.
 *
 * An `unmoderated` opportunity runs the recorded runner, which draws no widget
 * for a rating or a multi-choice and stores nothing for them. A native poll or
 * survey runs SurveyRunner, which has no recording, no task window and nothing
 * to do with a step carrying a page to open. Linking the wrong one produces a
 * participant-facing screen that looks authored and collects nothing.
 *
 * Checked at the API boundary rather than only in the picker, because the
 * picker is not the boundary: create and update both accept
 * `firsthand_study_id` from the body, so a hand-crafted call bypasses any
 * amount of UI filtering.
 */
const requiredStudyKindFor = (
  type: string,
  deliveryMode: string
): StudyKind | null => {
  if (type === 'unmoderated') return 'recorded';
  if ((type === 'poll' || type === 'survey') && deliveryMode === 'native') {
    return 'survey';
  }
  // Every other shape links no study at all.
  return null;
};

/**
 * Exported so a test can assert on the exact message rather than on a word.
 * Both refusals originally named BOTH vocabularies, so a matcher for "survey"
 * or "task list" matched either one - swapping the two record values left every
 * refusal stating the opposite of what happened and all seven tests still
 * green. Keyed by the kind that was REQUIRED, which is what the reader needs.
 */
export const STUDY_KIND_MISMATCH: Record<StudyKind, string> = {
  recorded:
    'This opportunity needs a recorded task list, and that is a set of survey questions',
  survey:
    'This opportunity needs a set of survey questions, and that is a recorded task list'
};

/**
 * Refuses a linked study whose vocabulary does not match the opportunity.
 *
 * Silent on a study that cannot be read - persistence unconfigured, or a study
 * id that resolves to nothing. Neither is this check's job: the first is a
 * deployment without the runtime database, and the second is already handled
 * where a missing study surfaces to the participant. Failing the save here
 * would turn both into a confusing validation error about question types.
 */
async function assertLinkedStudyKindMatches(
  studyId: string,
  type: string,
  deliveryMode: string
): Promise<void> {
  const required = requiredStudyKindFor(type, deliveryMode);

  if (!required || !isStudiesPersistenceConfigured()) {
    return;
  }

  const stored = await getStudyById(studyId);

  // An id resolving to nothing is refused, not skipped. Skipping made the whole
  // check optional: link an id that does not exist yet, then create a study at
  // that exact id with whichever vocabulary you like - POST /api/firsthand/
  // studies takes a client-supplied id. Two calls, demonstrated end to end.
  // There is no legitimate case for linking a study that is not there: it fails
  // at participant start time instead, which is a worse place to find out.
  if (!stored) {
    throw new ValidationError('That task list could not be found');
  }

  if (stored.study.kind !== required) {
    throw new ValidationError(STUDY_KIND_MISMATCH[required]);
  }
}

/**
 * Body of POST /api/opportunities.
 *
 * `inline_study` is validated by CreateOpportunitySchema but is not part of the
 * shared CreateOpportunityRequest interface: shared/types/index.ts is flattened
 * into a single file when it is copied to the frontend, so a cross-tree import
 * there would not resolve in the copy.
 */
type CreateOpportunityBody = CreateOpportunityRequest & {
  inline_study?: InlineStudy;
  inline_survey?: InlineSurvey;
  // Accepted by the validation schema but not on the shared request interfaces
  // yet, for the same flattening reason as inline_study above: the authoring
  // toggle that sets it lands with the form, and declaring a writable field
  // before anything can write it invites a client to send one nothing reads.
  delivery_mode?: DeliveryMode;
};

type UpdateOpportunityBody = UpdateOpportunityRequest & {
  inline_study?: InlineStudy;
  inline_survey?: InlineSurvey;
  delivery_mode?: DeliveryMode;
};

// Validation helper
const validateUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

// GET /api/opportunities - List opportunities
router.get('/', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  try {
    const type = req.query.type as string | undefined;
    const q = req.query.q as string | undefined;
    const status = req.query.status as string | undefined;
    const isAdmin = req.user?.role === 'researcher_admin' || req.user?.role === 'superadmin';
    
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    
    if (!dbAvailable) {
      // Use mock data
      interface OpportunityFilters {
        type?: string;
        q?: string;
        status?: string;
      }
      const filters: OpportunityFilters = {};
      if (type) filters.type = type as string;
      if (q) filters.q = q as string;
      if (status) filters.status = status as string;
      else if (!isAdmin) filters.status = 'published'; // Default to published for non-admin
      
      const opportunities = getMockOpportunities(filters);
      res.json(isAdmin ? opportunities : opportunities.map(toPublicOpportunity));
      return;
    }
    
    // Use database - LEFT JOIN so opportunities show even when owner not in users (e.g. demo/session-only)
    let query = `
      SELECT o.*, u.name as owner_name, u.email as owner_email
      FROM opportunities o
      LEFT JOIN users u ON o.owner_user_id = u.id
    `;
    const params: (string | number)[] = [];
    const conditions: string[] = [];
    
    // Add filters
    if (type) {
      conditions.push(`o.type = $${params.length + 1}`);
      params.push(type);
    }
    
    if (q) {
      conditions.push(`(o.title ILIKE $${params.length + 1} OR o.purpose_one_liner ILIKE $${params.length + 1})`);
      params.push(`%${q}%`);
    }
    
    // Admins can filter by status; non-admins always get only published
    if (isAdmin && status) {
      conditions.push(`o.status = $${params.length + 1}`);
      params.push(status);
    } else if (!isAdmin) {
      // Non-admins may only ever see published studies, regardless of any status query param
      conditions.push(`o.status = 'published'`);
    }
    
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    query += ` ORDER BY o.created_at DESC`;
    
    const result = await pool.query(query, params);
    
    // Performance optimization: Batch load all sessions and click counts in single queries
    // instead of N+1 queries per opportunity
    const opportunityIds = result.rows.map(opp => opp.id);
    
    // Get all sessions for all opportunities in one query
    const allSessionsMap: Map<string, any[]> = new Map();
    try {
      const sessionsResult = await pool.query(
        `SELECT s.*,
                COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)::int as actual_booked_count,
                s.opportunity_id
         FROM sessions s
         LEFT JOIN bookings b ON s.id = b.session_id
         WHERE s.opportunity_id = ANY($1::uuid[])
         GROUP BY s.id, s.opportunity_id, s.start_time, s.end_time, s.capacity,
                  s.location_or_meet_link_optional, s.created_at, s.updated_at, s.booked_count
         ORDER BY s.opportunity_id, s.start_time ASC`,
        [opportunityIds]
      );

      // Group sessions by opportunity_id
      for (const session of sessionsResult.rows) {
        const oppId = session.opportunity_id;
        if (!allSessionsMap.has(oppId)) {
          allSessionsMap.set(oppId, []);
        }
        allSessionsMap.get(oppId)!.push({
          ...session,
          booked_count: session.actual_booked_count, // Use calculated value
          remaining: session.capacity - (session.actual_booked_count || 0), // Calculate from actual bookings
          start_time: session.start_time.toISOString(),
          end_time: session.end_time.toISOString(),
          created_at: session.created_at.toISOString(),
          updated_at: session.updated_at.toISOString(),
        });
      }
    } catch (sessionError: any) {
      logger.error('Error loading sessions batch:', { error: sessionError });
      // Continue with empty sessions map - opportunities will have empty sessions array
    }

    // Get all click counts for poll/survey opportunities in one query (only if admin)
    const clicksMap: Map<string, number> = new Map();
    if (isAdmin) {
      try {
        const pollSurveyOppIds = result.rows
          .filter(opp => opp.type === 'poll' || opp.type === 'survey' || opp.type === 'unmoderated')
          .map(opp => opp.id);
        
        if (pollSurveyOppIds.length > 0) {
          const clicksResult = await pool.query(
            `SELECT opportunity_id, COUNT(*)::int as count 
             FROM opportunity_clicks 
             WHERE opportunity_id = ANY($1::uuid[])
             GROUP BY opportunity_id`,
            [pollSurveyOppIds]
          );
          
          // Map click counts by opportunity_id
          for (const row of clicksResult.rows) {
            clicksMap.set(row.opportunity_id, parseInt(row.count || '0', 10));
          }
        }
      } catch (clickError: any) {
        logger.error('Error loading click counts batch:', { error: clickError });
        // Continue with empty clicks map
      }
    }

    // Combine results
    const opportunities = result.rows.map(opportunity => {
      const sessions = allSessionsMap.get(opportunity.id) || [];
      const clicks_total = ((opportunity.type === 'poll' || opportunity.type === 'survey' || opportunity.type === 'unmoderated') && isAdmin)
        ? (clicksMap.get(opportunity.id) ?? 0)
        : undefined;

      return {
        ...opportunity,
        owner_name: opportunity.owner_name || 'Unknown',
        owner_email: opportunity.owner_email || 'unknown@example.com',
        created_at: opportunity.created_at.toISOString(),
        updated_at: opportunity.updated_at.toISOString(),
        start_date: opportunity.start_date ? opportunity.start_date.toISOString() : null,
        end_date: opportunity.end_date ? opportunity.end_date.toISOString() : null,
        sessions,
        clicks_total,
      };
    });

    res.json(isAdmin ? opportunities : opportunities.map(toPublicOpportunity));
  } catch (error) {
    // Operational errors (e.g. the 503 isDatabaseAvailable throws during an
    // outage) carry their own status and code - let errorHandler serialise
    // them instead of flattening to a generic 500.
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error in opportunities route', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
}));

// GET /api/opportunities/:id - Get opportunity detail
router.get('/:id', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const isAdmin = req.user?.role === 'researcher_admin' || req.user?.role === 'superadmin';
  
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  
  if (!dbAvailable) {
    // Use mock data
    const opportunity = getMockOpportunity(id);
    if (!opportunity) {
      throw new NotFoundError('Opportunity');
    }
    
    // Non-admin users can only see published opportunities
    if (!isAdmin && opportunity.status !== 'published') {
      throw new NotFoundError('Opportunity');
    }

    res.json(isAdmin ? opportunity : toPublicOpportunity(opportunity));
    return;
  }
  
  // Use database - LEFT JOIN so opportunities show even when owner not in users (e.g. demo/session-only)
  let query = `
    SELECT o.*, u.name as owner_name, u.email as owner_email
    FROM opportunities o
    LEFT JOIN users u ON o.owner_user_id = u.id
    WHERE o.id = $1
  `;
  const params = [id];
  
  // Non-admin users can only see published opportunities
  if (!isAdmin) {
    query += ` AND o.status = 'published'`;
  }
  
  const result = await pool.query(query, params);
  
  if (result.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }
  
  // Get sessions for this opportunity with dynamic booked_count calculation
  const sessionsResult = await pool.query(`
    SELECT s.*,
           COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)::int as actual_booked_count
    FROM sessions s
    LEFT JOIN bookings b ON s.id = b.session_id
    WHERE s.opportunity_id = $1
    GROUP BY s.id, s.opportunity_id, s.start_time, s.end_time, s.capacity,
             s.location_or_meet_link_optional, s.created_at, s.updated_at, s.booked_count
    ORDER BY s.start_time ASC
  `, [id]);

  const row = result.rows[0];
  const opportunity = {
    ...row,
    owner_name: row.owner_name || 'Unknown',
    owner_email: row.owner_email || 'unknown@example.com',
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    start_date: row.start_date ? row.start_date.toISOString() : null,
    end_date: row.end_date ? row.end_date.toISOString() : null,
    sessions: sessionsResult.rows.map(session => ({
      ...session,
      booked_count: session.actual_booked_count, // Use calculated value
      remaining: session.capacity - (session.actual_booked_count || 0), // Calculate from actual bookings
      start_time: session.start_time.toISOString(),
      end_time: session.end_time.toISOString(),
      created_at: session.created_at.toISOString(),
      updated_at: session.updated_at.toISOString(),
    }))
  };

  res.json(isAdmin ? opportunity : toPublicOpportunity(opportunity));
}));

// POST /api/opportunities - Create opportunity
router.post('/', requireAdmin, validateRequest(CreateOpportunitySchema), asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    // Note: Data is already validated by validateRequest(CreateOpportunitySchema) middleware
    const data: CreateOpportunityRequest = req.body;
    
    // Create mock opportunity
    const mockOpportunity = {
      id: `mock-${Date.now()}`,
      type: data.type,
      title: data.title.trim(),
      purpose_one_liner: data.purpose_one_liner.trim(),
      description_optional: data.description_optional?.trim() || null,
      product_optional: data.product_optional?.trim() || null,
      default_duration_minutes: data.default_duration_minutes || 30,
      status: data.status || 'draft',
      owner_user_id: req.user!.id,
      external_link_optional: data.external_link_optional?.trim() || null,
      participant_type_required: data.participant_type_required || 'any',
      participant_type_specific_details: data.participant_type_specific_details?.trim() || null,
      start_date: data.start_date || null,
      end_date: data.end_date || null,
      created_at: new Date(),
      updated_at: new Date(),
      owner_name: req.user!.name,
      owner_email: req.user!.email,
      sessions: []
    };
    
    // Add to dynamic mock data
    addMockOpportunity(mockOpportunity);
    
    return res.status(201).json(mockOpportunity);
  }
  
  const data: CreateOpportunityBody = req.body;
  // Note: Data is already validated by validateRequest(CreateOpportunitySchema) middleware

  // Unmoderated studies run with logged-in Cortex users, so an external
  // participant type is not representable.
  if (data.type === 'unmoderated' && data.participant_type_required === 'external') {
    throw new ValidationError('Unmoderated studies cannot use an external participant type; participants must be logged-in Cortex users');
  }

  // Normalised once and used everywhere below. Three separate truthiness rules
  // on this field previously disagreed: an all-whitespace id passed
  // z.string().min(1), was falsy where the inline study was resolved but truthy
  // in the publish guard, and then stored as NULL - landing a published
  // unmoderated opportunity with no study, exactly what the guard prevents.
  const linkedStudyId = data.firsthand_study_id?.trim() || undefined;

  // An inline study is only meaningful for unmoderated. Both of these are
  // rejections rather than silent drops, and PATCH enforces the same two: a
  // request that quietly discards the tasks someone just wrote is the failure
  // mode this whole feature exists to remove.
  if (data.inline_study && data.type !== 'unmoderated') {
    throw new ValidationError('Only unmoderated opportunities can carry a task list');
  }

  // The survey counterpart, with the mirror-image restriction. A recorded study
  // cannot carry questions and a poll or survey cannot carry a task list: the
  // two vocabularies are not interchangeable, which is the whole reason `kind`
  // exists.
  if (data.inline_survey && data.type !== 'poll' && data.type !== 'survey') {
    throw new ValidationError('Only polls and surveys can carry questions');
  }

  if (data.inline_survey && (data.delivery_mode ?? 'external') !== 'native') {
    throw new ValidationError(
      'Questions are only used when the poll or survey runs in Cortex; set delivery_mode to native'
    );
  }

  if (linkedStudyId && data.inline_study) {
    throw new ValidationError(
      'Send either firsthand_study_id or inline_study, not both'
    );
  }

  if (linkedStudyId && data.inline_survey) {
    throw new ValidationError(
      'Send either firsthand_study_id or inline_survey, not both'
    );
  }

  const inlineStudy = data.inline_study;
  const inlineSurvey = data.inline_survey;

  // Every existing poll and survey is external, and the column defaults to it,
  // so an absent value means external here too.
  const deliveryMode = data.delivery_mode ?? 'external';

  // Additional validation for published opportunities
  if (data.status === 'published' && data.type === 'unmoderated') {
    if (!linkedStudyId && !inlineStudy) {
      throw new ValidationError(UNMODERATED_STUDY_REQUIRED);
    }
  } else if (data.status === 'published' && (data.type === 'poll' || data.type === 'survey')) {
    // The external link is required only where the participant is actually
    // being sent somewhere else. It used to be required unconditionally, which
    // is what made these types external-only.
    if (deliveryMode === 'native') {
      if (!linkedStudyId && !inlineSurvey) {
        throw new ValidationError(NATIVE_SURVEY_STUDY_REQUIRED);
      }
    } else if (!data.external_link_optional || !validateUrl(data.external_link_optional)) {
      throw new ValidationError('External link is required for published polls and surveys');
    }
  }

  // Checked whatever the status, not only on publish: a draft carrying a
  // mismatched study is a draft that cannot be published, and saying so now is
  // better than saying it later.
  if (linkedStudyId) {
    await assertLinkedStudyKindMatches(linkedStudyId, data.type, deliveryMode);
  }

  // Ensure session user exists in DB (demo/session-only users may not be persisted)
  await pool.query(
    `INSERT INTO users (id, name, email, business_unit, role_title, role)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
       business_unit = EXCLUDED.business_unit, role_title = EXCLUDED.role_title, role = EXCLUDED.role`,
    [
      req.user!.id,
      req.user!.name,
      req.user!.email,
      req.user!.business_unit || null,
      req.user!.role_title || null,
      req.user!.role,
    ]
  );

  // Only superadmins can set display_width - default to 'single' otherwise
  const isSuperadmin = req.user!.role === 'superadmin';
  const finalDisplayWidth = isSuperadmin && (data as any).display_width ? (data as any).display_width : 'single';

  const query = `
    INSERT INTO opportunities (
      type, title, purpose_one_liner, description_optional,
      product_optional, meeting_location_optional, default_duration_minutes, status,
      owner_user_id, external_link_optional, firsthand_study_id, participant_type_required,
      participant_type_specific_details, start_date, end_date, display_width, delivery_mode
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING *
  `;

  // The study has to exist before the opportunity row that references it.
  //
  // Studies live on the FirstHand runtime pool and opportunities on the app
  // pool, so a single SQL transaction cannot span both even though they are the
  // same database. The compensating delete below is what keeps a failed insert
  // from leaving behind a launched study nobody asked for.
  let createdStudyId: string | null = null;

  if (inlineStudy) {
    if (!isStudiesPersistenceConfigured()) {
      // Matches the 503 the direct studies route answers with, rather than
      // letting createStudy throw a bare Error that the handler cannot map.
      throw new AppError('Task lists require a configured PostgreSQL database.', 503);
    }

    // Generated here rather than left to createStudy so the step ids can be
    // namespaced with it - see toStudySteps on why that is load-bearing.
    const studyId = `study_${crypto.randomUUID()}`;

    const stored = await createStudy({
      id: studyId,
      title: data.title.trim(),
      intro_text: data.purpose_one_liner.trim(),
      consent_text: inlineStudy.consent_text.trim(),
      // NOT `?? data.default_duration_minutes`. That column is NOT NULL with a
      // DEFAULT of 30, so falling back to it gave every recorded study a
      // duration nobody chose - and put it above a consent button. Null means
      // the researcher did not say, and every surface already handles null by
      // saying nothing.
      estimated_duration_minutes: resolveStudyDuration(inlineStudy.estimated_duration_minutes),
      // Launched rather than draft: only launched studies are selectable, and a
      // study authored as part of an opportunity has no separate review step to
      // wait for. Leaving it draft would publish an opportunity pointing at a
      // study the picker refuses to show.
      status: 'launched',
      // Same owner as the opportunity this study is being authored for, so the
      // two sides of the same authoring action agree on who may edit them.
      owner_user_id: req.user!.id,
      steps: toStudySteps(inlineStudy.steps, studyId, inlineStudy.target_url)
    });
    createdStudyId = stored.study.id;
  } else if (inlineSurvey) {
    if (!isStudiesPersistenceConfigured()) {
      throw new AppError('Questions require a configured PostgreSQL database.', 503);
    }

    const studyId = `study_${crypto.randomUUID()}`;

    const stored = await createStudy({
      id: studyId,
      title: data.title.trim(),
      intro_text: data.purpose_one_liner.trim(),
      consent_text: inlineSurvey.consent_text.trim(),
      estimated_duration_minutes: resolveStudyDuration(
        inlineSurvey.estimated_duration_minutes
      ),
      status: 'launched',
      owner_user_id: req.user!.id,
      // The one line that makes this a survey rather than a task list. Without
      // it the study is stored as `recorded` - the repository's default - and
      // the linkage check would then refuse the very opportunity that authored
      // it, which is a confusing way to find out.
      kind: 'survey',
      steps: toSurveySteps(inlineSurvey.steps, studyId)
    });
    createdStudyId = stored.study.id;
  } else if (linkedStudyId && isStudiesPersistenceConfigured()) {
    // Reusing an existing study. If it is one of the legacy rows migration
    // 0007 could not attribute, claim it now: publishing an opportunity is the
    // moment an unowned study starts being served to participants, and until
    // it has an owner any admin can rewrite its consent copy and target URLs.
    // Before the opportunity row is written, so a failure here fails the whole
    // request rather than leaving a published opportunity behind an unowned
    // study. Claiming a study whose insert then fails is harmless - it gives
    // an ownerless row an owner, which is the direction this is going anyway.
    if (await claimStudyIfUnowned(linkedStudyId, req.user!.id)) {
      logger.info('Unowned study claimed by the opportunity linking it', {
        studyId: linkedStudyId,
        newOwnerUserId: req.user!.id
      });
    }
  }

  const values = [
    data.type,
    data.title.trim(),
    data.purpose_one_liner.trim(),
    data.description_optional?.trim() || null,
    data.product_optional?.trim() || null,
    data.meeting_location_optional?.trim() || null,
    data.default_duration_minutes || 30,
    data.status || 'draft',
    req.user!.id,
    data.external_link_optional?.trim() || null,
    createdStudyId ?? linkedStudyId ?? null,
    data.participant_type_required || 'any',
    data.participant_type_specific_details?.trim() || null,
    data.start_date || null,
    data.end_date || null,
    finalDisplayWidth,
    // Stored for every type, not only poll and survey. The column is NOT NULL
    // and the other types ignore it, so writing the resolved value keeps the
    // row honest rather than relying on the DDL default for some paths and the
    // request for others.
    deliveryMode
  ];

  let result;
  try {
    result = await pool.query(query, values);
  } catch (error) {
    if (createdStudyId) {
      try {
        await deleteStudyUnchecked(createdStudyId);
      } catch (cleanupError) {
        // Swallowed deliberately: the caller needs the original insert failure,
        // not this one. Logged with the id so an orphan can be found by hand.
        logger.error('Failed to remove inline study after opportunity insert failed', {
          studyId: createdStudyId,
          error: String(cleanupError)
        });
      }
    }
    throw error;
  }
  const opportunity = {
    ...result.rows[0],
    created_at: result.rows[0].created_at.toISOString(),
    updated_at: result.rows[0].updated_at.toISOString(),
    start_date: result.rows[0].start_date ? result.rows[0].start_date.toISOString() : null,
    end_date: result.rows[0].end_date ? result.rows[0].end_date.toISOString() : null,
    sessions: []
  };
  
  res.status(201).json(opportunity);
}));

// PATCH /api/opportunities/:id - Update opportunity
router.patch('/:id', requireAdmin, validateRequest(UpdateOpportunitySchema), asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    // Note: Data is already validated by validateRequest(UpdateOpportunitySchema) middleware
    const { id } = req.params;
    const data: UpdateOpportunityRequest = req.body;
    
    // Check if opportunity exists
    const existingOpportunity = getMockOpportunity(id);
    if (!existingOpportunity) {
      throw new NotFoundError('Opportunity');
    }
    
    // Check ownership (superadmins can edit any)
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && existingOpportunity.owner_user_id !== req.user!.id) {
      throw new ForbiddenError('Only the owner can edit this opportunity');
    }
    
    // Update the opportunity
    const updatedOpportunity = updateMockOpportunity(id, {
      ...data,
      updated_at: new Date()
    });
    
    if (!updatedOpportunity) {
      throw new NotFoundError('Opportunity');
    }
    
    return res.json(updatedOpportunity);
  }
  
  const { id } = req.params;
  // inline_study is consumed to build a study and must NOT survive into the
  // generic field loop below, which maps every remaining key straight to a
  // column name - it is not a column on opportunities.
  const {
    inline_study: inlineStudyInput,
    inline_survey: inlineSurveyInput,
    ...data
  }: UpdateOpportunityBody = req.body;
  // Note: Data is already validated by validateRequest(UpdateOpportunitySchema) middleware
  
  // Check ownership (only owner or global admin can edit)
  const ownershipCheck = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [id]
  );
  
  if (ownershipCheck.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }
  
  // Check ownership (superadmins can edit any)
  const isOwner = ownershipCheck.rows[0].owner_user_id === req.user!.id;
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOwner) {
    throw new ForbiddenError('Only the owner can edit this opportunity');
  }
  
  // Get existing opportunity to check type when status is being changed
  const existingOpp = await pool.query(
    // title and purpose_one_liner are read so an inline study created on this
    // path can inherit them when the request does not also change them.
    'SELECT type, title, purpose_one_liner, status, external_link_optional, firsthand_study_id, participant_type_required, delivery_mode FROM opportunities WHERE id = $1',
    [id]
  );
  // Same delete-mid-request race the UPDATE below now handles: without this the
  // row access throws a TypeError and answers 500 instead of 404.
  if (existingOpp.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }

  const existingType = data.type || existingOpp.rows[0].type;
  const existingLink = existingOpp.rows[0].external_link_optional;
  const existingFirstHandStudyId = existingOpp.rows[0].firsthand_study_id;
  const newLink = data.external_link_optional !== undefined ? data.external_link_optional : existingLink;
  const newFirstHandStudyId = data.firsthand_study_id !== undefined ? data.firsthand_study_id : existingFirstHandStudyId;
  const newParticipantType = data.participant_type_required !== undefined
    ? data.participant_type_required
    : existingOpp.rows[0].participant_type_required;
  // The mode this request leaves behind, for the same reason the publish guard
  // below reads the resulting state rather than only what the request sets.
  const newDeliveryMode =
    data.delivery_mode !== undefined
      ? data.delivery_mode
      : existingOpp.rows[0].delivery_mode ?? 'external';

  // Unmoderated studies run with logged-in Cortex users, so an external
  // participant type is not representable. Only enforce when this request
  // actually sets the type or participant type, so an unrelated edit to a
  // legacy unmoderated+external row is not blocked (the bad value can still be
  // corrected by PATCHing participant_type_required to a non-external value).
  if (
    (data.type !== undefined || data.participant_type_required !== undefined) &&
    existingType === 'unmoderated' &&
    newParticipantType === 'external'
  ) {
    throw new ValidationError('Unmoderated studies cannot use an external participant type; participants must be logged-in Cortex users');
  }

  if (inlineSurveyInput && newDeliveryMode !== 'native') {
    throw new ValidationError(
      'Questions are only used when the poll or survey runs in Cortex; set delivery_mode to native'
    );
  }

  // An inline study can only fill a gap, never replace a link. Rejected rather
  // than resolved by precedence, matching create.
  if (inlineStudyInput && existingType !== 'unmoderated') {
    throw new ValidationError('Only unmoderated opportunities can carry a task list');
  }

  if (
    inlineSurveyInput &&
    existingType !== 'poll' &&
    existingType !== 'survey'
  ) {
    throw new ValidationError('Only polls and surveys can carry questions');
  }

  // Two distinct refusals, kept apart so each says something true. Checked
  // against the STORED link as well as this request's override: using the
  // merged value alone let `firsthand_study_id: null` (which the update schema
  // permits) clear the link in the same breath as authoring a new study,
  // silently re-pointing a live opportunity and orphaning the study it had.
  if (inlineStudyInput && existingFirstHandStudyId?.trim()) {
    throw new ValidationError(
      'This opportunity already has a task list; edit its tasks in the Task Lists area'
    );
  }

  if (inlineStudyInput && data.firsthand_study_id?.trim()) {
    throw new ValidationError(
      'Send either firsthand_study_id or inline_study, not both'
    );
  }

  // The survey twins of the two guards above, and they are not optional.
  // Without the first, `PATCH { inline_survey }` on an opportunity that already
  // had questions minted a THIRD study and re-pointed the row at it, leaving
  // the previous one launched, orphaned, and holding every answer collected so
  // far - readable only by knowing a study id nothing references. Without the
  // second, a body carrying both an explicit id and authored questions was
  // resolved by precedence, silently discarding the caller's id, where create
  // refuses the identical body.
  if (inlineSurveyInput && existingFirstHandStudyId?.trim()) {
    throw new ValidationError(
      'This opportunity already has questions; edit them in the Task Lists area'
    );
  }

  if (inlineSurveyInput && data.firsthand_study_id?.trim()) {
    throw new ValidationError(
      'Send either firsthand_study_id or inline_survey, not both'
    );
  }

  // Additional validation for published opportunities.
  //
  // Evaluated against the state this request LEAVES BEHIND, not only against a
  // status it sets. Gating on `data.status === 'published'` alone meant that
  // clearing the study on an already-published opportunity sailed through:
  // PATCH { firsthand_study_id: null } left a live unmoderated opportunity with
  // no study, the exact state this guard exists to prevent.
  const willBePublished =
    data.status !== undefined
      ? data.status === 'published'
      : existingOpp.rows[0].status === 'published';

  // ...but only for requests that could CREATE the bad state: ones that
  // publish, change the type, or change what the opportunity points at. An
  // unrelated edit to a row ALREADY in that state stays allowed, or a legacy
  // published row with no study could never have its other fields corrected -
  // which is precisely the remediation the participant-type comment above
  // promises, and reset-demo-data.ts seeds exactly such a row.
  const changesPublishShape =
    data.status !== undefined ||
    data.type !== undefined ||
    data.firsthand_study_id !== undefined ||
    inlineStudyInput !== undefined ||
    inlineSurveyInput !== undefined ||
    data.external_link_optional !== undefined ||
    // Switching delivery mode changes WHICH of the two things is required, so
    // it changes the publish shape as surely as clearing the link does. Without
    // this, `PATCH { delivery_mode: 'native' }` on a published external survey
    // produced a live native survey with no questions - the same hole the type
    // flip above opened, through a different door.
    data.delivery_mode !== undefined;

  const publishGuardApplies = willBePublished && changesPublishShape;

  if (publishGuardApplies && existingType === 'unmoderated') {
    // Trimmed for the same reason as the create guard: an all-whitespace id
    // would otherwise satisfy this and store NULL.
    if (!newFirstHandStudyId?.trim() && !inlineStudyInput) {
      // A caller REMOVING the study from a published opportunity is not trying
      // to publish, so telling them to add a prompt "before publishing"
      // describes an action they are not taking.
      const removingStudy =
        data.firsthand_study_id !== undefined && existingFirstHandStudyId?.trim();

      throw new ValidationError(
        removingStudy
          ? 'A published unmoderated test cannot have its task list removed; unpublish it first'
          : UNMODERATED_STUDY_REQUIRED
      );
    }
  } else if (publishGuardApplies && (existingType === 'poll' || existingType === 'survey')) {
    // Same reasoning as the unmoderated branch above: gating on the request's
    // own status let `PATCH { type: 'poll' }` against a published opportunity
    // produce a published poll with no link, which is what this rejects.
    //
    // Which of the two things is required now depends on where the participant
    // is being sent. A native poll needs its questions; an external one needs
    // the link it hands off to.
    if (newDeliveryMode === 'native') {
      if (!newFirstHandStudyId?.trim() && !inlineSurveyInput) {
        throw new ValidationError(NATIVE_SURVEY_STUDY_REQUIRED);
      }
    } else if (!newLink || !validateUrl(newLink)) {
      throw new ValidationError('External link is required for published polls and surveys');
    }
  }

  // Same boundary check as create, against the resulting state, so switching a
  // published external survey to native cannot adopt a recorded task list on
  // the way through.
  //
  // Gated on the request actually changing the link or what the link has to be,
  // for the reason the publish guard above states for itself: an unrelated edit
  // to a row already in a bad state must stay allowed, or the row can never be
  // repaired. Unconditionally, this refused `PATCH { title }`, refused
  // `PATCH { status: 'draft' }` - so the misleading page could not even be
  // taken down - and answered every one of them with a message about question
  // types the caller had not touched. DELETE was the only way out.
  const changesLinkage =
    data.firsthand_study_id !== undefined ||
    data.delivery_mode !== undefined ||
    data.type !== undefined;

  if (changesLinkage && newFirstHandStudyId?.trim()) {
    await assertLinkedStudyKindMatches(
      newFirstHandStudyId.trim(),
      existingType,
      newDeliveryMode
    );
  }
  
  // Build the study before the update, for the same reason as create: the row
  // has to reference an id that already exists. See the create handler for why
  // this cannot share a transaction with the opportunity write.
  let createdStudyId: string | null = null;

  if (inlineStudyInput) {
    if (!isStudiesPersistenceConfigured()) {
      throw new AppError('Task lists require a configured PostgreSQL database.', 503);
    }

    const studyId = `study_${crypto.randomUUID()}`;
    const stored = await createStudy({
      id: studyId,
      // `||` rather than `??`: a row stored before the schema trimmed these
      // fields can hold '', which `??` would happily propagate into a study
      // whose session payload then fails to assemble.
      title: (data.title || existingOpp.rows[0].title || 'Untitled study').trim(),
      intro_text: (
        data.purpose_one_liner || existingOpp.rows[0].purpose_one_liner || 'Recorded study'
      ).trim(),
      consent_text: inlineStudyInput.consent_text.trim(),
      estimated_duration_minutes: resolveStudyDuration(inlineStudyInput.estimated_duration_minutes),
      status: 'launched',
      // The editing user, not the opportunity's owner: a superadmin editing
      // someone else's opportunity is the author of the study they just wrote,
      // and the opportunity owner never saw its consent copy.
      owner_user_id: req.user!.id,
      steps: toStudySteps(inlineStudyInput.steps, studyId, inlineStudyInput.target_url)
    });
    createdStudyId = stored.study.id;
    // Routed through the same field loop as everything else so the id lands in
    // the UPDATE without a second code path.
    data.firsthand_study_id = createdStudyId;
  } else if (inlineSurveyInput) {
    if (!isStudiesPersistenceConfigured()) {
      throw new AppError('Questions require a configured PostgreSQL database.', 503);
    }

    const studyId = `study_${crypto.randomUUID()}`;
    const stored = await createStudy({
      // Same `||` reasoning as the task-list branch above: a legacy row can
      // hold '', which `??` would carry into a study whose session payload then
      // fails to assemble.
      id: studyId,
      title: (data.title || existingOpp.rows[0].title || 'Untitled survey').trim(),
      intro_text: (
        data.purpose_one_liner || existingOpp.rows[0].purpose_one_liner || 'Survey'
      ).trim(),
      consent_text: inlineSurveyInput.consent_text.trim(),
      estimated_duration_minutes: resolveStudyDuration(
        inlineSurveyInput.estimated_duration_minutes
      ),
      status: 'launched',
      owner_user_id: req.user!.id,
      kind: 'survey',
      steps: toSurveySteps(inlineSurveyInput.steps, studyId)
    });
    createdStudyId = stored.study.id;
    data.firsthand_study_id = createdStudyId;
  } else if (data.firsthand_study_id !== undefined) {
    // Normalise before the loop, which stores `value.trim()` verbatim and would
    // otherwise write '' where create writes NULL for the same input. Two
    // representations of "no study" is a trap for any later IS NOT NULL query.
    data.firsthand_study_id = data.firsthand_study_id?.trim() || null;

    // Same claim-on-link as the create handler, for the same reason: attaching
    // an unowned legacy study to an opportunity is the point at which it
    // starts being served, so it must not still be writable by every admin.
    if (data.firsthand_study_id && isStudiesPersistenceConfigured()) {
      const claimedStudyId = data.firsthand_study_id;
      if (await claimStudyIfUnowned(claimedStudyId, req.user!.id)) {
        logger.info('Unowned study claimed by the opportunity linking it', {
          studyId: claimedStudyId,
          newOwnerUserId: req.user!.id
        });
      }
    }
  }

  // Build dynamic update query
  const updateFields: string[] = [];
  const values: (string | number | Date | null)[] = [];
  let paramCount = 0;

  Object.entries(data).forEach(([key, value]) => {
    if (value !== undefined) {
      paramCount++;
      updateFields.push(`${key} = $${paramCount}`);
      values.push(typeof value === 'string' ? value.trim() : value);
    }
  });
  
  if (updateFields.length === 0) {
    throw new ValidationError('No fields to update');
  }
  
  paramCount++;
  values.push(id);
  
  const query = `
    UPDATE opportunities 
    SET ${updateFields.join(', ')}
    WHERE id = $${paramCount}
    RETURNING *
  `;
  
  let result;
  try {
    result = await pool.query(query, values);

    // Zero rows means the opportunity was deleted between the ownership check
    // and this write. Raised inside the try so it takes the compensating
    // delete: otherwise the row access below threw outside it, leaving the
    // study behind.
    if (result.rowCount === 0) {
      throw new NotFoundError('Opportunity');
    }
  } catch (error) {
    if (createdStudyId) {
      try {
        await deleteStudyUnchecked(createdStudyId);
      } catch (cleanupError) {
        logger.error('Failed to remove inline study after opportunity update failed', {
          studyId: createdStudyId,
          error: String(cleanupError)
        });
      }
    }
    throw error;
  }

  const opportunity = {
    ...result.rows[0],
    created_at: result.rows[0].created_at.toISOString(),
    updated_at: result.rows[0].updated_at.toISOString(),
    start_date: result.rows[0].start_date ? result.rows[0].start_date.toISOString() : null,
    end_date: result.rows[0].end_date ? result.rows[0].end_date.toISOString() : null,
    sessions: []
  };

  res.json(opportunity);
}));

// Anonymous, and it touches the FirstHand runtime pool - which is `max: 5` and is the
// same pool serving live participant sessions. Without a limiter, sustained requests to
// a public endpoint can starve recordings already in progress of connections, which is
// the failure mode that loses a session someone has already sat through. Same reasoning
// as healthLimiter; generous, because a participant legitimately reloads a landing page.
const recordedStudyBriefLimiter = rateLimit({
  windowMs: 60 * 1000,
  // Behind two proxy hops `trust proxy: 1` resolves req.ip to the INGRESS, so
  // this is one bucket shared by every external caller - the same reality
  // healthLimiter documents, and why it sits at 600. At 60 a single
  // participant reloading a landing page could 429 everyone else, and the
  // brief failing silently means the task count would vanish platform-wide.
  // Raised to match healthLimiter's ceiling: still a backstop against a
  // runaway loop hammering the 5-connection runtime pool, without being a
  // self-inflicted outage. Per-caller keying needs `trust proxy` to match the
  // real hop count first - getting that wrong makes the limiter
  // header-spoofable, which is worse than a shared bucket.
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' }
});

// GET /api/opportunities/:id/recorded-study-brief - What the participant is agreeing to,
// before they agree to it.
//
// A recorded study begins the moment the CTA is clicked, and until now the landing page
// said nothing the researcher had not typed by hand. This serves what the study itself
// knows, so the page can state it rather than hoping the description mentions it.
//
// It serves COUNTS AND CONSTANTS, NOTHING ELSE. The prompts are withheld on purpose: a
// participant who reads all the tasks up front rehearses the route, and the recording
// captures a performance instead of a first encounter. That is the same reason the
// welcome screen stopped listing them. The handler never loads them at all - see
// countStudyTasks - so a careless spread cannot turn this into a prompt dump.
//
// NO DURATION. Unmoderated has no duration field anywhere in the authoring form, so
// `default_duration_minutes` falls to its column default of 30 for every such study and
// the inline study copies its estimate from that same never-displayed field. Stating
// that number above a consent button would be inventing a figure no researcher chose.
// It comes back when a researcher can actually set one.
//
// Visibility mirrors GET /:id on the database path - non-admins are filtered to
// published - so this cannot expose a draft the detail page would 404. It diverges in
// the no-database branch, where GET /:id serves mock fixtures and this 404s: mock data
// has no linked studies, and a brief without counts is a better failure than a brief
// with invented ones.
router.get('/:id/recorded-study-brief', recordedStudyBriefLimiter, optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const isAdmin = req.user?.role === 'researcher_admin' || req.user?.role === 'superadmin';

  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    throw new NotFoundError('Opportunity');
  }

  let query = `
    SELECT status, type, firsthand_study_id
    FROM opportunities
    WHERE id = $1
  `;
  if (!isAdmin) {
    query += ` AND status = 'published'`;
  }

  const result = await pool.query(query, [id]);
  if (result.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }

  const { type, firsthand_study_id: studyId } = result.rows[0];

  // `unmoderated` is the only type that records anything. An opportunity authored as
  // unmoderated and later switched to `poll` keeps its firsthand_study_id, and without
  // this guard the API would tell an anonymous caller that a poll records their screen
  // and voice. The frontend gates on type too, but the API is the contract.
  if (type !== 'unmoderated' || !studyId) {
    throw new NotFoundError('Recorded study');
  }

  const taskCount = await countStudyTasks(studyId);
  if (taskCount === null) {
    throw new NotFoundError('Recorded study');
  }

  // Study status is deliberately not checked. A published opportunity linked to a draft
  // study can genuinely be run - createSession does not gate on it either - so refusing
  // the brief would describe less than the participant is about to be given.
  const study = await getStudyById(studyId);

  const brief: RecordedStudyBrief = {
    task_count: taskCount,
    // Null unless a researcher actually chose one. It used to be the
    // opportunity's NOT NULL default of 30 for every study.
    estimated_duration_minutes: resolveStudyDuration(study?.study.estimated_duration_minutes),
    // Constants rather than configurable: every recorded study captures screen and voice,
    // and none of them capture the camera. A participant-facing promise that a researcher
    // could switch off is not a promise.
    records_screen_and_voice: true,
    requires_chromium: true
  };

  res.json(brief);
}));

// POST /api/opportunities/:id/recorded-study-session - Create a recorded-study session for this opportunity.
// The legacy path /:id/firsthand-handoff is kept as a deprecated-for-removal alias so a cached SPA can
// still POST it after the backend rolls; remove the alias once no client references the old path.
router.post(['/:id/recorded-study-session', '/:id/firsthand-handoff'], requireAuth, asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { id } = req.params;

  const dbAvailable = await isDatabaseAvailable();

  let studyId: string | null = null;
  // The CANONICAL id, read back from the row, not the raw path segment.
  //
  // opportunities.id is `uuid` and Postgres normalises on parse, so
  // `{97BFE613-4E1F-472C-917E-B90D1C0326B8}` and
  // `97bfe613-4e1f-472c-917e-b90d1c0326b8` both match this WHERE clause - as do
  // several other textual forms, because the parser also tolerates braces,
  // case, and hyphens after any group of four digits. The column this ends up
  // in (firsthand.runtime_sessions.opportunity_id) is TEXT, chosen so the
  // firsthand schema needs no cross-schema foreign key, and TEXT compares by
  // bytes. So passing the path segment through would let a participant mint a
  // family of distinct keys for one opportunity and drop their own answers out
  // of the researcher's per-opportunity results by writing the URL differently.
  // A route path parameter is caller-supplied; only the parsed row is not.
  let canonicalOpportunityId: string | null = null;
  if (dbAvailable) {
    const result = await pool.query(
      'SELECT id, type, firsthand_study_id, status FROM opportunities WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      throw new NotFoundError('Opportunity');
    }
    // The guard the sibling brief route has carried all along, and this one
    // never did. Without it the route mints a RECORDED session - screen and
    // microphone capture, a consent screen saying so - for any published
    // opportunity that happens to carry a study, whatever its type. That was an
    // oddity while every study was a recorded task list; a native poll or
    // survey linking a study is now the designed state, so it becomes routine.
    // A survey is served by its own route, not this one.
    if (result.rows[0].type !== 'unmoderated') {
      throw new NotFoundError('Recorded study');
    }
    if (result.rows[0].status !== 'published') {
      return res.status(403).json({ error: 'Opportunity is not published' });
    }
    studyId = result.rows[0].firsthand_study_id;
    // Null rather than a stringified absence. If the row somehow carries no id
    // the session is stored unattributed - which is refused to everyone but a
    // superadmin - instead of attributed to a literal "undefined" that a later
    // gate would compare against and quietly fail.
    const parsedId = result.rows[0].id;
    canonicalOpportunityId = parsedId == null ? null : String(parsedId);
  }

  if (!studyId) {
    return res.status(400).json({ error: 'Opportunity has no recorded study linked' });
  }

  // Re-checked HERE, not only where the link was made.
  //
  // Checking at link time alone is a time-of-check problem with a wide window:
  // POST /api/firsthand/studies accepts a client-supplied id, so an id that
  // resolved to nothing when it was linked can be filled in afterwards, and a
  // linked study can be deleted and re-created at the same id with a different
  // vocabulary. Both were demonstrated end to end. The moment that actually
  // matters is this one - a participant is about to be shown a consent screen
  // promising screen and microphone capture - so this is where the question is
  // asked again, against the study as it is now.
  if (isStudiesPersistenceConfigured()) {
    const linked = await getStudyById(studyId);

    if (linked && linked.study.kind !== 'recorded') {
      logger.warn('Refused a recorded session on a study that is not a task list', {
        opportunityId: canonicalOpportunityId ?? id,
        studyId,
        kind: linked.study.kind
      });
      throw new NotFoundError('Recorded study');
    }
  }

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const returnUrl = `${frontendUrl}/opportunities/${encodeURIComponent(id)}?completed=1`;
  const participant = {
    participant_id: req.user.id,
    display_name: req.user.name,
    email: req.user.email,
    // Canonicalised for the same reason as opportunityId above. This one is a
    // correlation hint rather than an authorisation key, and its only reader
    // (completion-events.ts) writes it into a `uuid` column that normalises
    // again - so nothing is broken today. Keeping the two fields spelled
    // identically is what stops a future reader picking the unnormalised one.
    external_ref: canonicalOpportunityId ?? id,
  };

  // Mint the session in-process and return a same-origin Cortex URL. No
  // callback_url: the internalised runtime writes lifecycle events directly to
  // opportunity_session_events (B4), so there is no HMAC callback hop back into
  // Cortex. (The HMAC handoff to the standalone app was removed with the flag.)
  // opportunityId is the id Postgres parsed, never the request body and never
  // the raw path segment: it is the key the per-opportunity results gate
  // authorises against, so it has to be one value per opportunity rather than
  // whichever spelling the caller used. See canonicalOpportunityId above.
  const result = await createSession({
    studyId,
    participant,
    ...(canonicalOpportunityId ? { opportunityId: canonicalOpportunityId } : {}),
    returnUrl
  });

  if (!result.ok) {
    switch (result.error) {
      case 'persistence_not_configured':
        return res.status(503).json({ error: 'Recorded-study sessions are not available' });
      case 'study_not_found':
        return res.status(404).json({ error: 'Linked recorded study not found' });
      case 'study_has_no_steps':
        return res.status(400).json({ error: 'Linked recorded study has no steps' });
      case 'payload_assembly_failed':
        throw new AppError(
          'Failed to assemble the recorded-study session',
          500,
          'SESSION_ASSEMBLY_FAILED'
        );
      default: {
        // Exhaustiveness guard: a new CreateSessionError must be handled here.
        // This branch only runs for a value outside the modelled union, so the
        // raw value is unpredictable and must NOT reach the participant-visible
        // AppError.message (errorHandler serialises it verbatim). Log it
        // server-side and throw a static message instead.
        const unexpected: never = result.error;
        logger.error('Unhandled session-create error', { error: String(unexpected) });
        throw new AppError(
          'Failed to assemble the recorded-study session',
          500,
          'SESSION_ASSEMBLY_FAILED'
        );
      }
    }
  }

  const sessionUrl = `${frontendUrl}/session/${result.session.session_token}`;
  return res.json({ session_url: sessionUrl });
}));

// POST /api/opportunities/:id/survey-session - Create a native survey session.
//
// The survey counterpart of /recorded-study-session, and deliberately a
// separate route rather than a mode of it. That one mints a RECORDED session -
// screen and microphone capture, a consent screen that says so - and its guard
// is `type === 'unmoderated'`. A survey records nothing, so the two have
// different preconditions and answer different failures; sharing a route would
// mean one handler whose every branch asks which of two products it is in.
router.post('/:id/survey-session', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { id } = req.params;
  const dbAvailable = await isDatabaseAvailable();

  let studyId: string | null = null;
  let canonicalOpportunityId: string | null = null;

  if (dbAvailable) {
    const result = await pool.query(
      'SELECT id, type, firsthand_study_id, status, delivery_mode FROM opportunities WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Opportunity');
    }

    const row = result.rows[0];

    // BOTH conditions, not either. `delivery_mode` says the researcher meant
    // this to run in Cortex; the study's `kind` says the questions are actually
    // written in a vocabulary this runner can draw. A switch to external
    // delivery leaves the study linked, so the mode alone would let a stale
    // link run; and a recorded task list on a native survey would render
    // instructions meant to be performed aloud with nothing recording.
    if (row.type !== 'poll' && row.type !== 'survey') {
      throw new NotFoundError('Survey');
    }

    if ((row.delivery_mode ?? 'external') !== 'native') {
      throw new NotFoundError('Survey');
    }

    if (row.status !== 'published') {
      return res.status(403).json({ error: 'Opportunity is not published' });
    }

    studyId = row.firsthand_study_id;
    const parsedId = row.id;
    canonicalOpportunityId = parsedId == null ? null : String(parsedId);
  }

  if (!studyId) {
    return res.status(400).json({ error: 'Opportunity has no questions linked' });
  }

  // Re-checked here for the same reason the recorded route re-checks: the
  // studies API takes a client-supplied id, so a study can be planted at a
  // previously dangling id or replaced at the same one long after the link was
  // made. The moment that matters is the one where a participant is about to be
  // shown the questions.
  if (isStudiesPersistenceConfigured()) {
    const linked = await getStudyById(studyId);

    // A missing study is a refusal, not a fall-through: without this the mint
    // continued and createSession answered a less specific error.
    if (!linked) {
      throw new NotFoundError('Survey');
    }

    if (linked.study.kind !== 'survey') {
      logger.warn('Refused a survey session on a study that is a task list', {
        opportunityId: canonicalOpportunityId ?? id,
        studyId,
        kind: linked.study.kind
      });
      throw new NotFoundError('Survey');
    }

    // The study's OWN status, which the opportunity's says nothing about. A
    // published opportunity can link a draft study, and without this its
    // unfinished question wording was served to participants and their answers
    // counted in the results.
    if (linked.study.status !== 'launched') {
      logger.warn('Refused a survey session on a study that is not launched', {
        opportunityId: canonicalOpportunityId ?? id,
        studyId,
        status: linked.study.status
      });
      throw new NotFoundError('Survey');
    }
  }

  /**
   * One session per participant per opportunity.
   *
   * Minting is otherwise a multiplier on the results: every mint is a new
   * runtime_sessions row and the aggregation counts one respondent per session,
   * so pressing Start repeatedly moves a poll's numbers as far as the
   * participant likes, with each fake respondent indistinguishable from a real
   * one. Demonstrated end to end as an ordinary employee before this existed -
   * three extra mints took a rating question from 3 respondents to 6.
   *
   * An unfinished session is RESUMED rather than replaced, so closing the tab
   * and coming back does not lose the answers already given. A finished one is
   * refused outright: re-answering would rewrite the stored responses, and the
   * survey runtime keeps no history of what they were.
   */
  const existing = await findParticipantSessionForOpportunity({
    opportunityId: canonicalOpportunityId ?? id,
    participantId: req.user.id
  });

  if (existing) {
    if (existing.sessionStatus === 'completed' || existing.sessionStatus === 'uploading') {
      return res.status(409).json({ error: 'You have already answered this' });
    }

    return res.json({
      session_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/survey/${existing.token}`
    });
  }

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const returnUrl = `${frontendUrl}/opportunities/${encodeURIComponent(id)}?completed=1`;
  const participant = {
    participant_id: req.user.id,
    display_name: req.user.name,
    email: req.user.email,
    external_ref: canonicalOpportunityId ?? id,
  };

  const result = await createSession({
    studyId,
    participant,
    ...(canonicalOpportunityId ? { opportunityId: canonicalOpportunityId } : {}),
    returnUrl
  });

  if (!result.ok) {
    switch (result.error) {
      case 'persistence_not_configured':
        return res.status(503).json({ error: 'Surveys are not available' });
      case 'study_not_found':
        return res.status(404).json({ error: 'Linked questions not found' });
      case 'study_has_no_steps':
        return res.status(400).json({ error: 'This survey has no questions' });
      case 'payload_assembly_failed':
        throw new AppError('Failed to assemble the survey', 500, 'SESSION_ASSEMBLY_FAILED');
      default: {
        // Exhaustiveness guard, and the raw value must NOT reach the
        // participant-visible message: errorHandler serialises it verbatim.
        const unexpected: never = result.error;
        logger.error('Unhandled survey session-create error', { error: String(unexpected) });
        throw new AppError('Failed to assemble the survey', 500, 'SESSION_ASSEMBLY_FAILED');
      }
    }
  }

  return res.json({ session_url: `${frontendUrl}/survey/${result.session.session_token}` });
}));

// GET /api/opportunities/:id/session-events - List FirstHand session events for an opportunity
router.get('/:id/session-events', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const dbAvailable = await isDatabaseAvailable();

  if (!dbAvailable) {
    return res.json([]);
  }

  // Only owner or superadmin can view session events (matches the analytics endpoint;
  // events name participants and link to their session recordings)
  const opportunityResult = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [id]
  );

  if (opportunityResult.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }

  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && opportunityResult.rows[0].owner_user_id !== req.user!.id) {
    throw new ForbiddenError('Only the opportunity owner can view session events');
  }

  const result = await pool.query(
    `SELECT
       e.id,
       e.opportunity_id,
       e.participant_user_id,
       e.firsthand_session_id,
       e.event_type,
       e.occurred_at,
       e.payload,
       e.received_at,
       u.name AS participant_name,
       u.email AS participant_email
     FROM opportunity_session_events e
     LEFT JOIN users u ON u.id = e.participant_user_id
     WHERE e.opportunity_id = $1
     ORDER BY e.occurred_at DESC`,
    [id]
  );

  // Reviewers open the recording via the in-Cortex review route
  // (/admin/opportunities/:id/sessions/:sessionId/review); the old cross-origin
  // firsthand_review_url was retired with the HMAC seam.
  res.json(result.rows);
}));

// ─── Native survey results, scoped to the opportunity ────────────────────────
//
// The researcher-facing counterpart to GET /api/firsthand/studies/:id/results,
// which stays superadmin-only. That route aggregates a study across EVERY
// opportunity that used it, and reusing a study you did not author is a
// designed feature - so its owner would be handed answers from participants
// another researcher recruited, under that researcher's consent wording.
//
// An opportunity is the unit a researcher actually owns, so it is the unit
// these read. Gated exactly like /:id/session-events above.

/**
 * BOTH pools, because these routes read across both.
 *
 * The opportunity and its owner come from the main Cortex pool; the questions
 * and the answers come from the FirstHand runtime pool, which is configured
 * separately. Checking only the first meant an unconfigured runtime pool made
 * `getStudyById` answer null, and the route reported "Survey not found" - which
 * tells a researcher their survey does not exist during an outage. The
 * study-wide twin has always answered 503 for the same condition.
 */
async function surveyResultsAreReadable(): Promise<boolean> {
  return (await isDatabaseAvailable()) && isStudiesPersistenceConfigured();
}

type OpportunityResultsContext = {
  /** The id Postgres parsed, which is what runtime_sessions stores. */
  canonicalOpportunityId: string;
  steps: StudyStep[];
  studyId: string;
  title: string;
};

/**
 * Resolves the opportunity, enforces the gate, and loads the linked questions.
 *
 * Throws rather than writing to `res`, and every caller must await it BEFORE
 * setting a single response header. Express keeps an already-set Content-Type,
 * so a refusal placed after the CSV headers still hands over the file.
 */
async function loadOpportunityResultsContext(
  req: Request
): Promise<OpportunityResultsContext> {
  const { id } = req.params;

  const opportunityResult = await pool.query(
    'SELECT id, owner_user_id, firsthand_study_id FROM opportunities WHERE id = $1',
    [id]
  );

  if (opportunityResult.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }

  const row = opportunityResult.rows[0];

  // Owner or superadmin, and refused before anything is read - not after.
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && row.owner_user_id !== req.user!.id) {
    logger.warn('Refused a survey results read below the opportunity owner', {
      opportunityId: id,
      userId: req.user!.id
    });
    throw new ForbiddenError('Only the opportunity owner can view survey responses');
  }

  if (!row.firsthand_study_id) {
    throw new NotFoundError('Survey');
  }

  const stored = await getStudyById(row.firsthand_study_id);
  if (!stored) {
    throw new NotFoundError('Survey');
  }

  // Deliberately NOT gated on delivery_mode or type. Answers already collected
  // natively survive a switch to external delivery, and they are still this
  // researcher's data - refusing would hide it from the only person entitled
  // to it, without unpublishing anything.
  return {
    // String(), not req.params.id: `opportunities.id` is uuid so Postgres
    // matched braces, case and odd hyphens, while `runtime_sessions
    // .opportunity_id` is TEXT and compares bytes. Filtering on the raw path
    // segment would silently return no answers for a URL written any other way.
    canonicalOpportunityId: String(row.id),
    steps: stored.steps,
    studyId: row.firsthand_study_id,
    title: stored.study.title
  };
}

// GET /api/opportunities/:id/survey-results - aggregated answers
router.get('/:id/survey-results', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!(await surveyResultsAreReadable())) {
    // Not an empty result set: zero respondents is a finding, and one this
    // route would have no evidence for.
    return res.status(503).json({ error: 'Survey results are not available' });
  }

  const context = await loadOpportunityResultsContext(req);

  const responses = await listResponsesForOpportunity({
    opportunityId: context.canonicalOpportunityId,
    studyId: context.studyId
  });

  return res.json({
    title: context.title,
    results: aggregateSurveyResults(context.steps, responses)
  });
}));

// GET /api/opportunities/:id/survey-results.csv - raw answers for export
router.get('/:id/survey-results.csv', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!(await surveyResultsAreReadable())) {
    return res.status(503).json({ error: 'Survey results are not available' });
  }

  // Everything that can refuse happens here, before the first setHeader below.
  // Express keeps an already-set Content-Type through an error, so a 403
  // written after these headers would still have offered the download.
  const context = await loadOpportunityResultsContext(req);

  const responses = await listResponsesForOpportunity({
    opportunityId: context.canonicalOpportunityId,
    studyId: context.studyId
  });

  // Everything that can throw is done BEFORE the first setHeader, not just
  // everything that can refuse. Express keeps an already-set Content-Type
  // through the error handler, so a throw below this line would have served a
  // JSON error object as a file called "<title> responses.csv".
  const disposition = toCsvContentDisposition(context.title);
  const body = toResponsesCsv(context.steps, responses);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', disposition);

  return res.send(body);
}));

// DELETE /api/opportunities/:id - Delete opportunity
router.delete('/:id', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    const { id } = req.params;
    
    // Check if opportunity exists
    const existingOpportunity = getMockOpportunity(id);
    if (!existingOpportunity) {
      throw new NotFoundError('Opportunity');
    }
    
    // Check ownership (superadmins can delete any)
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && existingOpportunity.owner_user_id !== req.user!.id) {
      throw new ForbiddenError('Only the owner can delete this opportunity');
    }
    
    // Delete the opportunity
    const deleted = deleteMockOpportunity(id);
    if (!deleted) {
      throw new NotFoundError('Opportunity');
    }
    
    return res.status(204).send();
  }
  
  const { id } = req.params;
  
  // Check ownership
  const ownershipCheck = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [id]
  );
  
  if (ownershipCheck.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }
  
  // Check ownership (superadmins can delete any)
  const isOwner = ownershipCheck.rows[0].owner_user_id === req.user!.id;
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOwner) {
    throw new ForbiddenError('Only the owner can delete this opportunity');
  }
  
  await pool.query('DELETE FROM opportunities WHERE id = $1', [id]);

  res.status(204).send();
}));

// POST /api/opportunities/:id/duplicate - Duplicate opportunity
router.post('/:id/duplicate', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    const { id } = req.params;

    // Check if opportunity exists
    const existingOpportunity = getMockOpportunity(id);
    if (!existingOpportunity) {
      throw new NotFoundError('Opportunity');
    }

    // Check ownership (superadmins can duplicate any)
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && existingOpportunity.owner_user_id !== req.user!.id) {
      throw new ForbiddenError('Only the owner can duplicate this opportunity');
    }

    // Create duplicate as draft
    const duplicateOpportunity = {
      id: `mock-${Date.now()}`,
      type: existingOpportunity.type,
      title: `${existingOpportunity.title} (copy)`,
      purpose_one_liner: existingOpportunity.purpose_one_liner,
      description_optional: existingOpportunity.description_optional,
      product_optional: existingOpportunity.product_optional,
      default_duration_minutes: existingOpportunity.default_duration_minutes,
      status: 'draft' as const,
      owner_user_id: req.user!.id,
      external_link_optional: existingOpportunity.external_link_optional,
      participant_type_required: existingOpportunity.participant_type_required,
      participant_type_specific_details: existingOpportunity.participant_type_specific_details,
      created_at: new Date(),
      updated_at: new Date(),
      owner_name: req.user!.name,
      owner_email: req.user!.email,
      sessions: []
    };

    addMockOpportunity(duplicateOpportunity);

    return res.status(201).json(duplicateOpportunity);
  }

  const { id } = req.params;

  // Check ownership
  const ownershipCheck = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [id]
  );

  if (ownershipCheck.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }

  // Check ownership (superadmins can duplicate any)
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && ownershipCheck.rows[0].owner_user_id !== req.user!.id) {
    throw new ForbiddenError('Only the owner can duplicate this opportunity');
  }

  // Get the original opportunity
  const original = await pool.query('SELECT * FROM opportunities WHERE id = $1', [id]);
  if (original.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }

  const opp = original.rows[0];

  // Create duplicate as draft
  const query = `
    INSERT INTO opportunities (
      type, title, purpose_one_liner, description_optional,
      product_optional, default_duration_minutes, status,
      owner_user_id, external_link_optional, participant_type_required, participant_type_specific_details
    ) VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10)
    RETURNING *
  `;

  const values = [
    opp.type,
    `${opp.title} (copy)`,
    opp.purpose_one_liner,
    opp.description_optional,
    opp.product_optional,
    opp.default_duration_minutes,
    req.user!.id,
    opp.external_link_optional,
    opp.participant_type_required,
    opp.participant_type_specific_details
  ];

  const result = await pool.query(query, values);
  const duplicatedOpportunity = result.rows[0];

  // Add empty sessions array for consistency with frontend
  duplicatedOpportunity.sessions = [];

  res.status(201).json(duplicatedOpportunity);
}));

// POST /api/opportunities/:id/close-if-past - Utility to close opportunity if all sessions are past
router.post('/:id/close-if-past', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { id: opportunityId } = req.params;

  // Check opportunity ownership
  const opportunityCheck = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [opportunityId]
  );

  if (opportunityCheck.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }

  // Check ownership (superadmins can close any)
  const isOwner = opportunityCheck.rows[0].owner_user_id === req.user!.id;
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOwner) {
    throw new ForbiddenError('Only the owner can close this opportunity');
  }

  await autoCloseOpportunityIfNeeded(opportunityId);

  res.json({ message: 'Opportunity auto-close check completed' });
}));

// GET /api/opportunities/:id/sessions - Get sessions for an opportunity
router.get('/:id/sessions', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id: opportunityId } = req.params;
    const from = req.query.from as string | undefined;
    const include_past = req.query.include_past as string | undefined;
    
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      // Use mock data for development
      const opportunity = getMockOpportunity(opportunityId);
      if (!opportunity) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      
      const isAdmin = req.user?.role === 'researcher_admin' || req.user?.role === 'superadmin';
      
      // Non-admin users can only see published opportunities
      if (!isAdmin && opportunity.status !== 'published') {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      
      // Get mock sessions for this opportunity
      const mockSessions = getMockSessions(opportunityId);
      
      // Apply filters similar to database query
      let filteredSessions = mockSessions;
      
      // Filter by start time if provided
      if (from) {
        const fromDate = new Date(from as string);
        filteredSessions = filteredSessions.filter(session => 
          new Date(session.start_time) >= fromDate
        );
      }
      
      // Filter out past sessions unless explicitly requested
      if (include_past !== 'true') {
        const now = new Date();
        filteredSessions = filteredSessions.filter(session => 
          new Date(session.end_time) >= now
        );
      }
      
      // Sort by start time
      filteredSessions.sort((a, b) => 
        new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
      );
      
      return res.json(isAdmin ? filteredSessions : filteredSessions.map(toPublicSession));
    }
    
    // Check if opportunity exists and user has access - LEFT JOIN for demo/session-only owners
    const opportunityCheck = await pool.query(`
      SELECT o.*, u.name as owner_name, u.email as owner_email
      FROM opportunities o
      LEFT JOIN users u ON o.owner_user_id = u.id
      WHERE o.id = $1
    `, [opportunityId]);
    
    if (opportunityCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    
    const opportunity = opportunityCheck.rows[0];
    const isAdmin = req.user?.role === 'researcher_admin' || req.user?.role === 'superadmin';
    
    // Non-admin users can only see published opportunities
    if (!isAdmin && opportunity.status !== 'published') {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    
    // Build query for sessions with dynamic booked_count calculation
    let query = `
      SELECT s.*,
             COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)::int as actual_booked_count
      FROM sessions s
      LEFT JOIN bookings b ON s.id = b.session_id
      WHERE s.opportunity_id = $1
    `;
    const params: string[] = [opportunityId];
    let paramCount = 1;

    // Filter by start time if provided
    if (from) {
      paramCount++;
      query += ` AND s.start_time >= $${paramCount}`;
      params.push(from);
    }

    // Filter out past sessions unless explicitly requested
    if (include_past !== 'true') {
      query += ` AND s.end_time >= NOW()`;
    }

    query += ` GROUP BY s.id, s.opportunity_id, s.start_time, s.end_time, s.capacity,
               s.location_or_meet_link_optional, s.created_at, s.updated_at, s.booked_count`;
    query += ` ORDER BY s.start_time ASC`;

    const result = await pool.query(query, params);

    // Serialize dates for API response
    const sessions = result.rows.map(session => ({
      ...session,
      booked_count: session.actual_booked_count, // Use calculated value
      remaining: session.capacity - (session.actual_booked_count || 0), // Calculate from actual bookings
      start_time: session.start_time.toISOString(),
      end_time: session.end_time.toISOString(),
      created_at: session.created_at.toISOString(),
      updated_at: session.updated_at.toISOString(),
    }));
    
    // Same strip as the opportunity routes: this endpoint is optionalAuth and
    // returns bare session rows, so without this the joining link goes out to
    // anonymous callers by a different door.
    res.json(isAdmin ? sessions : sessions.map(toPublicSession));
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error fetching sessions', { error });
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
}));

// POST /api/opportunities/:id/sessions - Create sessions for an opportunity
router.post('/:id/sessions', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id: opportunityId } = req.params;
    const sessionsData = req.body;
    
    // Handle both single session and array of sessions
    const sessions = Array.isArray(sessionsData) ? sessionsData : [sessionsData];
    
    if (sessions.length === 0) {
      return res.status(400).json({ error: 'At least one session is required' });
    }
    
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      // Use mock data for development
      const opportunity = getMockOpportunity(opportunityId);
      if (!opportunity) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      
      // Check ownership (superadmins can add sessions to any)
      const isSuperadmin = req.user!.role === 'superadmin';
      if (!isSuperadmin && opportunity.owner_user_id !== req.user!.id) {
        return res.status(403).json({ error: 'Only the owner can add sessions to this opportunity' });
      }
      
      // Validate all sessions
      const validationErrors: string[] = [];
      sessions.forEach((session, index) => {
        const errors = validateSessionData(session);
        errors.forEach(error => validationErrors.push(`Session ${index + 1}: ${error}`));
      });
      
      if (validationErrors.length > 0) {
        return res.status(400).json({ error: 'Validation failed', details: validationErrors });
      }
      
      // Create mock sessions
      const createdSessions = addMockSessions(opportunityId, sessions);
      
      return res.status(201).json(createdSessions);
    }
    
    // Check opportunity ownership
    const opportunityCheck = await pool.query(
      'SELECT owner_user_id FROM opportunities WHERE id = $1',
      [opportunityId]
    );
    
    if (opportunityCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    
    // Check ownership (superadmins can add sessions to any)
    const isOwner = opportunityCheck.rows[0].owner_user_id === req.user!.id;
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && !isOwner) {
      return res.status(403).json({ error: 'Only the owner can add sessions to this opportunity' });
    }
    
    // Validate all sessions
    const validationErrors: string[] = [];
    sessions.forEach((session, index) => {
      const errors = validateSessionData(session);
      errors.forEach(error => validationErrors.push(`Session ${index + 1}: ${error}`));
    });
    
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors });
    }
    
    // Check for overlaps within the batch
    for (let i = 0; i < sessions.length; i++) {
      for (let j = i + 1; j < sessions.length; j++) {
        const session1 = sessions[i];
        const session2 = sessions[j];
        const start1 = new Date(session1.start_time);
        const end1 = new Date(session1.end_time);
        const start2 = new Date(session2.start_time);
        const end2 = new Date(session2.end_time);
        
        if ((start1 < end2) && (start2 < end1)) {
          return res.status(409).json({ 
            error: `Sessions ${i + 1} and ${j + 1} overlap in time` 
          });
        }
      }
    }
    
    // Create sessions in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const createdSessions: Session[] = [];
      
      for (const session of sessions) {
        const query = `
          INSERT INTO sessions (
            opportunity_id, start_time, end_time, capacity, 
            location_or_meet_link_optional
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING *, (capacity - booked_count) as remaining
        `;
        
        const values = [
          opportunityId,
          session.start_time,
          session.end_time,
          session.capacity,
          session.location_or_meet_link_optional || null
        ];
        
        const result = await client.query(query, values);
        const createdSession = {
          ...result.rows[0],
          start_time: result.rows[0].start_time.toISOString(),
          end_time: result.rows[0].end_time.toISOString(),
          created_at: result.rows[0].created_at.toISOString(),
          updated_at: result.rows[0].updated_at.toISOString(),
        };
        createdSessions.push(createdSession);
      }
      
      await client.query('COMMIT');
      
      res.status(201).json(createdSessions);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error creating sessions', { error });
    res.status(500).json({ error: 'Failed to create sessions' });
  }
}));

// DELETE /api/opportunities/:id/sessions - Delete all sessions for an opportunity
router.delete('/:id/sessions', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id: opportunityId } = req.params;
    
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      // Use mock data for development
      const opportunity = getMockOpportunity(opportunityId);
      if (!opportunity) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      
      // Check ownership (superadmins can delete sessions from any)
      const isSuperadmin = req.user!.role === 'superadmin';
      if (!isSuperadmin && opportunity.owner_user_id !== req.user!.id) {
        return res.status(403).json({ error: 'Only the owner can delete sessions from this opportunity' });
      }
      
      // Get all sessions for this opportunity
      const sessions = getMockSessions(opportunityId);
      
      // Check if any sessions have bookings
      const sessionsWithBookings = sessions.filter(session => session.booked_count > 0);
      if (sessionsWithBookings.length > 0) {
        return res.status(400).json({ 
          error: `Cannot delete sessions with existing bookings. ${sessionsWithBookings.length} session(s) have bookings.` 
        });
      }
      
      // Delete all sessions (this would need to be implemented in mock-data.ts)
      // For now, return success
      return res.json({ 
        message: 'All sessions deleted successfully', 
        deleted_count: sessions.length 
      });
    }
    
    // Check opportunity ownership
    const opportunityCheck = await pool.query(
      'SELECT owner_user_id FROM opportunities WHERE id = $1',
      [opportunityId]
    );
    
    if (opportunityCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    
    // Check ownership (superadmins can delete sessions from any)
    const isOwner = opportunityCheck.rows[0].owner_user_id === req.user!.id;
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && !isOwner) {
      return res.status(403).json({ error: 'Only the owner can delete sessions from this opportunity' });
    }
    
    // Check if any sessions have bookings
    const sessionsCheck = await pool.query(
      'SELECT s.id FROM sessions s WHERE s.opportunity_id = $1 AND EXISTS (SELECT 1 FROM bookings b WHERE b.session_id = s.id AND b.status = \'booked\')',
      [opportunityId]
    );
    
    if (sessionsCheck.rows.length > 0) {
      return res.status(400).json({ 
        error: `Cannot delete sessions with existing bookings. ${sessionsCheck.rows.length} session(s) have bookings.` 
      });
    }
    
    // Delete all bookings first (ON DELETE CASCADE should handle this, but explicit is safer)
    await pool.query(
      'DELETE FROM bookings WHERE session_id IN (SELECT id FROM sessions WHERE opportunity_id = $1)',
      [opportunityId]
    );
    
    // Delete all sessions for this opportunity
    const deleteResult = await pool.query(
      'DELETE FROM sessions WHERE opportunity_id = $1',
      [opportunityId]
    );
    
    res.json({ 
      message: 'All sessions deleted successfully', 
      deleted_count: deleteResult.rowCount 
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error deleting sessions', { error });
    res.status(500).json({ error: 'Failed to delete sessions' });
  }
}));

// POST /api/opportunities/:id/click - Track click for poll/survey
router.post('/:id/click', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id: opportunityId } = req.params;

  // Validate click_type at the boundary. 'view' = study details viewed on mount,
  // 'action' = action button clicked. Defaults to 'action' for older clients that
  // don't send it. Persisting this is what keeps views and actions distinct in
  // analytics - previously it was dropped and every row fell back to the column
  // default 'action', so "Study Views" always read 0.
  const rawClickType = req.body?.click_type ?? 'action';
  if (rawClickType !== 'view' && rawClickType !== 'action') {
    throw new ValidationError("click_type must be 'view' or 'action'");
  }
  const clickType: 'view' | 'action' = rawClickType;

  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // In demo mode, just return success
    return res.json({ ok: true });
  }

  // Load opportunity to check type and status
  const opportunityResult = await pool.query(
    'SELECT id, type, status FROM opportunities WHERE id = $1',
    [opportunityId]
  );

  if (opportunityResult.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }

  const opportunity = opportunityResult.rows[0];

  // Only allow click tracking for poll, survey, or unmoderated types
  if (opportunity.type !== 'poll' && opportunity.type !== 'survey' && opportunity.type !== 'unmoderated') {
    throw new ValidationError('Click tracking is only available for polls, surveys, and unmoderated tests');
  }

  // Only allow tracking for published opportunities
  if (opportunity.status !== 'published') {
    throw new NotFoundError('Opportunity not published');
  }

  // Get user ID if authenticated, otherwise null
  const userId = req.user?.id || null;

  // Get user agent and IP for tracking (privacy-aware)
  const userAgent = req.headers['user-agent'] || null;
  const clientIp = req.ip || req.socket.remoteAddress || null;
  
  // Hash IP address for privacy
  let ipHash = null;
  if (clientIp && process.env.SESSION_SECRET) {
    ipHash = crypto
      .createHash('sha256')
      .update(clientIp + process.env.SESSION_SECRET)
      .digest('hex')
      .substring(0, 32); // Store only first 32 chars
  }

  // Record the click
  await pool.query(
    `INSERT INTO opportunity_clicks (opportunity_id, user_id, click_type, user_agent, ip_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [opportunityId, userId, clickType, userAgent, ipHash]
  );

  res.json({ ok: true });
}));

const ANALYTICS_WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VALID_ANALYTICS_PERIODS = [7, 14, 30];

// GET /api/opportunities/:id/analytics - Get click analytics for admin
router.get('/:id/analytics', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { id: opportunityId } = req.params;
  const userId = req.user!.id;

  const requestedPeriod = parseInt(req.query.period as string, 10);
  const period = VALID_ANALYTICS_PERIODS.includes(requestedPeriod) ? requestedPeriod : 30;

  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    return res.json({
      clicks_total: 0,
      clicks_24h: 0,
      clicks_7d: 0,
      unique_users: 0,
      avg_clicks_per_day: 0,
      week_over_week_change: null,
      views_total: 0,
      views_24h: 0,
      views_7d: 0,
      unique_viewers: 0,
      actions_total: 0,
      actions_24h: 0,
      actions_7d: 0,
      unique_actors: 0,
      conversion_rate: 0,
      first_click: null,
      last_click: null,
      opportunity_created: null,
      peak_day: null,
      peak_hour: null,
      clicks_by_day: [],
      clicks_by_hour: [],
      clicks_by_weekday: [],
      period_clicks_total: 0,
      period_views_total: 0,
      period_actions_total: 0,
      time_zone: ANALYTICS_TIME_ZONE,
      period
    });
  }

  // Check opportunity ownership
  const opportunityResult = await pool.query(
    'SELECT owner_user_id, created_at FROM opportunities WHERE id = $1',
    [opportunityId]
  );

  if (opportunityResult.rows.length === 0) {
    throw new NotFoundError('Opportunity');
  }

  const opportunity = opportunityResult.rows[0];

  // Only owner or superadmin can view analytics
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && opportunity.owner_user_id !== userId) {
    throw new ForbiddenError('Only the opportunity owner can view analytics');
  }

  // Overall totals (all-time), independent of the selected chart period
  const overallResult = await pool.query(
    `SELECT
      COUNT(*)::int AS total,
      COUNT(DISTINCT user_id)::int AS unique_users,
      COUNT(*) FILTER (WHERE clicked_at >= NOW() - INTERVAL '24 hours')::int AS count_24h,
      COUNT(*) FILTER (WHERE clicked_at >= NOW() - INTERVAL '7 days')::int AS count_7d,
      MIN(clicked_at) AS first_click,
      MAX(clicked_at) AS last_click
     FROM opportunity_clicks
     WHERE opportunity_id = $1`,
    [opportunityId]
  );
  const overall = overallResult.rows[0];

  // Totals split by click_type ('view' = study details viewed, 'action' = link opened / session booked)
  const byTypeResult = await pool.query(
    `SELECT
      click_type,
      COUNT(*)::int AS total,
      COUNT(DISTINCT user_id)::int AS unique_count,
      COUNT(*) FILTER (WHERE clicked_at >= NOW() - INTERVAL '24 hours')::int AS count_24h,
      COUNT(*) FILTER (WHERE clicked_at >= NOW() - INTERVAL '7 days')::int AS count_7d
     FROM opportunity_clicks
     WHERE opportunity_id = $1
     GROUP BY click_type`,
    [opportunityId]
  );
  const viewStats = byTypeResult.rows.find((r: { click_type: string }) => r.click_type === 'view') || {};
  const actionStats = byTypeResult.rows.find((r: { click_type: string }) => r.click_type === 'action') || {};

  // Daily breakdown (views/actions split) over the selected period.
  //
  // Bucketed in the analytics zone, and returned as TEXT. Both halves matter.
  // `DATE(clicked_at)` alone cut the day in the DATABASE session's zone (UTC in
  // every deployment), and node-postgres then handed the result to JS as a Date
  // at LOCAL midnight, which `toISOString().split('T')[0]` read back as the
  // previous day in any positive offset. The endpoint reported clicks on the
  // 15th whose own first_click it reported as the 16th. `to_char` hands back a
  // string, so there is nothing left to reinterpret.
  const dailyResult = await pool.query(
    `SELECT
      to_char(clicked_at AT TIME ZONE $3, 'YYYY-MM-DD') AS date,
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE click_type = 'view')::int AS views,
      COUNT(*) FILTER (WHERE click_type = 'action')::int AS actions
     FROM opportunity_clicks
     WHERE opportunity_id = $1
       AND clicked_at >= NOW() - ($2 * INTERVAL '1 day')
     GROUP BY to_char(clicked_at AT TIME ZONE $3, 'YYYY-MM-DD')
     ORDER BY date ASC`,
    [opportunityId, period, ANALYTICS_TIME_ZONE]
  );
  const clicks_by_day = dailyResult.rows
    .map((row: { date: string | Date; count: number; views: number; actions: number }) => ({
      date: toAnalyticsDateString(row.date),
      count: row.count,
      views: row.views,
      actions: row.actions
    }))
    .filter((day): day is { date: string; count: number; views: number; actions: number } =>
      day.date !== null
    );

  // Hourly breakdown over the selected period
  const hourlyResult = await pool.query(
    `SELECT
      EXTRACT(HOUR FROM clicked_at AT TIME ZONE $3)::int AS hour,
      COUNT(*)::int AS count
     FROM opportunity_clicks
     WHERE opportunity_id = $1
       AND clicked_at >= NOW() - ($2 * INTERVAL '1 day')
     GROUP BY hour
     ORDER BY hour ASC`,
    [opportunityId, period, ANALYTICS_TIME_ZONE]
  );
  const hourCounts = new Map<number, number>(hourlyResult.rows.map((r: { hour: number; count: number }) => [r.hour, r.count]));
  const clicks_by_hour = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: hourCounts.get(hour) || 0
  }));

  // Day-of-week breakdown over the selected period (0 = Sunday, matching Postgres DOW)
  const weekdayResult = await pool.query(
    `SELECT
      EXTRACT(DOW FROM clicked_at AT TIME ZONE $3)::int AS weekday_num,
      COUNT(*)::int AS count
     FROM opportunity_clicks
     WHERE opportunity_id = $1
       AND clicked_at >= NOW() - ($2 * INTERVAL '1 day')
     GROUP BY weekday_num
     ORDER BY weekday_num ASC`,
    [opportunityId, period, ANALYTICS_TIME_ZONE]
  );
  const weekdayCounts = new Map<number, number>(weekdayResult.rows.map((r: { weekday_num: number; count: number }) => [r.weekday_num, r.count]));
  const clicks_by_weekday = ANALYTICS_WEEKDAY_NAMES.map((weekday, weekday_num) => ({
    weekday,
    weekday_num,
    count: weekdayCounts.get(weekday_num) || 0
  }));

  // Previous 7-day window (8-14 days ago), to compute week-over-week change
  const prevWeekResult = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM opportunity_clicks
     WHERE opportunity_id = $1
       AND clicked_at >= NOW() - INTERVAL '14 days'
       AND clicked_at < NOW() - INTERVAL '7 days'`,
    [opportunityId]
  );
  const prevWeekCount = prevWeekResult.rows[0].count;

  const clicks_total = overall.total || 0;
  const clicks_7d = overall.count_7d || 0;
  const views_total = viewStats.total || 0;
  const actions_total = actionStats.total || 0;

  const peak_day = clicks_by_day.length > 0
    ? clicks_by_day.reduce((max, day) => (day.count > max.count ? day : max), clicks_by_day[0])
    : null;

  const peakHourEntry = clicks_by_hour.reduce((max, hour) => (hour.count > max.count ? hour : max), clicks_by_hour[0]);
  const peak_hour = peakHourEntry.count > 0
    ? { hour: peakHourEntry.hour, hour_label: `${peakHourEntry.hour}:00`, count: peakHourEntry.count }
    : null;

  const periodClicksTotal = clicks_by_day.reduce((sum, day) => sum + day.count, 0);
  const conversionPercentage = views_total > 0 ? (actions_total / views_total) * 100 : 0;

  res.json({
    clicks_total,
    clicks_24h: overall.count_24h || 0,
    clicks_7d,
    unique_users: overall.unique_users || 0,
    avg_clicks_per_day: Math.round((periodClicksTotal / period) * 10) / 10,
    week_over_week_change: weekOverWeekChange(clicks_7d, prevWeekCount),

    views_total,
    views_24h: viewStats.count_24h || 0,
    views_7d: viewStats.count_7d || 0,
    unique_viewers: viewStats.unique_count || 0,

    actions_total,
    actions_24h: actionStats.count_24h || 0,
    actions_7d: actionStats.count_7d || 0,
    unique_actors: actionStats.unique_count || 0,

    conversion_rate: Math.round(conversionPercentage * 10) / 10,

    first_click: overall.first_click ? new Date(overall.first_click).toISOString() : null,
    last_click: overall.last_click ? new Date(overall.last_click).toISOString() : null,
    opportunity_created: new Date(opportunity.created_at).toISOString(),

    peak_day,
    peak_hour,

    // The chart cards used to print a 7-day total beside a 30-day chart. The
    // period totals travel with the period so the header can stop disagreeing
    // with its own title.
    period_clicks_total: periodClicksTotal,
    period_views_total: clicks_by_day.reduce((sum, day) => sum + day.views, 0),
    period_actions_total: clicks_by_day.reduce((sum, day) => sum + day.actions, 0),

    // Days and hours are cut in this zone, not the reader's. Named so the page
    // can say so rather than leaving everyone to assume it is theirs.
    time_zone: ANALYTICS_TIME_ZONE,

    clicks_by_day,
    clicks_by_hour,
    clicks_by_weekday,

    period
  });
}));

export default router;
