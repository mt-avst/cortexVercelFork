import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// Mock the database pool for testing (factory uses only inline jest.fn() to avoid TDZ)
// #14: route suites use the session-trusting auth double (see middleware/__mocks__/authenticate.ts);
// the real gate now re-reads the DB role, which their positional pool mock cannot satisfy.
jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  }
}));

// Without this, isDatabaseAvailable() resolves false in the test process (no
// DATABASE_URL), and every route silently falls back to the in-memory mock-data
// store instead of exercising pool.query at all.
jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

jest.mock('../../firsthand/session-create', () => ({
  createSession: jest.fn(),
}));

// The create route builds a study from an inline payload. Mocked so these tests
// stay on the app pool and never reach the FirstHand runtime pool.
jest.mock('../../firsthand/runtime-repository-postgres', () => ({
  // Defaults to "this participant has no session yet", which is the common
  // case. Tests that care about resuming or refusing queue their own.
  findParticipantSessionForOpportunity: jest.fn(async () => null),
  // Defaults to "no completion trace for anyone". Row-10 tests queue their own.
  findParticipantCompletionsForOpportunities: jest.fn(async () => []),
}));

// Defaults to "nobody answered". Every results test that cares queues its own
// rows; the point of the default is that a test which never reaches the read
// still gets a call count of zero to assert on.
jest.mock('../../firsthand/survey-results-repository', () => {
  const listed = jest.fn(async () => [] as import('../../firsthand/survey-results').StoredResponse[]);
  const scopeSpy = jest.fn();
  /** Records the AbortSignal the ROUTE passed into the export. */
  const signalSpy = jest.fn();
  return {
    listResponsesForOpportunity: listed,
    /**
     * A FAITHFUL STAND-IN, not a stub. The streamed export reads through
     * `openSurveyCsvExport`, not `listResponsesForOpportunity`, so a factory
     * listing only the old exports left it `undefined` and the route answered
     * 500 - for a reason no assertion here names. Built over the
     * already-mocked reader and the REAL column grouping, so every test that
     * queues rows keeps working and the stand-in cannot disagree with
     * production about the columns or their order.
     */
    // Records the scope the ROUTE chose. Without it the route's
    // `kind: 'opportunity'` can be mutated to `kind: 'study'` and every test
    // still passes - handing a researcher every opportunity's answers for a
    // study they merely share. The repository tests cannot see this: they
    // exercise the clause, not the caller's choice of it.
    __scopeSpy: scopeSpy,
    __signalSpy: signalSpy,
    openSurveyCsvExport: async (...args: unknown[]) => {
      scopeSpy(args[0]);
      const rows = (await listed(...(args as []))) ?? [];
      const { removedQuestionColumns } =
        jest.requireActual<typeof import('../../firsthand/survey-csv')>(
          '../../firsthand/survey-csv'
        );

      const byParticipant = new Map<
        string,
        import('../../firsthand/survey-results').StoredResponse[]
      >();
      for (const row of rows) {
        const group = byParticipant.get(row.session_id) ?? [];
        group.push(row);
        byParticipant.set(row.session_id, group);
      }

      return {
        removedQuestions: removedQuestionColumns(rows),
        // TAKES THE SIGNAL AND RECORDS IT, which is the only way the route's
        // side of the deadline plumbing can be seen from here. The route hands
        // `csvExport.participants` over uncalled; a mutation handing over
        // `() => csvExport.participants(new AbortController().signal)` instead
        // type-checks and passes the whole suite, and silently unbounds the
        // database half of the export's deadline. A required parameter stops a
        // caller passing NOTHING; it cannot stop them passing something ELSE.
        participants: async function* (signal: AbortSignal) {
          signalSpy(signal);
          for (const [sessionId, answers] of byParticipant) {
            yield { sessionId, answers };
          }
        },
      };
    },
  // Defaults to "nobody has answered yet", which is the state in which an
  // in-place study rewrite is safe. Every test that cares queues its own.
  //
  // Omitting it from this factory does not fail with a missing-mock message:
  // the route awaits `undefined(...)` and answers 500, which reads as a route
  // bug. Fourth occurrence of that shape in this repo.
    studyHasResponses: jest.fn(async () => false),
  };
});

// Real implementations, but spy-able: one test needs the CSV serialiser to
// throw, to prove nothing that can throw runs after res.setHeader.
jest.mock('../../firsthand/survey-csv', () => {
  const actual = jest.requireActual<typeof import('../../firsthand/survey-csv')>(
    '../../firsthand/survey-csv'
  );
  return {
    ...actual,
    // The streamed export never calls `toResponsesCsv`. The per-participant
    // emitter is what it does call, and it is the only place left where a
    // failure can happen AFTER the response has committed to 200.
    toCsvParticipantRow: jest.fn(actual.toCsvParticipantRow),
  };
});

jest.mock('../../firsthand/studies-repository', () => ({
  // The real, pure ownership rule rather than a hand-duplicated copy that
  // could drift from it - the same reason toResponsesCsv above is a spy-able
  // real implementation instead of a stub.
  canWriteStudy: jest.requireActual<typeof import('../../firsthand/studies-repository')>(
    '../../firsthand/studies-repository'
  ).canWriteStudy,
  createStudy: jest.fn(),
  countStudyTasks: jest.fn(),
  // Defaults to a study with no stated duration, which is the common case and
  // the one the brief must render as nothing rather than as a number.
  getStudyById: jest.fn(() =>
    Promise.resolve({
      study: {
        id: 'study_abc123',
        title: 'A study',
        intro_text: 'Intro',
        consent_text: 'Consent',
        // Every real study row has one: the column is NOT NULL and the
        // repository normalises it on read. A fixture without it made the
        // opportunity linkage check refuse a perfectly good recorded study.
        kind: 'recorded',
        estimated_duration_minutes: undefined,
        status: 'launched' as const,
        owner_user_id: 'test-user-id',
        copied_from_study_id: null,
        created_at: '2026-08-16T10:00:00.000Z',
        updated_at: '2026-08-16T10:00:00.000Z',
      },
      steps: [],
    })
  ),
  // Defaults to false: most tests link nothing, or link a study that already
  // has an owner, and only a real claim is worth reporting.
  claimStudyIfUnowned: jest.fn(() => Promise.resolve(false)),
  // Omitting this from the factory does not fail with a missing-mock message:
  // the route calls `updateStudy(...)` on `undefined` and answers 500, which
  // reads as a route bug. Third occurrence of that shape in this repo, so it
  // is worth the comment. Defaults to a successful in-place update by an
  // owner, which is the common case now that the opportunity form can edit a
  // linked study; every test that cares about a refusal queues its own.
  updateStudy: jest.fn(() =>
    Promise.resolve({
      ok: true as const,
      claimed: false,
      study: {
        id: 'study_abc123',
        title: 'A study',
        intro_text: 'Intro',
        consent_text: 'Consent',
        kind: 'recorded' as const,
        estimated_duration_minutes: undefined,
        status: 'launched' as const,
        owner_user_id: 'test-user-id',
        copied_from_study_id: null,
        created_at: '2026-08-16T10:00:00.000Z',
        updated_at: '2026-08-16T10:00:00.000Z',
      },
      steps: [],
    })
  ),
  deleteStudyUnchecked: jest.fn(),
  // Default true so the inline path runs; the route checks this before
  // building a study so a misconfigured runtime pool answers 503 rather than
  // letting createStudy throw a bare Error into the 500 branch.
  isStudiesPersistenceConfigured: jest.fn(() => true),
}));

import opportunitiesRouter, { NATIVE_SURVEY_STUDY_REQUIRED, STUDY_KIND_MISMATCH, resetParticipantRouteLimits } from '../opportunities';
import {
  EXTERNAL_LINK_PROTOCOL_MESSAGE,
  MEETING_LOCATION_SCHEME_MESSAGE
} from '../../../../shared/firsthand/url-safety';
import { addMockOpportunity, deleteMockOpportunity } from '../../../../demo/mock-data';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { createSession } from '../../firsthand/session-create';
import {
  findParticipantCompletionsForOpportunities,
  findParticipantSessionForOpportunity
} from '../../firsthand/runtime-repository-postgres';
import { claimStudyIfUnowned, countStudyTasks, createStudy, deleteStudyUnchecked, getStudyById, isStudiesPersistenceConfigured, updateStudy } from '../../firsthand/studies-repository';
import { listResponsesForOpportunity, studyHasResponses } from '../../firsthand/survey-results-repository';
import { toCsvParticipantRow } from '../../firsthand/survey-csv';
import { errorHandler, AppError } from '../../utils/errorHandler';
// Spied per-test rather than module-mocked: the route logs from a dozen places
// and silencing all of them for the whole file would hide more than it proves.
import { logger } from '../../utils/logger';
// The real serialiser, so the unchanged-sequence fixture is what the route
// actually computes rather than a hand-built shape that could never match.
import { toStudySteps } from '../../../../shared/firsthand/inline-study';
import { toSurveySteps } from '../../../../shared/firsthand/survey-authoring';

const mockQuery = pool.query as jest.MockedFunction<any>;
const mockConnect = pool.connect as jest.MockedFunction<any>;
const mockIsDatabaseAvailable = isDatabaseAvailable as jest.MockedFunction<any>;
const mockCreateSession = createSession as jest.MockedFunction<any>;
// Typed against the real signature rather than `any`: this file's
// no-explicit-any budget is held per file in eslint-suppressions.json, so one
// more untyped mock turns every existing one into an error.
const mockFindParticipantSession =
  findParticipantSessionForOpportunity as jest.MockedFunction<
    typeof findParticipantSessionForOpportunity
  >;
const mockFindParticipantCompletions =
  findParticipantCompletionsForOpportunities as jest.MockedFunction<
    typeof findParticipantCompletionsForOpportunities
  >;
const mockCreateStudy = createStudy as jest.MockedFunction<any>;
const mockClaimStudyIfUnowned = claimStudyIfUnowned as jest.MockedFunction<any>;
// Typed against the real signature rather than `any`: this file holds a
// per-file no-explicit-any budget in eslint-suppressions.json, so one more
// untyped mock turns every existing one into an error.
const mockUpdateStudy = updateStudy as jest.MockedFunction<typeof updateStudy>;
const mockDeleteStudyUnchecked = deleteStudyUnchecked as jest.MockedFunction<any>;
const mockCountStudyTasks = countStudyTasks as jest.MockedFunction<typeof countStudyTasks>;
const mockGetStudyById = getStudyById as jest.MockedFunction<typeof getStudyById>;
const mockIsStudiesPersistenceConfigured = isStudiesPersistenceConfigured as jest.MockedFunction<any>;
const mockListResponsesForOpportunity =
  listResponsesForOpportunity as jest.MockedFunction<typeof listResponsesForOpportunity>;
const mockStudyHasResponses =
  studyHasResponses as jest.MockedFunction<typeof studyHasResponses>;
const mockToCsvParticipantRow = toCsvParticipantRow as jest.MockedFunction<
  typeof toCsvParticipantRow
>;

const app = express();
app.use(express.json());

// Mock authentication middleware. requireAdmin/optionalAuth (../middleware/authenticate)
// only ever read req.session.user, never call session methods like .save()/.touch(),
// so a plain stub object is enough here — no need for (and no compatibility with) the
// real express-session middleware, whose response-finalization hooks expect those methods.
app.use((req: any, res, next) => {
  req.session = {
    user: {
      id: 'test-user-id',
      name: 'Test User',
      email: 'test@example.com',
      business_unit: 'Engineering',
      role_title: 'Developer',
      role: 'researcher_admin'
    }
  };
  next();
});

app.use('/api/opportunities', opportunitiesRouter);
// Routes throw AppError subclasses (NotFoundError/ForbiddenError/ValidationError) and
// rely on asyncHandler -> next(error) -> this handler to turn them into JSON responses.
// Without it, Express's default finalhandler sends text/html, and response.body.error
// assertions fail even when the status code happens to be right.
app.use(errorHandler);

describe('Opportunities API', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mock to return empty arrays by default
    mockQuery.mockResolvedValue({ rows: [] });
    mockIsDatabaseAvailable.mockResolvedValue(true);
    delete process.env.FRONTEND_URL;
    // The mint and results routes are rate limited per user, and the counters
    // live in an in-process store that outlives a test. Without this, a suite
    // that exercises them hundreds of times as one user starts answering 429
    // partway through and every later assertion fails for a reason none of
    // them names.
    for (const userId of ['test-user-id', 'superadmin-id', 'employee-id']) {
      resetParticipantRouteLimits(userId);
    }
  });


  describe('participant completion trace (audit row 10)', () => {
    const nativeSurveyRow = {
      id: 'op-nsv',
      type: 'survey',
      delivery_mode: 'native',
      title: 'How was it',
      purpose_one_liner: 'A quick survey',
      default_duration_minutes: 30,
      status: 'published',
      owner_user_id: 'someone-else',
      firsthand_study_id: 'study-1',
      external_link_optional: null,
      created_at: new Date('2026-09-01T10:00:00.000Z'),
      updated_at: new Date('2026-09-01T10:00:00.000Z'),
      start_date: null,
      end_date: null,
      owner_name: 'Owner',
      owner_email: 'owner@example.com'
    };

    it('marks a native survey the participant has completed, with its date', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [nativeSurveyRow] }); // opportunity row
      // the sessions query falls through to the default { rows: [] }
      mockFindParticipantCompletions.mockResolvedValueOnce([
        {
          opportunityId: 'op-nsv',
          sessionStatus: 'completed',
          completedAt: '2026-09-02T09:00:00.000Z'
        }
      ]);

      const response = await request(listening(app))
        .get('/api/opportunities/op-nsv')
        .expect(200);

      expect(response.body.completion).toEqual({
        completed: true,
        completedAt: '2026-09-02T09:00:00.000Z'
      });
      // Keyed on the signed-in user and the opportunity's own id.
      expect(mockFindParticipantCompletions).toHaveBeenCalledWith({
        participantId: 'test-user-id',
        opportunityIds: ['op-nsv']
      });
    });

    it('reports not-completed when the participant has no answered session', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [nativeSurveyRow] });
      // default completions mock returns [] - no row for this opportunity

      const response = await request(listening(app))
        .get('/api/opportunities/op-nsv')
        .expect(200);

      expect(response.body.completion).toEqual({ completed: false, completedAt: null });
    });

    it('does not treat a still-in-progress session as completed', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [nativeSurveyRow] });
      mockFindParticipantCompletions.mockResolvedValueOnce([
        { opportunityId: 'op-nsv', sessionStatus: 'link_opened', completedAt: null }
      ]);

      const response = await request(listening(app))
        .get('/api/opportunities/op-nsv')
        .expect(200);

      // An unfinished session resumes rather than blocks, so the trace must not
      // claim completion - otherwise the page would hide the Start button on a
      // survey the participant can still finish.
      expect(response.body.completion).toEqual({ completed: false, completedAt: null });
    });

    it('does not attach a completion trace to a bookable study', async () => {
      const bookableRow = {
        ...nativeSurveyRow,
        id: 'op-book',
        type: 'test',
        delivery_mode: 'external',
        firsthand_study_id: null
      };
      mockQuery.mockResolvedValueOnce({ rows: [bookableRow] });

      const response = await request(listening(app))
        .get('/api/opportunities/op-book')
        .expect(200);

      // A test/interview leaves its trace in bookings, not here, and the runtime
      // read must not even run for it.
      expect(response.body.completion).toBeUndefined();
      expect(mockFindParticipantCompletions).not.toHaveBeenCalled();
    });

    it('marks the completed native row in the listing and leaves others untouched', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          nativeSurveyRow,
          {
            ...nativeSurveyRow,
            id: 'op-int',
            type: 'interview',
            delivery_mode: 'external',
            firsthand_study_id: null
          }
        ]
      }); // listing query; the sessions and clicks batches fall to default []
      mockFindParticipantCompletions.mockResolvedValueOnce([
        {
          opportunityId: 'op-nsv',
          sessionStatus: 'completed',
          completedAt: '2026-09-02T09:00:00.000Z'
        }
      ]);

      const response = await request(listening(app))
        .get('/api/opportunities')
        .expect(200);

      const survey = response.body.find((o: { id: string }) => o.id === 'op-nsv');
      const interview = response.body.find((o: { id: string }) => o.id === 'op-int');
      expect(survey.completion).toEqual({
        completed: true,
        completedAt: '2026-09-02T09:00:00.000Z'
      });
      expect(interview.completion).toBeUndefined();
      // Only the native row is looked up - the bookable one never reaches the
      // runtime read.
      expect(mockFindParticipantCompletions).toHaveBeenCalledWith({
        participantId: 'test-user-id',
        opportunityIds: ['op-nsv']
      });
    });
  });

  describe('GET /api/opportunities', () => {
    it('should return opportunities list', async () => {
      const mockOpportunities = [
        {
          id: '1',
          type: 'test',
          title: 'Test Opportunity',
          purpose_one_liner: 'Testing purpose',
          description_optional: 'Test description',
          product_optional: 'Test Product',
          default_duration_minutes: 30,
          status: 'published',
          owner_user_id: 'test-user-id',
          external_link_optional: null,
          created_at: new Date(),
          updated_at: new Date(),
          owner_name: 'Test User',
          owner_email: 'test@example.com'
        }
      ];

      mockQuery.mockResolvedValueOnce({ rows: mockOpportunities });

      const response = await request(listening(app))
        .get('/api/opportunities')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({
        id: '1',
        type: 'test',
        title: 'Test Opportunity',
        sessions: []
      });
    });

    it('should filter by type', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(listening(app))
        .get('/api/opportunities?type=test')
        .expect(200);

      // With no other filters and an admin session, type is the only WHERE
      // condition, so it binds to $1 with no leading "AND".
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('o.type = $1'),
        expect.arrayContaining(['test'])
      );
    });

    it('should search by query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(listening(app))
        .get('/api/opportunities?q=test')
        .expect(200);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('ILIKE'),
        expect.arrayContaining(['%test%'])
      );
    });
  });

  describe('POST /api/opportunities', () => {
    it('should create a new opportunity', async () => {
      const newOpportunity = {
        id: '2',
        type: 'test',
        title: 'New Test',
        purpose_one_liner: 'New test purpose',
        default_duration_minutes: 45,
        status: 'draft',
        owner_user_id: 'test-user-id',
        created_at: new Date(),
        updated_at: new Date()
      };

      // Route upserts the session user into `users` before inserting the
      // opportunity, so two queries fire in order.
      mockQuery.mockResolvedValueOnce({ rows: [] }); // user upsert (result unused)
      mockQuery.mockResolvedValueOnce({ rows: [newOpportunity] }); // opportunity insert

      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'test',
          title: 'New Test',
          purpose_one_liner: 'New test purpose',
          default_duration_minutes: 45,
          status: 'draft'
        })
        .expect(201);

      expect(response.body).toMatchObject({
        id: '2',
        type: 'test',
        title: 'New Test',
        sessions: []
      });
    });

    it('should validate required fields', async () => {
      // Field presence is enforced by validateRequest(CreateOpportunitySchema) (zod),
      // which always responds with { error: 'Validation failed', details }.
      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'test'
          // Missing title and purpose
        })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toEqual(
        expect.arrayContaining(['title: Required', 'purpose_one_liner: Required'])
      );
    });

    it('should validate title length', async () => {
      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'test',
          title: 'Hi', // Too short
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement'
        })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
      // zod's default min() message, not a custom "Title must be between..." string
      expect(response.body.details).toContain('title: String must contain at least 4 character(s)');
    });

    it('should validate purpose length', async () => {
      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'test',
          title: 'Valid Title',
          purpose_one_liner: 'Short' // Too short
        })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('purpose_one_liner: String must contain at least 10 character(s)');
    });

    /*
     * `z.string().url()` is not a protocol check, and this field is rendered
     * into an `href` on the participant page.
     *
     * Before this guard, `POST /api/opportunities` with
     * `external_link_optional: 'javascript:alert(document.domain)'` on a
     * published question returned **201** - verified by request, not inferred -
     * and the page rendered it as `<a href="javascript:...">`. A
     * `researcher_admin` could therefore store script in the app's own origin.
     * ONE accident stopped it firing - Chrome refuses that navigation to
     * `target="_blank"` - and that was it. I first wrote that helmet's default
     * CSP was a second layer; it is not. helmet is on the BACKEND, and the
     * participant page comes from `frontend/nginx.conf`, which sends no
     * Content-Security-Policy at all. A markup attribute was the only thing
     * there.
     *
     * Both endpoints, deliberately. One twin pinned and not the other is this
     * repo's most-repeated failure, and here it would leave PATCH as the weaker
     * boundary - which is the one an attacker with an existing draft would use.
     */
    it.each([
      ['javascript:alert(document.domain)'],
      ['data:text/html,<script>alert(1)</script>'],
      ['vbscript:msgbox(1)'],
      ['ftp://example.com/file']
    ])('refuses %s on create', async (link) => {
      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'question',
          title: 'Valid Question Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          status: 'draft',
          external_link_optional: link
        })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toEqual([
        `external_link_optional: ${EXTERNAL_LINK_PROTOCOL_MESSAGE}`
      ]);
    });

    it.each([
      ['javascript:alert(document.domain)'],
      ['data:text/html,<script>alert(1)</script>']
    ])('refuses %s on update too', async (link) => {
      // No stored-row mocks needed: the schema refuses before the handler runs,
      // which is the point - it is a boundary, not a guard inside the flow.
      const response = await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ external_link_optional: link })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toEqual([
        `external_link_optional: ${EXTERNAL_LINK_PROTOCOL_MESSAGE}`
      ]);
    });

    it.each([
      ['https://example.com/survey'],
      ['http://example.com/survey']
    ])('still accepts %s', async (link) => {
      /*
       * The satisfied twin, and both schemes. Without it the four refusals
       * above would pass against a schema that rejected every link, and a fix
       * permitting only https would break every stored http link in the table.
       */
      mockQuery.mockResolvedValueOnce({ rows: [] }); // user upsert
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'q-1',
            type: 'question',
            title: 'Valid Question Title',
            purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
            status: 'draft',
            external_link_optional: link,
            owner_user_id: 'test-user-id',
            created_at: new Date(),
            updated_at: new Date()
          }
        ]
      }); // opportunity insert

      await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'question',
          title: 'Valid Question Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          status: 'draft',
          external_link_optional: link
        })
        .expect(201);
    });

    it('should require external link for published polls/surveys', async () => {
      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'poll',
          title: 'Valid Poll Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          status: 'published'
          // Missing external_link_optional
        })
        .expect(400);

      expect(response.body.error).toBe(
        'External link is required for published polls, surveys and one-question studies'
      );
    });

    /*
     * A live session cannot be created already-published (#118): slots are a
     * SEPARATE `POST /api/sessions` write, so a create supplies `hasBookableSlot:
     * false` and a bookable publish in one call is always refused. This is why
     * the wizard creates as draft, adds slots, then flips to published - and why
     * a direct API create+publish of a slotless bookable study is closed here.
     * The guard throws before any query runs.
     */
    it.each([['test'], ['interview']])(
      'refuses to create a published %s in one call (no slots yet, #118)',
      async (type) => {
        const response = await request(listening(app))
          .post('/api/opportunities')
          .send({
            type,
            title: 'Valid Live Session Title',
            purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
            status: 'published'
          })
          .expect(400);

        expect(response.body.error).toBe(
          'Add at least one upcoming time slot before publishing a live session or interview'
        );
      }
    );

    /**
     * The same rule, on the type that was missing from it.
     *
     * A handed-off `question` sends the participant to another site, but the
     * publish gate named only `unmoderated`, `poll` and `survey`. So this call
     * used to answer 201, and the study it created was one nobody could take
     * part in: the detail page renders a disabled "Link unavailable" button,
     * which is honest and far too late.
     *
     * Still the right assertion after #78 gave the type a native path, because
     * this request sets no `delivery_mode` - and absent means external, which
     * is what every `question` row stored before #78 is.
     *
     * At the ROUTE rather than only against `findPublishProblem`, because the
     * predicate being right proves nothing about whether this endpoint asks
     * it. Both were checked - the create path calls it unconditionally on
     * `data.type`, and PATCH's `changesPublishShape` fires on `status` and on
     * `external_link_optional`, neither of which is type-specific.
     */
    it('should require external link for a published question', async () => {
      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'question',
          title: 'Valid Question Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          status: 'published'
          // Missing external_link_optional
        })
        .expect(400);

      expect(response.body.error).toBe(
        'External link is required for published polls, surveys and one-question studies'
      );
    });

    it('still lets a question be saved as a draft with no link', async () => {
      // The refusal is about publishing, not about authoring. An author must
      // be able to write the title before they have the link.
      mockQuery.mockResolvedValueOnce({ rows: [] }); // user upsert
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'q-draft-1',
            type: 'question',
            title: 'Valid Question Title',
            purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
            status: 'draft',
            external_link_optional: null,
            owner_user_id: 'test-user-id',
            created_at: new Date(),
            updated_at: new Date()
          }
        ]
      }); // opportunity insert

      await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'question',
          title: 'Valid Question Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          status: 'draft'
        })
        .expect(201);
    });

    /**
     * Polls and surveys were external-link-only, forced by this guard rather
     * than by anything about the types themselves. `delivery_mode` turns that
     * fixed behaviour into a choice, so the external link is required only
     * where the participant is actually being sent somewhere else.
     */
    it('still requires an external link for a published poll delivered externally', async () => {
      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'poll',
          title: 'Valid Poll Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          delivery_mode: 'external',
          status: 'published'
        })
        .expect(400);

      expect(response.body.error).toBe(
        'External link is required for published polls, surveys and one-question studies'
      );
    });

    it('does not ask a native survey for an external link, but does ask for a study', async () => {
      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'survey',
          title: 'Valid Survey Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          delivery_mode: 'native',
          status: 'published'
        })
        .expect(400);

      expect(response.body.error).toBe(NATIVE_SURVEY_STUDY_REQUIRED);
    });

    /**
     * The picker gap found in review: create and update accept the full
     * widened contract, so a hand-crafted API call could link a RECORDED
     * opportunity to a survey-vocabulary study whose prompts render with no
     * widget and persist nothing. Filtering the picker in the UI does not close
     * it, because the UI is not the boundary.
     */
    it('refuses to link a survey study to a recorded opportunity', async () => {
      mockGetStudyById.mockResolvedValueOnce({
        study: {
          id: 'study_survey',
          title: 'A survey',
          intro_text: 'Intro',
          consent_text: 'Consent',
          status: 'launched' as const,
          kind: 'survey' as const,
          owner_user_id: 'test-user-id',
          copied_from_study_id: null,
          created_at: '2026-08-17T10:00:00.000Z',
          updated_at: '2026-08-17T10:00:00.000Z',
        },
        steps: []
      });

      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'unmoderated',
          title: 'Valid Unmoderated Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          firsthand_study_id: 'study_survey',
          status: 'published'
        })
        .expect(400);

      expect(response.body.error).toMatch(/needs a recorded task list/);
    });

    it('refuses to link a recorded task list to a native survey', async () => {
      mockGetStudyById.mockResolvedValueOnce({
        study: {
          id: 'study_recorded',
          title: 'A task list',
          intro_text: 'Intro',
          consent_text: 'Consent',
          status: 'launched' as const,
          kind: 'recorded' as const,
          owner_user_id: 'test-user-id',
          copied_from_study_id: null,
          created_at: '2026-08-17T10:00:00.000Z',
          updated_at: '2026-08-17T10:00:00.000Z',
        },
        steps: []
      });

      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'survey',
          title: 'Valid Survey Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          delivery_mode: 'native',
          firsthand_study_id: 'study_recorded',
          status: 'published'
        })
        .expect(400);

      expect(response.body.error).toMatch(/needs a set of survey questions/);
    });

    /**
     * The one-question cap on the LINKING path (#78).
     *
     * The picker cannot enforce this and neither can the authoring cap: both
     * request schemas take `firsthand_study_id`, so a set of three questions
     * authored as a survey is one hand-crafted call away from a `question`
     * opportunity - and the participant would meet three of them under a badge
     * reading "One question".
     *
     * The kind check one test up refuses the wrong VOCABULARY; this refuses the
     * wrong SIZE of the right one, which nothing else on this route can see.
     */
    it('refuses to link a multi-question study to a one-question opportunity', async () => {
      mockGetStudyById.mockResolvedValueOnce({
        study: {
          id: 'study_three',
          title: 'Three questions',
          intro_text: 'Intro',
          consent_text: 'Consent',
          status: 'launched' as const,
          kind: 'survey' as const,
          owner_user_id: 'test-user-id',
          copied_from_study_id: null,
          created_at: '2026-08-17T10:00:00.000Z',
          updated_at: '2026-08-17T10:00:00.000Z',
        },
        steps: [
          { step_id: 's1', order: 1, type: 'open_text', prompt: 'One?' },
          { step_id: 's2', order: 2, type: 'open_text', prompt: 'Two?' },
          { step_id: 's3', order: 3, type: 'end', prompt: 'Done' }
        ]
      } as never);

      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'question',
          title: 'Valid One Question Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          delivery_mode: 'native',
          firsthand_study_id: 'study_three',
          status: 'published'
        })
        .expect(400);

      expect(response.body.error).toBe(
        'A one-question opportunity asks exactly one question; use a poll or a survey to ask more'
      );
    });

    /**
     * The control, and the reason the `end` marker is filtered rather than
     * counted: this study has exactly one QUESTION and two step rows. Counting
     * rows would refuse it, and the cap would then reject every legal
     * one-question link while the test above still passed.
     */
    it('links a single-question study to a one-question opportunity, end marker and all', async () => {
      mockGetStudyById.mockResolvedValueOnce({
        study: {
          id: 'study_one',
          title: 'One question',
          intro_text: 'Intro',
          consent_text: 'Consent',
          status: 'launched' as const,
          kind: 'survey' as const,
          owner_user_id: 'test-user-id',
          copied_from_study_id: null,
          created_at: '2026-08-17T10:00:00.000Z',
          updated_at: '2026-08-17T10:00:00.000Z',
        },
        steps: [
          { step_id: 's1', order: 1, type: 'open_text', prompt: 'One?' },
          { step_id: 's2', order: 2, type: 'end', prompt: 'Done' }
        ]
      } as never);
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '23', type: 'question', created_at: new Date(), updated_at: new Date() }]
      });

      await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'question',
          title: 'Valid One Question Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          delivery_mode: 'native',
          firsthand_study_id: 'study_one',
          status: 'published'
        })
        .expect(201);
    });

    /**
     * The mode has to reach the ROW. The publish guard has just accepted a
     * native survey without an external link on the strength of this value, so
     * storing 'external' anyway produces exactly the state the guard exists to
     * refuse - an external survey with nothing to hand off to.
     */
    it('stores the delivery mode it was given', async () => {
      mockGetStudyById.mockResolvedValueOnce({
        study: {
          id: 'study_questions',
          title: 'Questions',
          intro_text: 'Intro',
          consent_text: 'Consent',
          status: 'launched' as const,
          kind: 'survey' as const,
          owner_user_id: 'test-user-id',
          copied_from_study_id: null,
          created_at: '2026-08-17T10:00:00.000Z',
          updated_at: '2026-08-17T10:00:00.000Z',
        },
        steps: []
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // user upsert
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '9', type: 'survey', created_at: new Date(), updated_at: new Date() }]
      });

      await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'survey',
          title: 'Valid Survey Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          delivery_mode: 'native',
          firsthand_study_id: 'study_questions',
          status: 'published'
        })
        .expect(201);

      const insert = mockQuery.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('INSERT INTO opportunities')
      );
      const columns = String(insert![0])
        .slice(String(insert![0]).indexOf('('), String(insert![0]).indexOf(') VALUES'))
        .split(',')
        .map((column: string) => column.replace(/[()\s]/g, ''));
      const index = columns.indexOf('delivery_mode');

      expect(index).toBeGreaterThan(-1);
      expect((insert![1] as unknown[])[index]).toBe('native');
    });

    /**
     * EVERY COLUMN OF THE CREATE INSERT, PINNED TO ITS VALUE BY NAME.
     *
     * The statement binds a fixed column list to a positional array, so the two
     * are coupled by ORDER ALONE and nothing above this test was checking that.
     * A security gate demonstrated the cost on this exact statement: swapping
     * `req.user!.id` with `external_link_optional` - so `owner_user_id` takes a
     * caller-supplied string - passed 297 tests, and so did swapping
     * `start_date` with `end_date`.
     *
     * That matters more than a normal ordering bug. `owner_user_id` drives
     * every ownership gate in this router through `isOpportunityOwner`, and the
     * date swap is the silent one: both columns are the same type, so Postgres
     * accepts it and the study simply opens and closes on the wrong days.
     *
     * Written as a TABLE keyed by column NAME, resolved through the statement's
     * own column list, so it survives a deliberate reordering and fails only on
     * a value reaching the wrong column. The delivery_mode test above uses the
     * same idiom for one slot; this is that idiom for all of them.
     */
    it('binds every column of the insert to the value that belongs in it', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: '11', type: 'interview',
          created_at: new Date(), updated_at: new Date(),
          start_date: new Date('2026-03-01T09:00:00.000Z'),
          end_date: new Date('2026-04-01T09:00:00.000Z')
        }]
      });

      await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'interview',
          title: 'A distinct interview title',
          purpose_one_liner: 'A purpose long enough to satisfy the minimum length rule',
          description_optional: 'A distinct description',
          product_optional: 'A distinct product',
          meeting_location_optional: 'A distinct meeting location',
          default_duration_minutes: 45,
          external_link_optional: 'https://example.com/a-distinct-link',
          participant_type_required: 'specific',
          participant_type_specific_details: 'A distinct participant detail',
          status: 'draft',
          delivery_mode: 'external',
          start_date: '2026-03-01T09:00:00.000Z',
          end_date: '2026-04-01T09:00:00.000Z',
          // Moderated consent (#79): interview is a moderated type, so these
          // are legal here and the census below must see them bound.
          consent_text: 'A distinct consent wording for the census'
        })
        .expect(201);

      const insert = mockQuery.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('INSERT INTO opportunities')
      );
      const sql = String(insert![0]);
      const columns = sql
        .slice(sql.indexOf('('), sql.indexOf(') VALUES'))
        .split(',')
        .map((column: string) => column.replace(/[()\s]/g, ''));
      const values = insert![1] as unknown[];
      const bound = (column: string) => {
        const index = columns.indexOf(column);
        // A missing column would make every lookup below return values[-1],
        // i.e. undefined, and a table of undefined-vs-undefined would pass.
        expect(index).toBeGreaterThan(-1);
        return values[index];
      };

      const expected: Record<string, unknown> = {
        type: 'interview',
        title: 'A distinct interview title',
        purpose_one_liner: 'A purpose long enough to satisfy the minimum length rule',
        description_optional: 'A distinct description',
        product_optional: 'A distinct product',
        meeting_location_optional: 'A distinct meeting location',
        default_duration_minutes: 45,
        status: 'draft',
        owner_user_id: 'test-user-id',
        external_link_optional: 'https://example.com/a-distinct-link',
        firsthand_study_id: null,
        participant_type_required: 'specific',
        participant_type_specific_details: 'A distinct participant detail',
        start_date: '2026-03-01T09:00:00.000Z',
        end_date: '2026-04-01T09:00:00.000Z',
        delivery_mode: 'external',
        // Resolution stores custom/null for wording that is no template's.
        consent_text: 'A distinct consent wording for the census',
        consent_template_id: 'custom',
        consent_template_version: null,
        // No screener in the request body, so the create binds null for it.
        screener: null,
        // No roles/skills wanted in the request body, so the create binds null.
        target_roles: null
      };

      for (const [column, value] of Object.entries(expected)) {
        expect({ [column]: bound(column) }).toEqual({ [column]: value });
      }

      // The table must cover the statement, or a column added later is bound by
      // nothing and this test still passes.
      expect(columns.slice().sort()).toEqual(Object.keys(expected).sort());
      expect(values).toHaveLength(columns.length);
    });

    it('binds a populated screener to the insert as JSON that round-trips to the object', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: '12', type: 'interview',
          created_at: new Date(), updated_at: new Date(),
          start_date: null, end_date: null
        }]
      });
      const screener = {
        questions: [
          {
            id: 'role',
            prompt: 'Which best describes your role?',
            options: [
              { id: 'eng', label: 'Engineer', disqualifies: false },
              { id: 'sales', label: 'Sales', disqualifies: true },
            ],
          },
        ],
      };

      await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'interview',
          title: 'A study with a screener',
          purpose_one_liner: 'A purpose long enough to satisfy the minimum length rule',
          screener,
        })
        .expect(201);

      const insert = mockQuery.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('INSERT INTO opportunities')
      );
      const sql = String(insert![0]);
      const columns = sql
        .slice(sql.indexOf('('), sql.indexOf(') VALUES'))
        .split(',')
        .map((column: string) => column.replace(/[()\s]/g, ''));
      const values = insert![1] as unknown[];
      const bound = values[columns.indexOf('screener')];

      // The $20::jsonb param is the validated screener serialised to a JSON
      // string, not the raw object, and it round-trips.
      expect(typeof bound).toBe('string');
      expect(JSON.parse(bound as string)).toEqual(screener);
    });

    it('stores external when the request says nothing, rather than leaving it to chance', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '10', type: 'poll', created_at: new Date(), updated_at: new Date() }]
      });

      await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'poll',
          title: 'Valid Poll Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          external_link_optional: 'https://example.com/poll',
          status: 'published'
        })
        .expect(201);

      const insert = mockQuery.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('INSERT INTO opportunities')
      );
      expect(insert![1]).toContain('external');
    });

    /**
     * Linking an id that resolves to nothing used to be a silent skip of the
     * whole vocabulary check - and POST /api/firsthand/studies takes a
     * client-supplied id, so the missing study is a slot to be filled
     * afterwards rather than a transient state.
     */
    it('refuses a study id that resolves to nothing rather than skipping the check', async () => {
      mockGetStudyById.mockResolvedValueOnce(null as never);

      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'unmoderated',
          title: 'Valid Unmoderated Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          firsthand_study_id: 'study_not_created_yet',
          status: 'published'
        })
        .expect(400);

      expect(response.body.error).toBe('That task list could not be found');
    });

    /**
     * Authoring questions on the opportunity form itself, the survey
     * counterpart of the inline task list. The handler creates the study and
     * links it in one request, so a researcher never has to create one
     * separately, launch it, and come back to pick it from a dropdown.
     */
    describe('inline survey authoring', () => {
      const questions = {
        consent_text: 'Your answers are stored for research analysis.',
        steps: [
          { type: 'nps', prompt: 'Would you recommend it?' },
          { type: 'open_text', prompt: 'What would you change?' }
        ]
      };

      const body = (overrides: Record<string, unknown> = {}) => ({
        type: 'survey',
        title: 'Developer experience pulse',
        purpose_one_liner: 'Ten short questions about the tools you use every day',
        delivery_mode: 'native',
        status: 'published',
        inline_survey: questions,
        ...overrides
      });

      it('creates a survey-kind study and links it, in one request', async () => {
        mockCreateStudy.mockResolvedValueOnce({
          study: { id: 'study_new' },
          steps: []
        } as never);
        mockQuery.mockResolvedValueOnce({ rows: [] }); // user upsert
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '11', type: 'survey', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app)).post('/api/opportunities').send(body()).expect(201);

        expect(mockCreateStudy).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'survey', status: 'launched' })
        );
      });

      /**
       * The CREATE route's half of the precondition contract, and it had none.
       *
       * A mutation setting this path's value to null left both suites green,
       * because nothing anywhere asserted the create response carries the
       * field at all. The consequence is the PATCH failure one step earlier: a
       * draft the autosave creates would hold no precondition, so every save
       * after it writes under F1's fail-open - logged, and otherwise silent.
       */
      it('returns the minted study revision, so the next save has a precondition', async () => {
        mockCreateStudy.mockResolvedValueOnce({
          study: { id: 'study_new', updated_at: '2026-08-21T19:45:00.000Z' },
          steps: []
        } as never);
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '12', type: 'survey', created_at: new Date(), updated_at: new Date() }]
        });

        const response = await request(listening(app))
          .post('/api/opportunities')
          .send(body({ status: 'draft' }))
          .expect(201);

        expect(response.body.linked_study_updated_at).toBe('2026-08-21T19:45:00.000Z');
      });

      /**
       * ABSENT, not null, when the request wrote no study - the same rule the
       * PATCH response follows, and for the same reason: a client reading a
       * present-but-null field as "there is no study" would clear a
       * precondition it should have kept.
       */
      it('says nothing about a study when the request created none', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '14', type: 'question', created_at: new Date(), updated_at: new Date() }]
        });

        const response = await request(listening(app))
          .post('/api/opportunities')
          .send({
            type: 'question',
            title: 'A quick question',
            purpose_one_liner: 'Nothing here carries a study at all',
            status: 'draft'
          })
          .expect(201);

        expect(Object.keys(response.body)).not.toContain('linked_study_updated_at');
      });

      it('namespaces the step ids by study, so a second survey cannot collide', async () => {
        mockCreateStudy.mockResolvedValueOnce({
          study: { id: 'study_new' },
          steps: []
        } as never);
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '13', type: 'survey', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app)).post('/api/opportunities').send(body()).expect(201);

        const call = mockCreateStudy.mock.calls[0][0] as { id: string; steps: { step_id: string }[] };
        call.steps.forEach((step) => expect(step.step_id.startsWith(call.id)).toBe(true));
      });

      it('publishes a native survey on authored questions alone, with no link', async () => {
        mockCreateStudy.mockResolvedValueOnce({
          study: { id: 'study_new' },
          steps: []
        } as never);
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '14', type: 'survey', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app))
          .post('/api/opportunities')
          .send(body({ external_link_optional: undefined }))
          .expect(201);
      });

      it('refuses questions on a recorded study', async () => {
        const response = await request(listening(app))
          .post('/api/opportunities')
          .send(body({ type: 'unmoderated', delivery_mode: undefined }))
          .expect(400);

        // The literal, not the exported constant. Deriving the expectation
        // from the constant would make a reworded refusal invisible - and this
        // sentence widened once already, when #78 gave `question` a native
        // path, which is the change this pin caught.
        expect(response.body.error).toBe(
          'Only polls, surveys and one-question studies can carry questions'
        );
      });

      /**
       * #78: `question` runs natively too, and asks exactly one thing.
       *
       * The control for the cap is two tests up - "creates a survey-kind study
       * and links it" sends the same two-question payload as a `survey` and
       * expects 201. Without that pairing a cap test passes just as well when
       * every multi-question save is broken.
       */
      describe('a one-question opportunity', () => {
        const oneQuestion = {
          consent_text: 'Your answer is stored for research analysis.',
          steps: [{ type: 'open_text', prompt: 'What nearly stopped you today?' }]
        };

        it('creates a survey-kind study for a native question, as a poll or survey would', async () => {
          mockCreateStudy.mockResolvedValueOnce({
            study: { id: 'study_q' },
            steps: []
          } as never);
          mockQuery.mockResolvedValueOnce({ rows: [] });
          mockQuery.mockResolvedValueOnce({
            rows: [{ id: '21', type: 'question', created_at: new Date(), updated_at: new Date() }]
          });

          await request(listening(app))
            .post('/api/opportunities')
            .send(body({ type: 'question', inline_survey: oneQuestion }))
            .expect(201);

          // `survey` is the STUDY vocabulary, not the opportunity type: one
          // question is a survey of one, and SurveyRunner is what draws it.
          expect(mockCreateStudy).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'survey' })
          );
        });

        it('publishes on its one question alone, with no link', async () => {
          mockCreateStudy.mockResolvedValueOnce({
            study: { id: 'study_q2' },
            steps: []
          } as never);
          mockQuery.mockResolvedValueOnce({ rows: [] });
          mockQuery.mockResolvedValueOnce({
            rows: [{ id: '22', type: 'question', created_at: new Date(), updated_at: new Date() }]
          });

          await request(listening(app))
            .post('/api/opportunities')
            .send(
              body({
                type: 'question',
                inline_survey: oneQuestion,
                external_link_optional: undefined
              })
            )
            .expect(201);
        });

        it('refuses a second question', async () => {
          const response = await request(listening(app))
            .post('/api/opportunities')
            .send(body({ type: 'question' }))
            .expect(400);

          // The literal. A cap whose test reads the constant cannot see the
          // constant move.
          expect(response.body.error).toBe(
            'A one-question opportunity asks exactly one question; use a poll or a survey to ask more'
          );
        });

        it('still refuses to publish natively with no question at all', async () => {
          const response = await request(listening(app))
            .post('/api/opportunities')
            .send(
              body({
                type: 'question',
                inline_survey: undefined,
                external_link_optional: undefined
              })
            )
            .expect(400);

          expect(response.body.error).toBe(NATIVE_SURVEY_STUDY_REQUIRED);
        });

        /**
         * The half that matters most, because it is the one a picker cannot
         * enforce: `delivery_mode` absent means external, and an external
         * question still hands off, so it still needs somewhere to send its
         * participant. This is the #78 rule NOT eating the original one.
         */
        it('still demands a link when it hands off', async () => {
          const response = await request(listening(app))
            .post('/api/opportunities')
            .send({
              type: 'question',
              title: 'A quick question',
              purpose_one_liner: 'Answered somewhere else entirely',
              status: 'published'
            })
            .expect(400);

          expect(response.body.error).toBe(
            'External link is required for published polls, surveys and one-question studies'
          );
        });
      });

      /**
       * A survey carrying a task list is refused by the type rule, which says
       * something more precise than a generic "not both" could: the two
       * vocabularies are not interchangeable, so there is no type that admits
       * both and nothing to disambiguate.
       */
      it('refuses a task list on a survey', async () => {
        const response = await request(listening(app))
          .post('/api/opportunities')
          .send(body({
            inline_study: {
              consent_text: 'Consent',
              steps: [{ type: 'instruction', prompt: 'Do a thing' }]
            }
          }))
          .expect(400);

        expect(response.body.error).toBe(
          'Only unmoderated studies can carry a task list'
        );
      });

      it('refuses questions alongside a linked study, rather than picking one', async () => {
        const response = await request(listening(app))
          .post('/api/opportunities')
          .send(body({ firsthand_study_id: 'study_existing' }))
          .expect(400);

        expect(response.body.error).toBe(
          'Send either firsthand_study_id or inline_survey, not both'
        );
      });

      /**
       * Questions on an externally delivered survey would be stored and never
       * reached by anything, because the participant is sent to the external
       * link instead.
       */
      it('refuses questions when the survey hands off externally', async () => {
        const response = await request(listening(app))
          .post('/api/opportunities')
          .send(body({
            delivery_mode: 'external',
            external_link_optional: 'https://example.com/form'
          }))
          .expect(400);

        expect(response.body.error).toMatch(/runs in Cortex/);
      });

      describe('on update', () => {
        const existing = (studyId: string | null) => ({
          type: 'survey',
          title: 'A survey',
          purpose_one_liner: 'Purpose',
          status: 'draft',
          external_link_optional: null,
          firsthand_study_id: studyId,
          participant_type_required: 'any',
          delivery_mode: 'native'
        });

        /**
         * `expectUpdate` decides whether the UPDATE result is queued at all.
         * `jest.clearAllMocks()` clears calls but NOT queued once-values, so a
         * refusal test that queues a row it never reaches leaves it for the
         * next test to consume - which poisons tests that have nothing to do
         * with this one, and reads as an unrelated failure.
         */
        const patch = (
          body: Record<string, unknown>,
          studyId: string | null,
          expectUpdate = false
        ) => {
          mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
          mockQuery.mockResolvedValueOnce({ rows: [existing(studyId)] });
          if (studyId) {
            // "Is any OTHER opportunity linked to this study?" - only asked
            // when there is a link to rewrite in place.
            mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
          }
          if (expectUpdate) {
            mockQuery.mockResolvedValueOnce({
              rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
              rowCount: 1
            });
          }
          return request(listening(app)).patch('/api/opportunities/1').send(body);
        };

        /**
         * The revision the caller needs for its NEXT save, carried on the
         * response rather than left to a second request.
         *
         * This is what makes a repeated save possible at all. A successful
         * save moves the study's `updated_at`, so a client that keeps sending
         * the revision it loaded is refused as stale by its own previous
         * write - forever, and with a banner blaming a colleague who does not
         * exist. The authoring form's autosave cannot re-read the study to
         * find out, because rebuilding the form from the server would discard
         * whatever the author typed while the request was in flight.
         *
         * Asserted on the response BODY, not on what the repository returned.
         * The value is only useful if it reaches the wire.
         */
        it('returns the study revision after rewriting one in place', async () => {
          mockGetStudyById.mockResolvedValueOnce({
            study: {
              id: 'study_existing',
              title: 'A survey',
              intro_text: 'Intro',
              consent_text: 'Consent',
              kind: 'survey',
              owner_user_id: 'test-user-id',
              created_at: '2026-08-16T10:00:00.000Z',
              updated_at: '2026-08-16T10:00:00.000Z'
            },
            steps: []
          } as never);
          mockUpdateStudy.mockResolvedValueOnce({
            ok: true as const,
            claimed: false,
            study: {
              id: 'study_existing',
              title: 'A survey',
              intro_text: 'Intro',
              consent_text: 'Consent',
              kind: 'survey' as const,
              status: 'launched',
              owner_user_id: 'test-user-id',
              created_at: '2026-08-16T10:00:00.000Z',
              updated_at: '2026-08-21T18:30:00.000Z'
            },
            steps: []
          } as never);

          const response = await patch(
            { inline_survey: questions },
            'study_existing',
            true
          ).expect(200);

          expect(response.body.linked_study_updated_at).toBe(
            '2026-08-21T18:30:00.000Z'
          );
        });

        /**
         * ABSENT, not null, when the request wrote no study.
         *
         * The distinction is the contract. A client reading a present-but-null
         * field as "there is no study" would clear the precondition it should
         * have kept, and the next save would go through the fail-open with
         * nothing anywhere recording that the protection had been dropped.
         * Asserted after serialisation, because `{ key: undefined }` still has
         * the key as far as an object comparison is concerned while the API
         * never sends it.
         */
        it('says nothing about a study on a save that wrote none', async () => {
          const response = await patch({ title: 'Retitled only' }, null, true).expect(200);

          expect(Object.keys(response.body)).not.toContain('linked_study_updated_at');
        });

        /**
         * The CREATE route's twin of the absence rule.
         *
         * The two response builders are independent conditional spreads and
         * can drift; a mutation setting the create path's value to null left
         * both suites green, because nothing anywhere asserted the create
         * response carries the field at all. The consequence is the PATCH case
         * one step earlier: an autosave-created draft would hold no
         * precondition, and every later save would write under F1's fail-open
         * - logged, and otherwise silent.
         */
        it('returns the revision of a study it minted', async () => {
          mockCreateStudy.mockResolvedValueOnce({
            study: { id: 'study_new', updated_at: '2026-08-21T18:45:00.000Z' },
            steps: []
          } as never);

          const response = await patch({ inline_survey: questions }, null, true).expect(200);

          expect(response.body.linked_study_updated_at).toBe(
            '2026-08-21T18:45:00.000Z'
          );
        });

        it('writes the questions on a draft that has none yet', async () => {
          mockCreateStudy.mockResolvedValueOnce({
            study: { id: 'study_new' },
            steps: []
          } as never);

          await patch({ inline_survey: questions }, null, true).expect(200);

          expect(mockCreateStudy).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'survey' })
          );
        });

        /**
         * The survey twin of the PATCH fallback-mint assertion made for
         * inline_study: provenance must reach createStudy from this second
         * minting site too, on both authoring paths.
         */
        it('passes copied_from_study_id through on the PATCH fallback mint', async () => {
          mockCreateStudy.mockResolvedValueOnce({
            study: { id: 'study_new_copy' },
            steps: []
          } as never);

          await patch(
            { inline_survey: { ...questions, copied_from_study_id: 'study_source' } },
            null,
            true
          ).expect(200);

          expect(mockCreateStudy).toHaveBeenCalledWith(
            expect.objectContaining({ copied_from_study_id: 'study_source' })
          );
        });

        /**
         * The mint-on-miss path decides the classification of a BRAND-NEW
         * study, and it is the path a dangling `firsthand_study_id` takes -
         * so it is reached by exactly the opportunities nobody is watching.
         */
        it('carries the consent template claim onto the PATCH fallback mint', async () => {
          mockCreateStudy.mockResolvedValueOnce({
            study: { id: 'study_new_claim' },
            steps: []
          } as never);

          await patch(
            {
              inline_survey: {
                ...questions,
                consent_template_id: 'survey-default',
                consent_template_version: 1
              }
            },
            null,
            true
          ).expect(200);

          const created = mockCreateStudy.mock.calls[0][0];
          expect(created.consent_template_id).toBe('survey-default');
          expect(created.consent_template_version).toBe(1);
        });

        it('sends null, not undefined, for copied_from_study_id on the PATCH fallback mint when none is given', async () => {
          mockCreateStudy.mockResolvedValueOnce({
            study: { id: 'study_new_blank' },
            steps: []
          } as never);

          await patch({ inline_survey: questions }, null, true).expect(200);

          const created = mockCreateStudy.mock.calls[0][0];
          expect(created.copied_from_study_id).toBeNull();
          expect('copied_from_study_id' in created).toBe(true);
        });

        /**
         * Authoring over questions that already exist was refused outright,
         * because `inline_survey` only ever created - so honouring it would
         * have minted a second study and repointed the row at it, leaving the
         * first launched, orphaned and holding every answer collected so far.
         * It now updates the linked study in place instead, which is the only
         * way an author can correct their own questions from the form that
         * wrote them.
         */
        it('rewrites the linked questions in place rather than minting a second study', async () => {
          // The linked study has to be a survey, or the vocabulary guard
          // refuses it - the factory default is a recorded task list.
          mockGetStudyById.mockResolvedValueOnce({
            study: {
              id: 'study_existing',
              title: 'A survey',
              intro_text: 'Intro',
              consent_text: 'Consent',
              kind: 'survey',
              estimated_duration_minutes: undefined,
              status: 'launched',
              owner_user_id: 'test-user-id',
              copied_from_study_id: null,
              created_at: '2026-08-16T10:00:00.000Z',
              updated_at: '2026-08-16T10:00:00.000Z',
            },
            steps: [],
          } as never);

          await patch({ inline_survey: questions }, 'study_existing', true).expect(200);

          expect(mockCreateStudy).not.toHaveBeenCalled();
          expect(mockUpdateStudy).toHaveBeenCalledTimes(1);
          expect(mockUpdateStudy.mock.calls[0][0]).toBe('study_existing');
          // The steps carry the EXISTING study's id, not a fresh one - which
          // is what keeps `${studyId}_step_N` pointing at the same study the
          // answers were collected against.
          const written = mockUpdateStudy.mock.calls[0][1] as {
            steps: { step_id: string }[];
          };
          expect(written.steps[0].step_id.startsWith('study_existing_')).toBe(true);
        });

        /**
         * The config half of the re-meaning refusal, on the survey branch -
         * which is the only vocabulary that HAS a config to change.
         *
         * The recorded branch's tests cover a changed `type`; a comparison that
         * looked at `type` alone would pass every one of them while letting a
         * researcher lower a rating scale from 10 to 5 on a live question, which
         * silently drops every answer above 5 out of `answered` and out of the
         * mean. The two vocabularies are separate code paths in this route, and
         * the untested half is the half that has bitten before.
         */
        /**
         * The key-less refusal, driven through the SURVEY branch.
         *
         * An independent mutation pass found that hardcoding
         * `identityIsAuthored` to `true` at the survey call site ALONE left the
         * whole suite green: every other test of this guard sends
         * `inline_study`. The two inline branches are separate code in this
         * route, not a shared helper, and in this repository the untested half
         * of a two-vocabulary pair is the half that has bitten before.
         */
        describe('a key-less survey payload', () => {
          const unkeyedSurvey = (prompts: string[]) => ({
            consent_text:
              'Your answers are stored for research analysis and are visible to the research team. Nothing is recorded.',
            steps: prompts.map((prompt) => ({ type: 'open_text' as const, prompt }))
          });

          const linkedUnkeyedSurvey = () => {
            mockGetStudyById.mockResolvedValueOnce({
              study: {
                id: 'study_existing',
                title: 'A survey',
                intro_text: 'Intro',
                consent_text: 'Consent',
                kind: 'survey',
                estimated_duration_minutes: undefined,
                status: 'launched',
                owner_user_id: 'test-user-id',
                copied_from_study_id: null,
                created_at: '2026-08-16T10:00:00.000Z',
                updated_at: '2026-08-16T10:00:00.000Z',
              },
              steps: toSurveySteps(
                unkeyedSurvey(['What did you expect?', 'What surprised you?']).steps as never,
                'study_existing'
              ),
            } as never);
          };

          afterEach(() => {
            mockStudyHasResponses.mockResolvedValue(false);
          });

          it('is refused when it reorders a survey that has answers', async () => {
            mockStudyHasResponses.mockResolvedValue(true);
            linkedUnkeyedSurvey();

            const response = await patch(
              {
                inline_survey: unkeyedSurvey([
                  'What surprised you?',
                  'What did you expect?'
                ])
              },
              'study_existing'
            ).expect(400);

            expect(response.body.error).toMatch(/already collected answers/);
            expect(mockUpdateStudy).not.toHaveBeenCalled();
          });

          it('is allowed when the survey has no answers', async () => {
            // The pair, so the assertion above cannot be satisfied by a rule
            // that refuses every key-less survey save.
            mockStudyHasResponses.mockResolvedValue(false);
            linkedUnkeyedSurvey();

            await patch(
              {
                inline_survey: unkeyedSurvey([
                  'What surprised you?',
                  'What did you expect?'
                ])
              },
              'study_existing',
              true
            ).expect(200);

            expect(mockUpdateStudy).toHaveBeenCalledTimes(1);
          });

          it('keeps the stored ids positionally when the sequence is unchanged', async () => {
            // The survey twin of the task-list assertion above. A key-less
            // payload cannot say which question is which, so the route holds on
            // to the identity the stored steps already have rather than taking
            // the payload's positional ids.
            mockGetStudyById.mockResolvedValueOnce({
              study: {
                id: 'study_existing',
                title: 'A survey',
                intro_text: 'Intro',
                consent_text: 'Consent',
                kind: 'survey',
                estimated_duration_minutes: undefined,
                status: 'launched',
                owner_user_id: 'test-user-id',
                copied_from_study_id: null,
                created_at: '2026-08-16T10:00:00.000Z',
                updated_at: '2026-08-16T10:00:00.000Z',
              },
              // Zero-padded, the way StudyEditor numbers them, so the unpadded
              // positional ids the payload derives are visibly different.
              steps: [
                {
                  step_id: 'study_existing_step_001',
                  order: 1,
                  type: 'open_text',
                  prompt: 'What did you expect?'
                },
                {
                  step_id: 'study_existing_step_end',
                  order: 2,
                  type: 'end',
                  prompt: 'Thanks - that is the end of the study.'
                }
              ],
            } as never);

            await patch(
              { inline_survey: unkeyedSurvey(['What did you expect?']) },
              'study_existing',
              true
            ).expect(200);

            const written = mockUpdateStudy.mock.calls[0][1] as {
              steps: { step_id: string }[];
            };
            expect(written.steps.map((step) => step.step_id)).toEqual([
              'study_existing_step_001',
              'study_existing_step_end',
            ]);
          });
        });

        describe('changing a live question\'s scale', () => {
          const ratingSurvey = (scaleMax: number) => ({
            consent_text:
              'Your answers are stored for research analysis and are visible to the research team. Nothing is recorded.',
            steps: [
              {
                step_key: 'alpha',
                type: 'rating' as const,
                prompt: 'How easy was that?',
                config: { scale_max: scaleMax }
              }
            ]
          });

          const linkedRatingSurvey = () => {
            mockGetStudyById.mockResolvedValueOnce({
              study: {
                id: 'study_existing',
                title: 'A survey',
                intro_text: 'Intro',
                consent_text: 'Consent',
                kind: 'survey',
                estimated_duration_minutes: undefined,
                status: 'launched',
                owner_user_id: 'test-user-id',
                copied_from_study_id: null,
                created_at: '2026-08-16T10:00:00.000Z',
                updated_at: '2026-08-16T10:00:00.000Z',
              },
              steps: toSurveySteps(ratingSurvey(10).steps as never, 'study_existing'),
            } as never);
          };

          afterEach(() => {
            mockStudyHasResponses.mockResolvedValue(false);
          });

          it('refuses to shrink the scale once people have answered', async () => {
            mockStudyHasResponses.mockResolvedValue(true);
            linkedRatingSurvey();

            const response = await patch(
              { inline_survey: ratingSurvey(5) },
              'study_existing'
            ).expect(400);

            expect(response.body.error).toMatch(/type and scale cannot be changed/);
            expect(mockUpdateStudy).not.toHaveBeenCalled();
          });

          it('allows it while nobody has answered', async () => {
            mockStudyHasResponses.mockResolvedValue(false);
            linkedRatingSurvey();

            await patch({ inline_survey: ratingSurvey(5) }, 'study_existing', true).expect(200);

            expect(mockUpdateStudy).toHaveBeenCalledTimes(1);
          });

          it('does not refuse a save that leaves the scale alone', async () => {
            // Otherwise every ordinary save on a live survey is refused, which
            // is the failure mode the pre-F2 guard actually had.
            mockStudyHasResponses.mockResolvedValue(true);
            linkedRatingSurvey();

            await patch({ inline_survey: ratingSurvey(10) }, 'study_existing', true).expect(200);

            expect(mockUpdateStudy).toHaveBeenCalledTimes(1);
          });
        });

        /**
         * F1's survey twin, and it is not ceremony.
         *
         * The two inline branches are separate code, not a shared helper. Every
         * other F1 test in this file drives `inline_study`, so an omitted
         * precondition on the survey call - or a `stale` check placed after
         * `if (!updatedStudyInPlace)` - would have left the suite green while
         * the survey branch minted a replacement study and abandoned the
         * colleague's save. Given this repo's two-vocabularies history, the
         * untested half is the half that has bitten before.
         */
        describe('optimistic concurrency on the survey branch', () => {
          const linkedSurvey = () => {
            mockGetStudyById.mockResolvedValueOnce({
              study: {
                id: 'study_existing',
                title: 'A survey',
                intro_text: 'Intro',
                consent_text: 'Consent',
                kind: 'survey',
                estimated_duration_minutes: undefined,
                status: 'launched',
                owner_user_id: 'test-user-id',
                copied_from_study_id: null,
                created_at: '2026-08-16T10:00:00.000Z',
                updated_at: '2026-08-16T10:00:00.000Z',
              },
              steps: [],
            } as never);
          };

          it('forwards the precondition to the survey in-place update', async () => {
            linkedSurvey();

            await patch(
              {
                inline_survey: questions,
                expected_study_updated_at: '2026-08-21T09:15:30.123Z'
              },
              'study_existing',
              true
            ).expect(200);

            expect(mockUpdateStudy.mock.calls[0][3]).toBe('2026-08-21T09:15:30.123Z');
          });

          it('answers 409 and mints nothing when the questions moved under the caller', async () => {
            linkedSurvey();
            mockUpdateStudy.mockResolvedValueOnce({
              ok: false,
              reason: 'stale',
              current_updated_at: '2026-08-21T09:15:30.123Z'
            } as never);

            const res = await patch(
              {
                inline_survey: questions,
                expected_study_updated_at: '2026-08-21T09:15:29.123Z'
              },
              'study_existing',
              false
            ).expect(409);

            expect(res.body.error).toBe('stale_study');
            expect(res.body.message).toMatch(/these questions/i);
            expect(res.body.current_updated_at).toBe('2026-08-21T09:15:30.123Z');

            // The expensive half. `missing` deliberately falls through to the
            // mint; a conflict falling through the same branch would repoint
            // the opportunity at a fresh study and abandon the one the
            // colleague had just saved.
            expect(mockCreateStudy).not.toHaveBeenCalled();
            expect(
              (mockQuery.mock.calls as unknown as [string, unknown[]][]).filter(
                ([sql]) => typeof sql === 'string' && sql.includes('UPDATE opportunities')
              )
            ).toHaveLength(0);
          });
        });

        /** The survey twin of the recorded in-place claim assertion. */
        it('carries the consent template claim into the in-place update', async () => {
          mockGetStudyById.mockResolvedValueOnce({
            study: {
              id: 'study_existing',
              title: 'A survey',
              intro_text: 'Intro',
              consent_text: 'Consent',
              kind: 'survey',
              estimated_duration_minutes: undefined,
              status: 'launched',
              owner_user_id: 'test-user-id',
              copied_from_study_id: null,
              created_at: '2026-08-16T10:00:00.000Z',
              updated_at: '2026-08-16T10:00:00.000Z',
            },
            steps: [],
          } as never);

          await patch(
            {
              inline_survey: {
                ...questions,
                consent_template_id: 'survey-default',
                consent_template_version: 1
              }
            },
            'study_existing',
            true
          ).expect(200);

          const written = mockUpdateStudy.mock.calls[0][1] as {
            consent_template_id?: string | null;
            consent_template_version?: number | null;
          };
          expect(written.consent_template_id).toBe('survey-default');
          expect(written.consent_template_version).toBe(1);
        });

        it('refuses to rewrite questions belonging to another researcher', async () => {
          mockGetStudyById.mockResolvedValueOnce({
            study: {
              id: 'study_existing',
              title: 'A survey',
              intro_text: 'Intro',
              consent_text: 'Consent',
              kind: 'survey',
              estimated_duration_minutes: undefined,
              status: 'launched',
              owner_user_id: 'someone-else',
              copied_from_study_id: null,
              created_at: '2026-08-16T10:00:00.000Z',
              updated_at: '2026-08-16T10:00:00.000Z',
            },
            steps: [],
          } as never);
          // No longer queues a forbidden updateStudy result: the ownership
          // check that used to live only inside updateStudy's own FOR UPDATE
          // transaction now also runs earlier, in updateLinkedStudyContent
          // itself (the second finding from the FIX 1 review - see its own
          // comment for the disclosure that closes). That means updateStudy is
          // never reached on this path any more, so a queued mockUpdateStudy
          // return here would go uncollected and poison whichever later test
          // next calls updateStudy - exactly the trap `patch`'s own docblock
          // warns about for mockQuery. Asserted directly below instead of
          // relied upon implicitly.
          const response = await patch(
            { inline_survey: questions },
            'study_existing'
          ).expect(403);

          expect(response.body.error).toMatch(/belong to another researcher/);
          expect(mockUpdateStudy).not.toHaveBeenCalled();
          // The dangerous failure is not the refusal itself but a fallback:
          // minting a replacement here would repoint the opportunity away from
          // a colleague's study without saying so.
          expect(mockCreateStudy).not.toHaveBeenCalled();
        });

        it('refuses questions alongside an explicit id, rather than picking one', async () => {
          const response = await patch(
            { firsthand_study_id: 'study_chosen', inline_survey: questions },
            null
          ).expect(400);

          expect(response.body.error).toBe(
            'Send either firsthand_study_id or inline_survey, not both'
          );
          expect(mockCreateStudy).not.toHaveBeenCalled();
        });

        /**
         * FIX 5, survey twin. See the recorded-study version for the trace:
         * `changesLinkage` reads true whenever `data.type` is present, which
         * the form sends on every save, so a dangling-link repair used to be
         * caught by the pre-check meant for a NEW `firsthand_study_id` before
         * `updateLinkedStudyContent` below could answer 'missing' and mint the
         * replacement.
         */
        it('repairs a dangling link even when the request resends its own type', async () => {
          mockGetStudyById.mockResolvedValueOnce(null as never);
          mockCreateStudy.mockResolvedValueOnce({
            study: { id: 'study_replacement' },
            steps: []
          } as never);

          await patch(
            { type: 'survey', inline_survey: questions },
            'study_existing',
            true
          ).expect(200);

          expect(mockUpdateStudy).not.toHaveBeenCalled();
          expect(mockCreateStudy).toHaveBeenCalledTimes(1);
        });
      });

      it('refuses a rating question with no scale, at the API not just the form', async () => {
        await request(listening(app))
          .post('/api/opportunities')
          .send(body({
            inline_survey: {
              consent_text: 'Consent',
              steps: [{ type: 'rating', prompt: 'Rate it' }]
            }
          }))
          .expect(400);

        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      /**
       * The twin of the inline_study assertion above: a property proved on
       * only one of the two authoring paths is this project's most recurring
       * defect.
       */
      it('passes copied_from_study_id through to createStudy', async () => {
        mockCreateStudy.mockResolvedValueOnce({ study: { id: 'study_copy' }, steps: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '17', type: 'survey', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app))
          .post('/api/opportunities')
          .send(body({ inline_survey: { ...questions, copied_from_study_id: 'study_source' } }))
          .expect(201);

        expect(mockCreateStudy).toHaveBeenCalledWith(
          expect.objectContaining({ copied_from_study_id: 'study_source' })
        );
      });

      it('sends null, not undefined, for copied_from_study_id when none is given', async () => {
        mockCreateStudy.mockResolvedValueOnce({ study: { id: 'study_blank' }, steps: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '18', type: 'survey', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app)).post('/api/opportunities').send(body()).expect(201);

        const created = mockCreateStudy.mock.calls[0][0];
        expect(created.copied_from_study_id).toBeNull();
        expect('copied_from_study_id' in created).toBe(true);
      });

      /**
       * C1: the consent classification the form loaded travels with the wording
       * so a study written against version 1 of a template stays attributed to
       * version 1 once a version 2 ships. The route only carries it - the
       * repository decides whether to believe it - but a route that drops it
       * makes every save look like a fresh classification against the newest
       * template, which is the silent mass-reclassification the version number
       * exists to prevent.
       *
       * `inlineSurveySchema` is `.strict()`, so this also proves the field is
       * declared there: an undeclared key is a 400, not a dropped field.
       */
      it('passes the consent template claim through to createStudy', async () => {
        mockCreateStudy.mockResolvedValueOnce({ study: { id: 'study_c' }, steps: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '19', type: 'survey', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app))
          .post('/api/opportunities')
          .send(
            body({
              inline_survey: {
                ...questions,
                consent_template_id: 'survey-default',
                consent_template_version: 1
              }
            })
          )
          .expect(201);

        const created = mockCreateStudy.mock.calls[0][0];
        // Both halves, asserted separately. An id without a version names
        // wording nothing can look up, and a version without an id names
        // nothing at all - so a route that forwards one and drops the other is
        // as broken as one that forwards neither.
        expect(created.consent_template_id).toBe('survey-default');
        expect(created.consent_template_version).toBe(1);
      });

      it('sends null for the consent claim when the client makes none', async () => {
        mockCreateStudy.mockResolvedValueOnce({ study: { id: 'study_d' }, steps: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '20', type: 'survey', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app)).post('/api/opportunities').send(body()).expect(201);

        const created = mockCreateStudy.mock.calls[0][0];
        expect(created.consent_template_id).toBeNull();
        expect(created.consent_template_version).toBeNull();
      });
    });

    it('should require a study to publish an unmoderated opportunity (A1)', async () => {
      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'unmoderated',
          title: 'Valid Unmoderated Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          status: 'published'
          // Neither firsthand_study_id nor inline_study
        })
        .expect(400);

      expect(response.body.error).toBe(
        'Add at least one prompt to the task list, or link an existing task list, before publishing'
      );
    });

    it('lets the SAME body through as a draft, because the rule is about publishing', async () => {
      /*
       * The other half of the test above, and its absence was a real hole: an
       * independent mutation pass deleted `if (!willBePublished) return null`
       * from the shared predicate and all 234 route tests stayed green. No
       * backend test created a DRAFT that would have violated a publish rule,
       * so nothing could tell "refuses a bad publish" from "refuses a bad
       * opportunity". A draft is allowed to be empty - that is what drafts are
       * for, and the form says so on the Review screen.
       */
      mockQuery.mockResolvedValueOnce({ rows: [] }); // user upsert
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'draft-1',
            type: 'unmoderated',
            title: 'Valid Unmoderated Title',
            purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
            status: 'draft',
            owner_user_id: 'test-user-id',
            created_at: new Date(),
            updated_at: new Date()
          }
        ]
      }); // opportunity insert

      await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'unmoderated',
          title: 'Valid Unmoderated Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          status: 'draft'
          // Neither firsthand_study_id nor inline_study - exactly as above.
        })
        .expect(201);
    });

    it('should create a published unmoderated opportunity when a FirstHand study is linked (A1)', async () => {
      const created = {
        id: '3',
        type: 'unmoderated',
        title: 'Valid Unmoderated Title',
        purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
        status: 'published',
        owner_user_id: 'test-user-id',
        firsthand_study_id: 'study_abc123',
        created_at: new Date(),
        updated_at: new Date()
      };

      mockQuery.mockResolvedValueOnce({ rows: [] }); // user upsert
      mockQuery.mockResolvedValueOnce({ rows: [created] }); // opportunity insert

      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'unmoderated',
          title: 'Valid Unmoderated Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          status: 'published',
          firsthand_study_id: 'study_abc123'
        })
        .expect(201);

      expect(response.body).toMatchObject({
        id: '3',
        type: 'unmoderated',
        firsthand_study_id: 'study_abc123',
        sessions: []
      });
    });

    describe('inline study authoring', () => {
      const inlineBody = {
        type: 'unmoderated',
        title: 'Valid Unmoderated Title',
        purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
        status: 'published',
        inline_study: {
          consent_text: 'We record your screen.',
          steps: [{ type: 'open_text', prompt: 'What did you expect to happen?' }]
        }
      };

      /**
       * The RECORDED create's half of the precondition contract.
       *
       * An independent mutation pass deleted this line and 284 tests still
       * passed: the survey create was covered and this one was not, which is
       * the shape where the uncovered half quietly stops working. A recorded
       * draft created by the autosave would then hold no precondition, and
       * every later save would write under F1's fail-open.
       */
      it('returns the minted study revision, so the next save has a precondition', async () => {
        mockCreateStudy.mockResolvedValueOnce({
          study: { id: 'study_generated', updated_at: '2026-08-21T20:15:00.000Z' },
          steps: []
        });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '9', type: 'unmoderated', firsthand_study_id: 'study_generated', created_at: new Date(), updated_at: new Date() }]
        });

        const response = await request(listening(app))
          .post('/api/opportunities')
          .send(inlineBody)
          .expect(201);

        expect(response.body.linked_study_updated_at).toBe('2026-08-21T20:15:00.000Z');
      });

      // The inline body above omits estimated_duration_minutes, which is the
      // common case: the field is optional and most researchers will leave it.
      it('stores no duration when the author did not give one', async () => {
        mockCreateStudy.mockResolvedValueOnce({ study: { id: 'study_generated' }, steps: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '9', type: 'unmoderated', firsthand_study_id: 'study_generated', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app)).post('/api/opportunities').send(inlineBody).expect(201);

        // NOT 30, and not `default_duration_minutes`. That column is NOT NULL
        // DEFAULT 30, and falling back to it gave every recorded study a length
        // nobody chose, printed above a consent button.
        expect(mockCreateStudy).toHaveBeenCalledWith(
          expect.objectContaining({ estimated_duration_minutes: null })
        );
        // Belt and braces: 30 is the column default that used to be substituted.
        expect(mockCreateStudy.mock.calls[0][0].estimated_duration_minutes).not.toBe(30);
      });

      it('stores the duration the author did give', async () => {
        mockCreateStudy.mockResolvedValueOnce({ study: { id: 'study_generated' }, steps: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '9', type: 'unmoderated', firsthand_study_id: 'study_generated', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app))
          .post('/api/opportunities')
          .send({
            ...inlineBody,
            inline_study: { ...inlineBody.inline_study, estimated_duration_minutes: 18 }
          })
          .expect(201);

        expect(mockCreateStudy).toHaveBeenCalledWith(
          expect.objectContaining({ estimated_duration_minutes: 18 })
        );
      });

      it('publishes without a study id by creating a launched study from the inline payload', async () => {
        mockCreateStudy.mockResolvedValueOnce({
          study: { id: 'study_generated' },
          steps: []
        });
        mockQuery.mockResolvedValueOnce({ rows: [] }); // user upsert
        mockQuery.mockResolvedValueOnce({
          rows: [
            {
              id: '9',
              type: 'unmoderated',
              firsthand_study_id: 'study_generated',
              created_at: new Date(),
              updated_at: new Date()
            }
          ]
        });

        const response = await request(listening(app))
          .post('/api/opportunities')
          .send(inlineBody)
          .expect(201);

        // Launched, not draft: a draft study cannot be selected, so an
        // opportunity pointing at one would be unrunnable.
        expect(mockCreateStudy).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'launched' })
        );

        // Owned by the author, so a second researcher_admin cannot later
        // rewrite its consent copy or a step's target_url.
        expect(mockCreateStudy).toHaveBeenCalledWith(
          expect.objectContaining({ owner_user_id: 'test-user-id' })
        );

        // The end step is appended by toStudySteps, never authored.
        const createdSteps = mockCreateStudy.mock.calls[0][0].steps;
        expect(createdSteps).toHaveLength(2);
        expect(createdSteps[1]).toMatchObject({ type: 'end', order: 2 });

        // The generated id is what lands on the opportunity row. Asserted on
        // the insert parameters, not the response body: the body is built from
        // the mocked row, so it would match regardless of what the route wrote.
        const insertValues = mockQuery.mock.calls[1][1];
        expect(insertValues[10]).toBe('study_generated');
        expect(response.status).toBe(201);
      });

      it('deletes the study it just created when the opportunity insert fails', async () => {
        mockCreateStudy.mockResolvedValueOnce({
          study: { id: 'study_orphan' },
          steps: []
        });
        mockQuery.mockResolvedValueOnce({ rows: [] }); // user upsert
        mockQuery.mockRejectedValueOnce(new Error('insert exploded'));

        await request(listening(app)).post('/api/opportunities').send(inlineBody).expect(500);

        // Studies and opportunities sit on different pools, so this
        // compensating delete is the only thing preventing a launched study
        // that no opportunity references.
        expect(mockDeleteStudyUnchecked).toHaveBeenCalledWith('study_orphan');
      });

      it('rejects a body carrying both a linked study and an authored one', async () => {
        // Resolving this by precedence silently discarded whichever lost, so
        // the ambiguity is refused instead.
        const response = await request(listening(app))
          .post('/api/opportunities')
          .send({ ...inlineBody, firsthand_study_id: 'study_existing' })
          .expect(400);

        expect(response.body.error).toBe(
          'Send either firsthand_study_id or inline_study, not both'
        );
        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('links an existing study without building one when no inline payload is sent', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] }); // user upsert
        mockQuery.mockResolvedValueOnce({
          rows: [
            {
              id: '10',
              type: 'unmoderated',
              firsthand_study_id: 'study_existing',
              created_at: new Date(),
              updated_at: new Date()
            }
          ]
        });

        const { inline_study, ...linkedOnly } = inlineBody;

        await request(listening(app))
          .post('/api/opportunities')
          .send({ ...linkedOnly, firsthand_study_id: 'study_existing' })
          .expect(201);

        expect(mockCreateStudy).not.toHaveBeenCalled();
        expect(mockQuery.mock.calls[1][1][10]).toBe('study_existing');

        // Claim on link. A legacy study migration 0007 could not attribute is
        // writable by ANY admin until it has an owner, so publishing an
        // opportunity that serves it to participants is the last safe moment
        // to close that. Without this, the reuse picker is a way back into the
        // exact attack this feature exists to stop.
        expect(mockClaimStudyIfUnowned).toHaveBeenCalledWith(
          'study_existing',
          'test-user-id'
        );
      });

      it('claims the linked study before the opportunity row is written', async () => {
        // Ordering matters: claiming after the insert leaves a window where a
        // published opportunity points at a study anyone can rewrite, and a
        // failed claim would then have to un-publish something.
        const order: string[] = [];
        mockClaimStudyIfUnowned.mockImplementationOnce(async () => {
          order.push('claim');
          return true;
        });
        mockQuery.mockImplementationOnce(async () => {
          order.push('user-upsert');
          return { rows: [] };
        });
        mockQuery.mockImplementationOnce(async () => {
          order.push('insert');
          return {
            rows: [{ id: '11', created_at: new Date(), updated_at: new Date() }]
          };
        });

        const { inline_study, ...linkedOnly } = inlineBody;

        await request(listening(app))
          .post('/api/opportunities')
          .send({ ...linkedOnly, firsthand_study_id: 'study_existing' })
          .expect(201);

        expect(order.indexOf('claim')).toBeLessThan(order.indexOf('insert'));
      });

      it('does not claim anything when the study is authored inline', async () => {
        // An inline study is created owned, so there is nothing to claim - and
        // a stray claim here would be a second write to a row created in the
        // same request.
        mockCreateStudy.mockResolvedValueOnce({
          study: { id: 'study_inline' },
          steps: []
        });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '12', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app)).post('/api/opportunities').send(inlineBody).expect(201);

        expect(mockClaimStudyIfUnowned).not.toHaveBeenCalled();
      });

      it('refuses to publish on a whitespace-only study id instead of storing null', async () => {
        const { inline_study, ...linkedOnly } = inlineBody;

        const response = await request(listening(app))
          .post('/api/opportunities')
          .send({ ...linkedOnly, firsthand_study_id: '   ' })
          .expect(400);

        expect(response.body.error).toBe(
          'Add at least one prompt to the task list, or link an existing task list, before publishing'
        );
      });

      it('namespaces step ids by study so a second inline study cannot collide', async () => {
        // study_steps.id is a GLOBAL primary key, so position-only ids such as
        // step_1 would make the second inline study fail with a unique
        // violation surfaced as a misleading 409.
        mockCreateStudy.mockResolvedValue({ study: { id: 'ignored' }, steps: [] });
        mockQuery.mockResolvedValue({
          rows: [{ id: 'x', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app)).post('/api/opportunities').send(inlineBody).expect(201);
        await request(listening(app)).post('/api/opportunities').send(inlineBody).expect(201);

        const first = mockCreateStudy.mock.calls[0][0];
        const second = mockCreateStudy.mock.calls[1][0];

        expect(first.id).not.toBe(second.id);
        const firstIds = first.steps.map((s: any) => s.step_id);
        const secondIds = second.steps.map((s: any) => s.step_id);
        expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
        // The id passed to createStudy is the one the steps are namespaced with.
        expect(firstIds[0].startsWith(first.id)).toBe(true);
      });

      it('carries the starting url onto the first step of the created study', async () => {
        mockCreateStudy.mockResolvedValueOnce({ study: { id: 'study_t' }, steps: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '11', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app))
          .post('/api/opportunities')
          .send({
            ...inlineBody,
            inline_study: {
              ...inlineBody.inline_study,
              target_url: 'https://example.com/checkout'
            }
          })
          .expect(201);

        const steps = mockCreateStudy.mock.calls[0][0].steps;
        expect(steps[0].target_url).toBe('https://example.com/checkout');
      });

      it('refuses a starting url that could execute against the participant session', async () => {
        const response = await request(listening(app))
          .post('/api/opportunities')
          .send({
            ...inlineBody,
            inline_study: {
              ...inlineBody.inline_study,
              target_url: 'javascript:alert(1)'
            }
          })
          .expect(400);

        // Asserted on the issue path, not on the body echoing the payload back
        // - that would pass for any 400 that happens to include the request.
        expect(response.body.details).toEqual(
          expect.arrayContaining([expect.stringContaining('target_url')])
        );
        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('rejects a whitespace-only prompt instead of storing an empty one', async () => {
        // The schema trims before min(1). Validating first and trimming later
        // stored "" and produced a study whose session payload could not be
        // assembled, so every participant got a 500 at run time.
        const response = await request(listening(app))
          .post('/api/opportunities')
          .send({
            ...inlineBody,
            inline_study: {
              consent_text: 'We record your screen.',
              steps: [{ type: 'open_text', prompt: '     ' }]
            }
          })
          .expect(400);

        expect(JSON.stringify(response.body)).toContain('prompt');
        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('rejects whitespace-only consent text', async () => {
        await request(listening(app))
          .post('/api/opportunities')
          .send({
            ...inlineBody,
            inline_study: { consent_text: '   ', steps: inlineBody.inline_study.steps }
          })
          .expect(400);

        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('refuses an inline study on a type that cannot carry one', async () => {
        // Create used to drop this silently while PATCH rejected it.
        const response = await request(listening(app))
          .post('/api/opportunities')
          .send({ ...inlineBody, type: 'poll', external_link_optional: 'https://example.com' })
          .expect(400);

        expect(response.body.error).toBe(
          'Only unmoderated studies can carry a task list'
        );
        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('rejects a whitespace-only title rather than naming the study ""', async () => {
        // title and purpose_one_liner become the study's title and intro_text.
        // Validating them untrimmed let "    " satisfy min(4) and store '',
        // producing a study whose session payload cannot assemble.
        const response = await request(listening(app))
          .post('/api/opportunities')
          .send({ ...inlineBody, title: '      ' })
          .expect(400);

        expect(response.body.error).toBe('Validation failed');
        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('rejects a whitespace-only purpose, which becomes the study intro', async () => {
        await request(listening(app))
          .post('/api/opportunities')
          .send({ ...inlineBody, purpose_one_liner: '             ' })
          .expect(400);

        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('answers 503, not 500, when the studies pool is not configured', async () => {
        mockIsStudiesPersistenceConfigured.mockReturnValueOnce(false);

        await request(listening(app)).post('/api/opportunities').send(inlineBody).expect(503);

        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('rejects a choice step with fewer than two options', async () => {
        const response = await request(listening(app))
          .post('/api/opportunities')
          .send({
            ...inlineBody,
            inline_study: {
              consent_text: 'We record your screen.',
              steps: [
                { type: 'single_choice', prompt: 'Pick one', options: ['only one'] }
              ]
            }
          })
          .expect(400);

        // Names the offending field rather than merely being defined, so the
        // assertion cannot pass on an unrelated schema failure.
        expect(JSON.stringify(response.body)).toContain('options');
        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      /**
       * B3: the picker copies a study rather than linking to it, and the copy
       * carries where it came from. The identical assertion is made for
       * inline_survey immediately below the survey describe block - a
       * property proved on only one twin is this project's most recurring
       * defect.
       */
      it('passes copied_from_study_id through to createStudy', async () => {
        mockCreateStudy.mockResolvedValueOnce({ study: { id: 'study_copy' }, steps: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '15', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app))
          .post('/api/opportunities')
          .send({
            ...inlineBody,
            inline_study: { ...inlineBody.inline_study, copied_from_study_id: 'study_source' }
          })
          .expect(201);

        expect(mockCreateStudy).toHaveBeenCalledWith(
          expect.objectContaining({ copied_from_study_id: 'study_source' })
        );
      });

      it('sends null, not undefined, for copied_from_study_id when none is given', async () => {
        mockCreateStudy.mockResolvedValueOnce({ study: { id: 'study_blank' }, steps: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '16', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app)).post('/api/opportunities').send(inlineBody).expect(201);

        const created = mockCreateStudy.mock.calls[0][0];
        expect(created.copied_from_study_id).toBeNull();
        expect('copied_from_study_id' in created).toBe(true);
      });

      /**
       * The recorded twin of the consent-claim assertions in the survey block.
       *
       * This one has a failure mode the survey twin does not: `inlineStudySchema`
       * is NOT `.strict()`, so an undeclared key here is stripped in silence
       * rather than refused. The survey path would 400 loudly for the same
       * mistake; this path would simply lose the claim and reclassify the study
       * on every save, with a green build either side of it.
       */
      it('passes the consent template claim through to createStudy', async () => {
        mockCreateStudy.mockResolvedValueOnce({ study: { id: 'study_c' }, steps: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '21', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app))
          .post('/api/opportunities')
          .send({
            ...inlineBody,
            inline_study: {
              ...inlineBody.inline_study,
              consent_template_id: 'recorded-default',
              consent_template_version: 1
            }
          })
          .expect(201);

        const created = mockCreateStudy.mock.calls[0][0];
        expect(created.consent_template_id).toBe('recorded-default');
        expect(created.consent_template_version).toBe(1);
      });

      it('sends null for the consent claim when the client makes none', async () => {
        mockCreateStudy.mockResolvedValueOnce({ study: { id: 'study_d' }, steps: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '22', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app)).post('/api/opportunities').send(inlineBody).expect(201);

        const created = mockCreateStudy.mock.calls[0][0];
        expect(created.consent_template_id).toBeNull();
        expect(created.consent_template_version).toBeNull();
      });
    });

    it('should reject an unmoderated opportunity with an external participant type (M2)', async () => {
      const response = await request(listening(app))
        .post('/api/opportunities')
        .send({
          type: 'unmoderated',
          title: 'Valid Unmoderated Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          participant_type_required: 'external'
        })
        .expect(400);

      expect(response.body.error).toBe(
        'Unmoderated studies cannot use an external participant type; participants must be logged-in Cortex users'
      );
    });

    /**
     * FIX 1 (security review, B3): `firsthand_study_id` is still a writable
     * field on this schema, and until this fix the only server-side check on
     * it was kind-and-existence - never ownership. Two authenticated calls
     * (create a study as one user, then link it here as another) still
     * reached the exact shared-link state B3's copy-on-select exists to
     * remove, no UI involved.
     */
    describe('linking a study you do not own (FIX 1)', () => {
      const linkedStudy = (ownerUserId: string | null) => ({
        study: {
          id: 'study_colleagues',
          title: 'A task list',
          intro_text: 'Intro',
          consent_text: 'Consent',
          status: 'launched' as const,
          kind: 'recorded' as const,
          owner_user_id: ownerUserId,
          copied_from_study_id: null,
          created_at: '2026-08-17T10:00:00.000Z',
          updated_at: '2026-08-17T10:00:00.000Z',
        },
        steps: []
      });

      const linkBody = {
        type: 'unmoderated',
        title: 'Valid Unmoderated Title',
        purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
        firsthand_study_id: 'study_colleagues',
        status: 'published'
      };

      it('refuses to link a study owned by another researcher', async () => {
        mockGetStudyById.mockResolvedValueOnce(linkedStudy('someone-else'));

        const response = await request(listening(app))
          .post('/api/opportunities')
          .send(linkBody)
          .expect(403);

        expect(response.body.error).toMatch(/belongs to another researcher/);
        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('still links an unowned study', async () => {
        // canWriteStudy(null, ...) is true, and claimStudyIfUnowned depends
        // on this staying reachable - a legacy row with no owner must still
        // be linkable, or it can never be claimed.
        mockGetStudyById.mockResolvedValueOnce(linkedStudy(null));
        mockQuery.mockResolvedValueOnce({ rows: [] }); // user upsert
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '20', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app)).post('/api/opportunities').send(linkBody).expect(201);
      });

      it('still links a study you own', async () => {
        mockGetStudyById.mockResolvedValueOnce(linkedStudy('test-user-id'));
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '21', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(app)).post('/api/opportunities').send(linkBody).expect(201);
      });

      it('lets a superadmin link a study owned by someone else', async () => {
        const superadminApp = express();
        superadminApp.use(express.json());
        superadminApp.use((req, _res, next) => {
          (req as unknown as { session: { user: unknown } }).session = {
            user: {
              id: 'superadmin-id',
              name: 'Super Admin',
              email: 'super@example.com',
              role: 'superadmin'
            }
          };
          next();
        });
        superadminApp.use('/api/opportunities', opportunitiesRouter);
        superadminApp.use(errorHandler);

        mockGetStudyById.mockResolvedValueOnce(linkedStudy('someone-else'));
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '22', created_at: new Date(), updated_at: new Date() }]
        });

        await request(listening(superadminApp)).post('/api/opportunities').send(linkBody).expect(201);
      });
    });
  });

  describe('PATCH /api/opportunities/:id inline study', () => {
    // status is explicit: omitting it left existingOpp.rows[0].status
    // undefined, so willBePublished evaluated false in every case and the guard
    // it drives was only ever exercised by the one test that set it.
    const existingUnmoderated = (
      firsthandStudyId: string | null,
      status: 'draft' | 'published' | 'closed' = 'draft'
    ) => ({
      type: 'unmoderated',
      status,
      title: 'Existing title',
      purpose_one_liner: 'Existing purpose that is comfortably long enough',
      external_link_optional: null,
      firsthand_study_id: firsthandStudyId,
      participant_type_required: 'any'
    });

    const inlineStudy = {
      consent_text: 'We record your screen.',
      steps: [{ type: 'open_text', prompt: 'What did you expect?' }]
    };

    it('lets a draft saved without tasks get them on the way back in', async () => {
      // The gap this closes: an unmoderated draft is legitimately savable with
      // no tasks, and editing used to force the reuse picker, sending the
      // author back to the create-and-launch-elsewhere errand.
      mockCreateStudy.mockResolvedValueOnce({
        study: { id: 'study_from_edit' },
        steps: []
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated(null)] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: '1',
            firsthand_study_id: 'study_from_edit',
            created_at: new Date(),
            updated_at: new Date()
          }
        ]
      });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ status: 'published', inline_study: inlineStudy })
        .expect(200);

      expect(mockCreateStudy).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'launched' })
      );
      // Inherits the opportunity's own title rather than a placeholder, which
      // needs title/purpose in the existing-row SELECT.
      expect(mockCreateStudy.mock.calls[0][0].title).toBe('Existing title');
      // Owned by whoever authored it on this edit.
      expect(mockCreateStudy.mock.calls[0][0].owner_user_id).toBe('test-user-id');

      // The generated id reaches the UPDATE, and inline_study never becomes a
      // column name in it.
      const updateSql = mockQuery.mock.calls[2][0];
      expect(updateSql).toContain('firsthand_study_id');
      expect(updateSql).not.toContain('inline_study');
      expect(mockQuery.mock.calls[2][1]).toContain('study_from_edit');
    });

    /**
     * The PATCH fallback-mint twin of the POST-create assertion: provenance
     * must reach createStudy from this second minting site too, not only the
     * one on the create route.
     */
    it('passes copied_from_study_id through on the PATCH fallback mint', async () => {
      mockCreateStudy.mockResolvedValueOnce({
        study: { id: 'study_from_edit_copy' },
        steps: []
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated(null)] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: '1',
            firsthand_study_id: 'study_from_edit_copy',
            created_at: new Date(),
            updated_at: new Date()
          }
        ]
      });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({
          status: 'published',
          inline_study: { ...inlineStudy, copied_from_study_id: 'study_source' }
        })
        .expect(200);

      expect(mockCreateStudy).toHaveBeenCalledWith(
        expect.objectContaining({ copied_from_study_id: 'study_source' })
      );
    });

    /** The recorded twin of the survey fallback-mint claim assertion. */
    it('carries the consent template claim onto the PATCH fallback mint', async () => {
      mockCreateStudy.mockResolvedValueOnce({
        study: { id: 'study_from_edit_claim' },
        steps: []
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated(null)] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: '1',
            firsthand_study_id: 'study_from_edit_claim',
            created_at: new Date(),
            updated_at: new Date()
          }
        ]
      });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({
          status: 'published',
          inline_study: {
            ...inlineStudy,
            consent_template_id: 'recorded-default',
            consent_template_version: 1
          }
        })
        .expect(200);

      const created = mockCreateStudy.mock.calls[0][0];
      expect(created.consent_template_id).toBe('recorded-default');
      expect(created.consent_template_version).toBe(1);
    });

    it('sends null, not undefined, for copied_from_study_id on the PATCH fallback mint when none is given', async () => {
      mockCreateStudy.mockResolvedValueOnce({
        study: { id: 'study_from_edit_blank' },
        steps: []
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated(null)] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: '1',
            firsthand_study_id: 'study_from_edit_blank',
            created_at: new Date(),
            updated_at: new Date()
          }
        ]
      });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ status: 'published', inline_study: inlineStudy })
        .expect(200);

      const created = mockCreateStudy.mock.calls[0][0];
      expect(created.copied_from_study_id).toBeNull();
      expect('copied_from_study_id' in created).toBe(true);
    });

    it('does not inherit an empty stored title into the study it creates', async () => {
      // Rows written before the schema trimmed these fields can hold ''. `??`
      // only guards null/undefined, so it propagated '' straight into a study
      // whose session payload then failed to assemble.
      mockCreateStudy.mockResolvedValueOnce({ study: { id: 'study_x' }, steps: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...existingUnmoderated(null), title: '', purpose_one_liner: '' }]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
        rowCount: 1
      });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ inline_study: inlineStudy })
        .expect(200);

      const created = mockCreateStudy.mock.calls[0][0];
      expect(created.title).toBe('Untitled study');
      expect(created.intro_text).toBe('Recorded session');
    });

    it('claims an unowned study when an edit links one', async () => {
      // The PATCH half of claim-on-link. Attaching a study to an existing
      // opportunity puts it in front of participants just as surely as
      // creating one does, so it must not still be writable by every admin.
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated(null)] });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
        rowCount: 1
      });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ firsthand_study_id: 'study_reused' })
        .expect(200);

      expect(mockClaimStudyIfUnowned).toHaveBeenCalledWith(
        'study_reused',
        'test-user-id'
      );
    });

    it('does not claim when an edit clears the study link', async () => {
      // '' and null both mean "no study" here; neither is a study id, and
      // claiming on one would be a write against a row that does not exist.
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated(null)] });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
        rowCount: 1
      });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ firsthand_study_id: '   ' })
        .expect(200);

      expect(mockClaimStudyIfUnowned).not.toHaveBeenCalled();
    });

    /**
     * A0. Every one of these used to be a flat refusal - "edit its tasks in the
     * Task Lists area" - because `inline_study` only ever created. Nothing
     * downstream is safe until an edit can write the study it is already
     * linked to: A1 makes authored content editable from this form, and every
     * save would otherwise be refused.
     */
    describe('updating the linked task list in place', () => {
      // Every case here starts from an opportunity that ALREADY has a study,
      // which is the whole point. `expectUpdate` is queued only where the
      // request reaches the opportunity write - a queued-but-unreached row
      // survives clearAllMocks and poisons the next test.
      const patchLinked = (
        body: Record<string, unknown>,
        expectUpdate = false,
        sharedWithAnother = false
      ) => {
        mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
        mockQuery.mockResolvedValueOnce({
          rows: [existingUnmoderated('study_already_linked')]
        });
        // "Is any OTHER opportunity linked to this study?" - queued for every
        // in-place attempt, because it runs before the write decision.
        mockQuery.mockResolvedValueOnce(
          sharedWithAnother ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
        );
        if (expectUpdate) {
          mockQuery.mockResolvedValueOnce({
            rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
            rowCount: 1
          });
        }
        return request(listening(app)).patch('/api/opportunities/1').send(body);
      };

      /**
       * The write against `opportunities`, found by what it IS rather than by
       * its position in mockQuery.mock.calls. Index-based lookups here broke
       * the moment a read was added ahead of them, and an index that silently
       * points at a different query is exactly the shape of assertion that
       * passes without reaching its subject. Asserting there is exactly one
       * also catches a second write nobody intended.
       */
      const opportunityWrite = () => {
        const calls = (mockQuery.mock.calls as unknown as [string, unknown[]][]).filter(
          ([sql]) =>
            typeof sql === 'string' &&
            (sql.includes('UPDATE opportunities') ||
              sql.includes('SELECT * FROM opportunities'))
        );
        expect(calls).toHaveLength(1);
        return calls[0];
      };

      /**
       * The recorded twin of the survey revision assertion.
       *
       * Written because a mutation proved it was missing: deleting the line
       * that carries the revision out of THIS branch left every test in the
       * file green, while the survey branch's identical line was caught. Both
       * branches feed the same in-place update and both are read by the same
       * autosave, so one covered and one not is the shape where the uncovered
       * half quietly stops working.
       */
      it('returns the rewritten study revision, as the survey branch does', async () => {
        mockUpdateStudy.mockResolvedValueOnce({
          ok: true as const,
          claimed: false,
          study: {
            id: 'study_already_linked',
            title: 'A study',
            intro_text: 'Intro',
            consent_text: 'We record your screen.',
            kind: 'recorded' as const,
            status: 'launched',
            owner_user_id: 'test-user-id',
            created_at: '2026-08-16T10:00:00.000Z',
            updated_at: '2026-08-21T19:15:00.000Z'
          },
          steps: []
        } as never);

        const response = await patchLinked(
          { title: 'A new title', inline_study: inlineStudy },
          true
        ).expect(200);

        expect(response.body.linked_study_updated_at).toBe('2026-08-21T19:15:00.000Z');
      });

      it('rewrites the linked study rather than minting a second one', async () => {
        await patchLinked({ title: 'A new title', inline_study: inlineStudy }, true)
          .expect(200);

        expect(mockCreateStudy).not.toHaveBeenCalled();
        expect(mockUpdateStudy).toHaveBeenCalledTimes(1);
        expect(mockUpdateStudy.mock.calls[0][0]).toBe('study_already_linked');

        const written = mockUpdateStudy.mock.calls[0][1] as {
          consent_text: string;
          steps: { step_id: string; prompt?: string }[];
        };
        expect(written.consent_text).toBe('We record your screen.');
        // Namespaced against the study that already exists, so the ids the
        // collected answers were written against keep resolving.
        expect(written.steps[0].step_id.startsWith('study_already_linked_')).toBe(true);
      });

      /**
       * F1. The precondition has to arrive as an ARGUMENT to updateStudy and
       * has to be gone from the payload, and both halves matter.
       *
       * UpdateOpportunitySchema is `z.object`, not strict, so an undeclared
       * field is stripped in silence - the precondition would simply never
       * arrive, the write would proceed under the fail-open, and nothing
       * anywhere would say so. And a field that survived into `data` would be
       * emitted by the generic field loop as `SET expected_study_updated_at =
       * $n` against a column that does not exist, answering 500 on every save.
       */
      it('forwards the study precondition and keeps it out of the opportunity columns', async () => {
        await patchLinked(
          {
            inline_study: inlineStudy,
            expected_study_updated_at: '2026-08-21T09:15:30.123Z'
          },
          true
        ).expect(200);

        expect(mockUpdateStudy.mock.calls[0][3]).toBe('2026-08-21T09:15:30.123Z');

        const [sql, values] = opportunityWrite();
        expect(sql).not.toContain('expected_study_updated_at');
        expect(values as unknown[]).not.toContain('2026-08-21T09:15:30.123Z');
      });

      it('answers 409 when the linked study moved under the caller', async () => {
        mockUpdateStudy.mockResolvedValueOnce({
          ok: false,
          reason: 'stale',
          current_updated_at: '2026-08-21T09:15:30.123Z'
        } as never);

        const res = await patchLinked(
          {
            inline_study: inlineStudy,
            expected_study_updated_at: '2026-08-21T09:15:29.123Z'
          },
          false
        ).expect(409);

        // The SAME body shape the study route answers, deliberately - one
        // logical refusal, one shape. `error` is a discriminator and not prose,
        // because errorHandler maps a unique-constraint violation and a lock
        // timeout to 409 as well, and a client with only the status to go on
        // would treat one of those as a colleague's save.
        expect(res.body.error).toBe('stale_study');
        expect(res.body.message).toMatch(/somebody else/i);
        // The sentence has to promise what the refusal actually delivers.
        expect(res.body.message).toMatch(/still here/i);
        // Carried so the client can recover without a second request that can
        // itself fail and strand the author in a loop.
        expect(res.body.current_updated_at).toBe('2026-08-21T09:15:30.123Z');
      });

      /**
       * The dangling-link REPAIR path also has to hand back a precondition.
       *
       * An independent mutation pass deleted the line that carries it here and
       * 284 tests passed. This is the branch an opportunity takes when the
       * study it pointed at has gone: the route mints a replacement and
       * repoints the row. Without the revision, the very next autosave on a
       * just-repaired opportunity writes under F1's fail-open - and this is
       * the path reached by exactly the rows nobody is watching.
       */
      it('returns the replacement study revision when it repairs a dangling link', async () => {
        mockGetStudyById.mockResolvedValueOnce(null as never);
        mockCreateStudy.mockResolvedValueOnce({
          study: { id: 'study_replacement', updated_at: '2026-08-21T20:20:00.000Z' },
          steps: []
        } as never);

        const response = await patchLinked({ inline_study: inlineStudy }, true).expect(200);

        expect(mockCreateStudy).toHaveBeenCalled();
        expect(response.body.linked_study_updated_at).toBe('2026-08-21T20:20:00.000Z');
      });

      /**
       * The failure mode this outcome exists to prevent, and it is the
       * expensive one.
       *
       * `missing` deliberately falls through to minting a replacement study.
       * A conflict that fell through the same branch would repoint the
       * opportunity at a brand-new study and abandon the one the colleague had
       * just saved - the data loss F1 exists to close, reached from the other
       * direction and with no error anywhere to show for it.
       */
      it('mints nothing when the write is refused as stale', async () => {
        mockUpdateStudy.mockResolvedValueOnce({
          ok: false,
          reason: 'stale',
          current_updated_at: '2026-08-21T09:15:30.123Z'
        } as never);

        await patchLinked(
          {
            inline_study: inlineStudy,
            expected_study_updated_at: '2026-08-21T09:15:29.123Z'
          },
          false
        ).expect(409);

        expect(mockCreateStudy).not.toHaveBeenCalled();
        expect(
          (mockQuery.mock.calls as unknown as [string, unknown[]][]).filter(
            ([sql]) => typeof sql === 'string' && sql.includes('UPDATE opportunities')
          )
        ).toHaveLength(0);
      });

      /**
       * The fail-open is only defensible because it is DISCOVERABLE, and until
       * this test nothing checked that the discovery mechanism existed.
       *
       * Spied rather than module-mocked: this file does not mock the logger,
       * and mocking it wholesale here would silence every other line the route
       * emits for the rest of the suite.
       */
      it('warns when the linked study is rewritten with no precondition', async () => {
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

        try {
          await patchLinked({ inline_study: inlineStudy }, true).expect(200);

          expect(warn).toHaveBeenCalledWith(
            'Study updated with no concurrency precondition',
            {
              studyId: 'study_already_linked',
              userId: 'test-user-id',
              via: 'opportunity-form'
            }
          );
        } finally {
          warn.mockRestore();
        }
      });

      it('stays silent when the precondition WAS sent', async () => {
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

        try {
          await patchLinked(
            {
              inline_study: inlineStudy,
              expected_study_updated_at: '2026-08-21T09:15:30.123Z'
            },
            true
          ).expect(200);

          expect(warn).not.toHaveBeenCalledWith(
            'Study updated with no concurrency precondition',
            expect.anything()
          );
        } finally {
          warn.mockRestore();
        }
      });

      it('does not claim an unprotected update for a write that was refused', async () => {
        // The placement. Logged before `updateStudy`, this line fired for a
        // `forbidden` and a `not_found` too - a claim that an unprotected
        // update happened when none did.
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
        mockUpdateStudy.mockResolvedValueOnce({
          ok: false,
          reason: 'forbidden'
        } as never);

        try {
          await patchLinked({ inline_study: inlineStudy }, false).expect(403);

          expect(warn).not.toHaveBeenCalledWith(
            'Study updated with no concurrency precondition',
            expect.anything()
          );
        } finally {
          warn.mockRestore();
        }
      });

      it('records a refused stale write, so it is not silent', async () => {
        // The 409 body carries no identity by design; this line is what keeps
        // "who" answerable to an operator.
        const info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
        mockUpdateStudy.mockResolvedValueOnce({
          ok: false,
          reason: 'stale',
          current_updated_at: '2026-08-21T09:15:30.123Z'
        } as never);

        try {
          await patchLinked(
            {
              inline_study: inlineStudy,
              expected_study_updated_at: '2026-08-21T09:15:29.123Z'
            },
            false
          ).expect(409);

          expect(info).toHaveBeenCalledWith('Refused a stale study write', {
            studyId: 'study_already_linked',
            userId: 'test-user-id',
            via: 'opportunity-form'
          });
        } finally {
          info.mockRestore();
        }
      });

      it('names the task list, not the questions, on the recorded branch', async () => {
        // The two branches say different sentences, and a sentence that names
        // the wrong thing sends the author to the wrong screen.
        mockUpdateStudy.mockResolvedValueOnce({
          ok: false,
          reason: 'stale',
          current_updated_at: '2026-08-21T09:15:30.123Z'
        } as never);

        const res = await patchLinked(
          {
            inline_study: inlineStudy,
            expected_study_updated_at: '2026-08-21T09:15:29.123Z'
          },
          false
        ).expect(409);

        expect(res.body.message).toMatch(/this task list/i);
        expect(res.body.message).not.toMatch(/these questions/i);
      });

      it('names no user in the conflict it reports', async () => {
        mockUpdateStudy.mockResolvedValueOnce({
          ok: false,
          reason: 'stale',
          current_updated_at: '2026-08-21T09:15:30.123Z'
        } as never);

        const res = await patchLinked(
          {
            inline_study: inlineStudy,
            expected_study_updated_at: '2026-08-21T09:15:29.123Z'
          },
          false
        ).expect(409);

        // The KEY SET, not an absence-of-substring check. Asserting that
        // 'updated_by' does not appear would pass just as happily if the route
        // started returning `{ lastEditor: 'admin-1' }` - this repo has been
        // bitten by exactly that shape of assertion before.
        expect(Object.keys(res.body).sort()).toEqual([
          'current_updated_at',
          'error',
          'message'
        ]);
      });

      it('refuses a malformed precondition before any study write', async () => {
        // Deliberately NOT through `patchLinked`: validateRequest rejects this
        // body before a single query runs, so queuing rows here would leave
        // three unreached once-values behind for the next test to consume. See
        // the note on `expectUpdate` above - that is the shape of poisoning
        // this file has already been bitten by.
        await request(listening(app))
          .patch('/api/opportunities/1')
          .send({ inline_study: inlineStudy, expected_study_updated_at: 'yesterday' })
          .expect(400);

        expect(mockQuery).not.toHaveBeenCalled();
        expect(mockUpdateStudy).not.toHaveBeenCalled();
        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      /**
       * C1: the in-place path is the one an ordinary edit takes, so it is the
       * one that decides whether a study's classification survives being saved.
       * Dropping the claim here does not break a save - it silently
       * reclassifies the study against the newest template on every edit, which
       * is invisible until a version 2 exists and then wrong everywhere at once.
       */
      it('carries the consent template claim into the in-place update', async () => {
        await patchLinked(
          {
            inline_study: {
              ...inlineStudy,
              consent_template_id: 'recorded-default',
              consent_template_version: 1
            }
          },
          true
        ).expect(200);

        const written = mockUpdateStudy.mock.calls[0][1] as {
          consent_template_id?: string | null;
          consent_template_version?: number | null;
        };
        expect(written.consent_template_id).toBe('recorded-default');
        expect(written.consent_template_version).toBe(1);
      });

      it('sends an explicit null claim when the client makes none, rather than omitting it', async () => {
        await patchLinked({ inline_study: inlineStudy }, true).expect(200);

        const written = mockUpdateStudy.mock.calls[0][1] as Record<string, unknown>;
        // Present-and-null, not absent. `updateStudy` pushes the classification
        // whenever `consent_text` is present, so absent here would be the same
        // request - but asserting the key exists pins that this path never
        // adopts the leave-it-alone conditional spread the DURATION field uses,
        // where absent means "do not touch". Consent and its classification are
        // written as one thing.
        expect('consent_template_id' in written).toBe(true);
        expect(written.consent_template_id).toBeNull();
        expect(written.consent_template_version).toBeNull();
      });

      it('does not repoint the opportunity when it updates in place', async () => {
        await patchLinked({ title: 'A new title', inline_study: inlineStudy }, true)
          .expect(200);

        // The whole defect in one assertion: the link must be untouched, so
        // firsthand_study_id must not appear in the UPDATE at all.
        const [updateSql] = opportunityWrite();
        expect(updateSql).toContain('UPDATE opportunities');
        expect(updateSql).not.toContain('firsthand_study_id');
      });

      it('repeated saves never create a study', async () => {
        // The count assertion the plan calls for, in the shape this suite can
        // make it: across a sequence of saves, not the response of any one
        // call. The row-count version runs against a real Postgres.
        for (let i = 0; i < 5; i++) {
          await patchLinked({ inline_study: inlineStudy }, true).expect(200);
        }

        expect(mockCreateStudy).not.toHaveBeenCalled();
        expect(mockUpdateStudy).toHaveBeenCalledTimes(5);
      });

      it('answers 200 for a request whose only content was the task list', async () => {
        // No column on `opportunities` changes, so the field loop is empty.
        // Before this was handled the route answered "No fields to update" for
        // a save that had written everything it carried - and that is exactly
        // the body an autosave sends.
        mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
        mockQuery.mockResolvedValueOnce({
          rows: [existingUnmoderated('study_already_linked')]
        });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
          rowCount: 1
        });

        const response = await request(listening(app))
          .patch('/api/opportunities/1')
          .send({ inline_study: inlineStudy })
          .expect(200);

        // Read back rather than written, so the BEFORE UPDATE trigger does not
        // stamp updated_at on a row that did not change.
        const [sql, params] = opportunityWrite();
        expect(sql).toContain('SELECT * FROM opportunities');
        expect(sql).not.toContain('UPDATE opportunities');
        // The parameters matter as much as the text: mockQuery never parses
        // SQL, so a placeholder numbered $2 against a one-element list passes
        // here and answers 500 in production for every autosave.
        expect(sql).toContain('$1');
        expect(params).toEqual(['1']);

        // The response is still shaped by the same code the UPDATE path uses.
        expect(response.body.created_at).toEqual(expect.any(String));
        expect(response.body.sessions).toEqual([]);
      });

      it('passes the requesting user through as the study write authorisation', async () => {
        await patchLinked({ inline_study: inlineStudy }, true).expect(200);

        // The route must not decide ownership itself: the decision is taken
        // inside updateStudy's transaction, behind its row lock. All this
        // asserts is that the requester reaching it is the real one.
        expect(mockUpdateStudy.mock.calls[0][2]).toEqual({
          userId: 'test-user-id',
          isSuperadmin: false
        });
      });

      it('reports a superadmin as one, so they are not refused their own override', async () => {
        // The pair matters, not either half: asserting only the
        // researcher_admin case above passes just as happily against a
        // hardcoded `isSuperadmin: false`, which would silently take a
        // superadmin's write on someone else's study away from them.
        const superadminApp = express();
        superadminApp.use(express.json());
        superadminApp.use((req, res, next) => {
          // Cast rather than `(req: any)`: same budget reason as mockUpdateStudy
          // above. An intersection does not work here - express-session's
          // declaration merging already types req.session as a full Session.
          (req as unknown as { session: { user: unknown } }).session = {
            user: {
              id: 'superadmin-id',
              name: 'Super Admin',
              email: 'super@example.com',
              role: 'superadmin'
            }
          };
          next();
        });
        superadminApp.use('/api/opportunities', opportunitiesRouter);
        superadminApp.use(errorHandler);

        mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'someone-else' }] });
        mockQuery.mockResolvedValueOnce({
          rows: [existingUnmoderated('study_already_linked')]
        });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
          rowCount: 1
        });

        await request(listening(superadminApp))
          .patch('/api/opportunities/1')
          .send({ inline_study: inlineStudy })
          .expect(200);

        expect(mockUpdateStudy.mock.calls[0][2]).toEqual({
          userId: 'superadmin-id',
          isSuperadmin: true
        });
      });

      it('refuses to change the questions of a study that has collected answers', async () => {
        // The defect this guard exists for: step ids are positional, so
        // rewriting the steps re-attributes stored answers to whichever
        // question now sits at that index. Nothing surfaces it afterwards.
        mockStudyHasResponses.mockResolvedValueOnce(true);

        const response = await patchLinked({ inline_study: inlineStudy }).expect(400);

        expect(response.body.error).toMatch(/already collected answers/);
        expect(mockUpdateStudy).not.toHaveBeenCalled();
        // And no mint either - a replacement study would repoint the
        // opportunity away from the answers it has already collected.
        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('still allows a consent edit on a study that has collected answers', async () => {
        // The guard is on identity, not on the study. Refusing every save
        // would make a study unfixable the moment one person answered, and a
        // consent or duration edit moves no question onto another's id.
        mockStudyHasResponses.mockResolvedValue(true);
        mockGetStudyById.mockResolvedValueOnce({
          study: {
            id: 'study_already_linked',
            title: 'A study',
            intro_text: 'Intro',
            consent_text: 'The old wording',
            kind: 'recorded',
            estimated_duration_minutes: undefined,
            status: 'launched',
            owner_user_id: 'test-user-id',
            copied_from_study_id: null,
            created_at: '2026-08-16T10:00:00.000Z',
            updated_at: '2026-08-16T10:00:00.000Z',
          },
          // Exactly what inlineStudy serialises to, so the sequence is
          // unchanged and only the consent differs.
          steps: toStudySteps(inlineStudy.steps as never, 'study_already_linked', undefined),
        } as never);

        await patchLinked(
          { inline_study: { ...inlineStudy, consent_text: 'New wording.' } },
          true
        ).expect(200);

        expect(mockUpdateStudy).toHaveBeenCalledTimes(1);
        expect(
          (mockUpdateStudy.mock.calls[0][1] as { consent_text: string }).consent_text
        ).toBe('New wording.');

        mockStudyHasResponses.mockResolvedValue(false);
      });

      /**
       * A study built by hand in the Task Lists area, whose steps are numbered
       * the way StudyEditor numbers them - zero-padded to three digits.
       * `toStudySteps` numbers unpadded, so this is the shape that exposes
       * whether the route keeps the identity it was given or invents new ones.
       */
      const storedWithPaddedIds = (
        steps: { type: 'instruction' | 'open_text'; prompt: string }[]
      ) => ({
        study: {
          id: 'study_already_linked',
          title: 'Built in the Task Lists area',
          intro_text: 'Intro',
          consent_text: 'We record your screen.',
          kind: 'recorded',
          estimated_duration_minutes: undefined,
          status: 'launched',
          owner_user_id: 'test-user-id',
          copied_from_study_id: null,
          created_at: '2026-08-16T10:00:00.000Z',
          updated_at: '2026-08-16T10:00:00.000Z',
        },
        steps: [
          ...steps.map((step, index) => ({
            step_id: `study_already_linked_step_${String(index + 1).padStart(3, '0')}`,
            order: index + 1,
            type: step.type,
            prompt: step.prompt,
          })),
          {
            step_id: 'study_already_linked_step_end',
            order: steps.length + 1,
            type: 'end' as const,
            prompt: 'Thanks - that is the end of the study.',
          },
        ],
      });

      /** Exactly what `inlineStudy` serialises to, so only the ids differ. */
      const sameSequenceAsInlineStudy = [
        { type: 'open_text' as const, prompt: 'What did you expect?' },
      ];

      it('keeps the stored step ids instead of renumbering them', async () => {
        // The ids in the payload are derived from array position and are
        // UNPADDED. Taking them would rewrite every id of a hand-built study,
        // detaching any answer already written against the old one. The answers
        // guard cannot save us here - it would have passed, because the
        // sequence is otherwise identical.
        mockGetStudyById.mockResolvedValueOnce(
          storedWithPaddedIds(sameSequenceAsInlineStudy) as never
        );

        await patchLinked({ inline_study: inlineStudy }, true).expect(200);

        const written = mockUpdateStudy.mock.calls[0][1] as {
          steps: { step_id: string }[];
        };
        expect(written.steps.map((step) => step.step_id)).toEqual([
          'study_already_linked_step_001',
          'study_already_linked_step_end',
        ]);
      });

      /**
       * F2. When the payload carries identity, the two mitigations above are
       * turned OFF - and that is the point of the step rather than a relaxation
       * of it.
       *
       * Both of them exist only because a key-less payload's ids are derived
       * from array position and therefore mean nothing. A payload where every
       * item carries a `step_key` was built by a client that has tracked each
       * question's identity since the moment it was created, so its ids ARE the
       * identity: positionally rewriting them is the corruption, and refusing
       * the save protects nothing while making a live study uneditable.
       */
      describe('when the payload carries each question\'s identity', () => {
        type KeyedStep = {
          step_key: string;
          type: 'open_text' | 'instruction';
          prompt: string;
        };

        const keyedStudy: { consent_text: string; steps: KeyedStep[] } = {
          consent_text: 'We record your screen.',
          steps: [
            { step_key: 'alpha', type: 'open_text', prompt: 'What did you expect?' },
            { step_key: 'bravo', type: 'open_text', prompt: 'What surprised you?' },
          ],
        };

        // Restored here rather than only at the end of each test that sets it:
        // `jest.clearAllMocks()` in the suite's beforeEach clears CALLS but not
        // implementations, so one failing assertion would otherwise leave
        // "this study has answers" true for the rest of the file and turn a
        // single failure into dozens.
        afterEach(() => {
          mockStudyHasResponses.mockResolvedValue(false);
        });

        /** The two keyed steps as they are already stored, in the same order. */
        const storedKeyed = {
          study: {
            id: 'study_already_linked',
            title: 'A keyed study',
            intro_text: 'Intro',
            consent_text: 'We record your screen.',
            kind: 'recorded',
            estimated_duration_minutes: undefined,
            status: 'launched',
            owner_user_id: 'test-user-id',
            copied_from_study_id: null,
            created_at: '2026-08-16T10:00:00.000Z',
            updated_at: '2026-08-16T10:00:00.000Z',
          },
          steps: toStudySteps(keyedStudy.steps as never, 'study_already_linked', undefined),
        };

        it('lets the author reorder a study that has already collected answers', async () => {
          // Before F2 this was a 400 telling the author to go to the Task Lists
          // area. The reorder is safe now because the ids move WITH the
          // questions, which the next assertion is what actually proves.
          mockStudyHasResponses.mockResolvedValue(true);
          mockGetStudyById.mockResolvedValueOnce(storedKeyed as never);

          await patchLinked(
            { inline_study: { ...keyedStudy, steps: [...keyedStudy.steps].reverse() } },
            true
          ).expect(200);

          expect(mockUpdateStudy).toHaveBeenCalledTimes(1);
        });

        it('writes the reordered questions under the SAME ids they already had', async () => {
          // The whole of F2, as one assertion. Question `bravo` is now first
          // and still carries the id it has always carried, so the answers
          // stored against `study_already_linked_bravo` still belong to "What
          // surprised you?".
          //
          // A count assertion, or an assertion on the prompts, passes against
          // the positional ids that re-attributed four participants' answers.
          mockStudyHasResponses.mockResolvedValue(true);
          mockGetStudyById.mockResolvedValueOnce(storedKeyed as never);

          await patchLinked(
            { inline_study: { ...keyedStudy, steps: [...keyedStudy.steps].reverse() } },
            true
          ).expect(200);

          const written = mockUpdateStudy.mock.calls[0][1] as {
            steps: { step_id: string; prompt: string }[];
          };

          expect(written.steps.map((step) => [step.step_id, step.prompt])).toEqual([
            ['study_already_linked_bravo', 'What surprised you?'],
            ['study_already_linked_alpha', 'What did you expect?'],
            ['study_already_linked_step_end', 'Thanks - that is the end of the study.'],
          ]);
        });

        it('does not rewrite a keyed payload\'s ids from the stored positions', async () => {
          // The positional-preserve mitigation must not run here. Its
          // condition - equal lengths - is satisfied by a reorder, so leaving
          // it on would take the STORED id at each index and hand it to
          // whichever question the author dragged there: the original defect,
          // reintroduced by the code written to prevent it.
          mockGetStudyById.mockResolvedValueOnce(storedKeyed as never);

          await patchLinked(
            { inline_study: { ...keyedStudy, steps: [...keyedStudy.steps].reverse() } },
            true
          ).expect(200);

          const written = mockUpdateStudy.mock.calls[0][1] as {
            steps: { step_id: string }[];
          };
          expect(written.steps[0].step_id).toBe('study_already_linked_bravo');
        });

        it('lets the author delete a question that has answers', async () => {
          // Deliberate, and it is the decision migration 0015 records: the
          // deleted question's answers are DETACHED by the foreign key, not
          // destroyed and not moved onto another question. Refusing instead
          // would make a study with one answer permanently unmaintainable.
          mockStudyHasResponses.mockResolvedValue(true);
          mockGetStudyById.mockResolvedValueOnce(storedKeyed as never);

          await patchLinked(
            { inline_study: { ...keyedStudy, steps: [keyedStudy.steps[0]] } },
            true
          ).expect(200);

          const written = mockUpdateStudy.mock.calls[0][1] as {
            steps: { step_id: string }[];
          };
          expect(written.steps.map((step) => step.step_id)).toEqual([
            'study_already_linked_alpha',
            'study_already_linked_step_end',
          ]);
        });

        /**
         * What stable identity does NOT make safe, found by both review gates
         * independently and very nearly shipped.
         *
         * The refusal this step made conditional was never only about
         * ordering: `stepSequenceIsUnchanged` compared type and config too.
         * Keeping an id while changing what the question MEANS leaves every
         * stored answer attached and reinterprets it - which is a different
         * route to the same wrong number.
         */
        describe('and the question changes its meaning rather than its position', () => {
          const retyped = (steps: KeyedStep[]) => ({ ...keyedStudy, steps });

          it('refuses to change the TYPE of a question that has answers', async () => {
            // The concrete harm: 300 ratings of 1 to 5 on a question retyped to
            // `nps` are all <= 6, so the study reports an NPS of -100 over 300
            // respondents. Nothing is dangling, nothing is missing, and the
            // number is wrong.
            mockStudyHasResponses.mockResolvedValue(true);
            mockGetStudyById.mockResolvedValueOnce(storedKeyed as never);

            const response = await patchLinked({
              inline_study: retyped([
                { ...keyedStudy.steps[0], type: 'instruction' as const },
                keyedStudy.steps[1]
              ])
            }).expect(400);

            expect(response.body.error).toMatch(/type and scale cannot be changed/);
            expect(mockUpdateStudy).not.toHaveBeenCalled();
          });

          it('allows the same type change when nobody has answered', async () => {
            // The pair. Without it the refusal above is satisfied by a rule that
            // refuses every edit, which would make a draft uneditable.
            mockStudyHasResponses.mockResolvedValue(false);
            mockGetStudyById.mockResolvedValueOnce(storedKeyed as never);

            await patchLinked(
              {
                inline_study: retyped([
                  { ...keyedStudy.steps[0], type: 'instruction' as const },
                  keyedStudy.steps[1]
                ])
              },
              true
            ).expect(200);

            expect(mockUpdateStudy).toHaveBeenCalledTimes(1);
          });

          it('still lets the author REWORD a question that has answers', async () => {
            // Deliberately allowed, and it is one of the things F2 exists to
            // make possible - a live survey could not have a typo fixed at all
            // before. What makes it safe rather than silent is that the wording
            // each participant saw is recorded beside their answer and reported
            // back as `asked_as`.
            mockStudyHasResponses.mockResolvedValue(true);
            mockGetStudyById.mockResolvedValueOnce(storedKeyed as never);

            await patchLinked(
              {
                inline_study: retyped([
                  { ...keyedStudy.steps[0], prompt: 'What did you expect, exactly?' },
                  keyedStudy.steps[1]
                ])
              },
              true
            ).expect(200);

            expect(mockUpdateStudy).toHaveBeenCalledTimes(1);
          });

          it('does not refuse a type change on a question that is NEW', async () => {
            // Matched by id, not by position. A question the author just added
            // has no stored counterpart and therefore no answers to reinterpret,
            // so it must not be caught by the same rule.
            mockStudyHasResponses.mockResolvedValue(true);
            mockGetStudyById.mockResolvedValueOnce(storedKeyed as never);

            await patchLinked(
              {
                inline_study: retyped([
                  ...keyedStudy.steps,
                  {
                    step_key: 'charlie',
                    type: 'instruction' as const,
                    prompt: 'A note added just now'
                  }
                ])
              },
              true
            ).expect(200);

            expect(mockUpdateStudy).toHaveBeenCalledTimes(1);
          });
        });

        it('still refuses when only SOME of the questions carry identity', async () => {
          // A half-keyed payload is a client bug, not a state worth supporting.
          // Treating it as authoritative would let the un-keyed half fall back
          // to positional ids that can collide with the keyed half.
          //
          // The same REORDER the keyed tests above are allowed to make, so the
          // only difference between a 200 and this 400 is whether every step
          // carried identity.
          mockStudyHasResponses.mockResolvedValue(true);
          mockGetStudyById.mockResolvedValueOnce(storedKeyed as never);

          const response = await patchLinked({
            inline_study: {
              ...keyedStudy,
              steps: [
                { type: 'open_text' as const, prompt: 'What surprised you?' },
                keyedStudy.steps[0],
              ],
            },
          }).expect(400);

          expect(response.body.error).toMatch(/already collected answers/);
          expect(mockUpdateStudy).not.toHaveBeenCalled();
        });
      });

      it('does not refuse an unrelated edit just because the ids are padded', async () => {
        // The user-visible half of the same bug. stepSequenceIsUnchanged
        // compares step_id, so an unpadded payload read as "the questions
        // changed" on a save that changed none of them - and on a study with
        // answers that refused the save, naming an edit the author had not
        // made. The opportunity could then not be retitled or unpublished at
        // all.
        mockGetStudyById.mockResolvedValueOnce(
          storedWithPaddedIds(sameSequenceAsInlineStudy) as never
        );

        await patchLinked({ title: 'A new title', inline_study: inlineStudy }, true)
          .expect(200);

        expect(mockUpdateStudy).toHaveBeenCalledTimes(1);
        // Stronger than stubbing an answer and asserting the save survived it:
        // the sequence now reads as UNCHANGED, so the guard short-circuits and
        // never asks about responses at all. A queued `once` here would also
        // leak into the next test, which this file has been bitten by before.
        expect(mockStudyHasResponses).not.toHaveBeenCalled();
      });

      it('ignores the completion marker when deciding whether the questions changed', async () => {
        // toStudySteps appends the canonical END_STEP_PROMPT. A study created
        // through the studies API with its own end wording therefore read as a
        // changed sequence on EVERY save - and once it had answers, it could
        // not be edited, retitled or unpublished from the opportunity form at
        // all. No answer can attach to the marker (isAnswerable excludes it),
        // so comparing it can only ever produce a false refusal.
        mockGetStudyById.mockResolvedValueOnce({
          study: {
            id: 'study_already_linked',
            title: 'Built elsewhere',
            intro_text: 'Intro',
            consent_text: 'We record your screen.',
            kind: 'recorded',
            estimated_duration_minutes: undefined,
            status: 'launched',
            owner_user_id: 'test-user-id',
            copied_from_study_id: null,
            created_at: '2026-08-16T10:00:00.000Z',
            updated_at: '2026-08-16T10:00:00.000Z',
          },
          steps: [
            {
              step_id: 'study_already_linked_step_001',
              order: 1,
              type: 'open_text' as const,
              prompt: 'What did you expect?',
            },
            {
              step_id: 'study_already_linked_step_end',
              order: 2,
              type: 'end' as const,
              // Deliberately NOT the canonical wording.
              prompt: 'Thanks',
            },
          ],
        } as never);

        await patchLinked({ title: 'A new title', inline_study: inlineStudy }, true)
          .expect(200);

        expect(mockUpdateStudy).toHaveBeenCalledTimes(1);
        expect(mockStudyHasResponses).not.toHaveBeenCalled();
      });

      it('renumbers nothing when the author added or removed a step', async () => {
        // Positional identity only holds while the count does. A different
        // length means the author really did change the sequence, so the ids
        // must NOT be carried across - and the answers guard is then the right
        // thing to answer.
        mockGetStudyById.mockResolvedValueOnce(
          storedWithPaddedIds([
            { type: 'open_text', prompt: 'One' },
            { type: 'open_text', prompt: 'Two' },
            { type: 'open_text', prompt: 'Three' },
          ]) as never
        );

        await patchLinked({ inline_study: inlineStudy }, true).expect(200);

        const written = mockUpdateStudy.mock.calls[0][1] as {
          steps: { step_id: string }[];
        };
        expect(written.steps[0].step_id).toBe('study_already_linked_step_1');
      });

      it('does not treat trimmed whitespace as a changed question', async () => {
        // The payload trims every prompt; the stored row does not. Comparing
        // one against the other made a study whose prompts carried trailing
        // whitespace read as changed on a save that changed nothing, and once
        // it had answers every save was refused.
        mockGetStudyById.mockResolvedValueOnce(
          storedWithPaddedIds([
            { type: 'open_text', prompt: 'What did you expect?   ' },
          ]) as never
        );

        await patchLinked({ title: 'A new title', inline_study: inlineStudy }, true)
          .expect(200);

        expect(mockUpdateStudy).toHaveBeenCalledTimes(1);
        expect(mockStudyHasResponses).not.toHaveBeenCalled();
      });

      it('clears a duration the author emptied', async () => {
        // null and absent mean different things, and the form now sends null
        // when the author empties a field that had a value. Without this a
        // duration could be set on the opportunity form and never unset - the
        // field's own help text offers exactly that.
        await patchLinked(
          { inline_study: { ...inlineStudy, estimated_duration_minutes: null } },
          true
        ).expect(200);

        expect(
          (mockUpdateStudy.mock.calls[0][1] as { estimated_duration_minutes?: number | null })
            .estimated_duration_minutes
        ).toBeNull();
      });

      it('leaves a duration the request did not mention', async () => {
        // The other half of the same decision: a save that says nothing about
        // duration must not erase an estimate set by hand in StudyEditor.
        await patchLinked({ inline_study: inlineStudy }, true).expect(200);

        expect(
          mockUpdateStudy.mock.calls[0][1] as Record<string, unknown>
        ).not.toHaveProperty('estimated_duration_minutes');
      });

      it('asks whether the study is shared, excluding this opportunity itself', async () => {
        // The mock cannot tell a correct query from a wrong one - it returns
        // whatever was queued - so the refusal test above passes just as
        // happily against a query with no `id <> $2`. That version matches the
        // opportunity's OWN row, so every in-place save would be refused as
        // shared. This is the only assertion that can catch it.
        await patchLinked({ inline_study: inlineStudy }, true).expect(200);

        const sharedCheck = (mockQuery.mock.calls as unknown as [string, unknown[]][]).find(
          ([sql]) => typeof sql === 'string' && sql.includes('SELECT 1 FROM opportunities')
        );

        expect(sharedCheck).toBeDefined();
        // Asserted as a literal rather than against the module's own string,
        // which would move with it.
        expect(sharedCheck![0].replace(/\s+/g, ' ').trim()).toBe(
          'SELECT 1 FROM opportunities WHERE firsthand_study_id = $1 AND id <> $2 LIMIT 1'
        );
        // Positional: both values appear either way, so a swap is only visible
        // by index.
        expect(sharedCheck![1][0]).toBe('study_already_linked');
        expect(sharedCheck![1][1]).toBe('1');
      });

      it('refuses to rewrite a task list another opportunity also uses', async () => {
        // Ownership is not the question - the author may well own it. The
        // question is what this surface implies: an author editing THIS
        // opportunity would silently change what a colleague's live
        // opportunity serves its participants.
        const response = await patchLinked({ inline_study: inlineStudy }, false, true)
          .expect(400);

        expect(response.body.error).toMatch(/also used by another study/);
        expect(mockUpdateStudy).not.toHaveBeenCalled();
        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('never deletes the study it updated in place', async () => {
        // The compensating delete exists to remove a study nothing ever
        // referenced. On the in-place path the study is the researcher's live
        // one, and deleting it would take its steps with it. Nothing else in
        // this suite reaches the catch block with updatedStudyInPlace true, so
        // without this a refactor that widened the guard to the linked id
        // would destroy a live study and every test would still pass.
        mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
        mockQuery.mockResolvedValueOnce({
          rows: [existingUnmoderated('study_already_linked')]
        });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // Deleted between the ownership check and the write.
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await request(listening(app))
          .patch('/api/opportunities/1')
          .send({ title: 'A new title', inline_study: inlineStudy })
          .expect(404);

        expect(mockUpdateStudy).toHaveBeenCalledTimes(1);
        expect(mockDeleteStudyUnchecked).not.toHaveBeenCalled();
      });

      it('leaves a duration the request said nothing about alone', async () => {
        // resolveStudyDuration(undefined) is null and updateStudy writes any
        // key that is present, so passing it unconditionally erased an
        // estimate set by hand in StudyEditor - the same silent loss the
        // docblock refuses for title and intro_text.
        await patchLinked({ inline_study: inlineStudy }, true).expect(200);

        expect(mockUpdateStudy.mock.calls[0][1]).not.toHaveProperty(
          'estimated_duration_minutes'
        );
      });

      it('writes a duration the request did give', async () => {
        // The pair matters: asserting only the omission above passes just as
        // happily against a branch that never sends a duration at all.
        await patchLinked(
          { inline_study: { ...inlineStudy, estimated_duration_minutes: 12 } },
          true
        ).expect(200);

        expect(mockUpdateStudy.mock.calls[0][1]).toHaveProperty(
          'estimated_duration_minutes',
          12
        );
      });

      it('refuses to rewrite a task list belonging to another researcher', async () => {
        mockUpdateStudy.mockResolvedValueOnce({ ok: false, reason: 'forbidden' } as never);

        const response = await patchLinked({ inline_study: inlineStudy }).expect(403);

        expect(response.body.error).toMatch(/belongs to another researcher/);
        // The refusal is not the dangerous half. Falling back to a mint here
        // would repoint the opportunity away from a colleague's study, which
        // is the outcome the old blanket refusal existed to prevent.
        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      /**
       * Second finding from the same review: `stepSequenceIsUnchanged` and
       * `studyHasResponses` used to run BEFORE the ownership check inside
       * updateStudy's own transaction, so a 400 ("already collected answers")
       * versus updateStudy's 403 disclosed whether a study this caller
       * cannot write had already collected responses - to a caller never
       * granted read access to that fact. FIX 1 only closes this for a
       * NEWLY set link; this is the case it does not reach: an opportunity
       * ALREADY linked (from before this fix, or to a study a colleague
       * later claimed by editing it directly in StudyEditor) to a study this
       * caller cannot write.
       */
      it('refuses ownership before probing whether the study has already collected answers', async () => {
        mockGetStudyById.mockResolvedValueOnce({
          study: {
            id: 'study_already_linked',
            title: 'A study',
            intro_text: 'Intro',
            consent_text: 'Consent',
            kind: 'recorded',
            estimated_duration_minutes: undefined,
            status: 'launched',
            owner_user_id: 'someone-else',
            copied_from_study_id: null,
            created_at: '2026-08-16T10:00:00.000Z',
            updated_at: '2026-08-16T10:00:00.000Z',
          },
          // Fewer steps than inlineStudy carries, so stepSequenceIsUnchanged
          // would read as CHANGED and (pre-fix) reach studyHasResponses.
          steps: [],
        } as never);

        const response = await patchLinked({ inline_study: inlineStudy }).expect(403);

        expect(response.body.error).toMatch(/belongs to another researcher/);
        expect(mockStudyHasResponses).not.toHaveBeenCalled();
        expect(mockUpdateStudy).not.toHaveBeenCalled();
      });

      it('refuses a task list whose linked study holds the other vocabulary', async () => {
        mockGetStudyById.mockResolvedValueOnce({
          study: {
            id: 'study_already_linked',
            title: 'A survey',
            intro_text: 'Intro',
            consent_text: 'Consent',
            kind: 'survey',
            estimated_duration_minutes: undefined,
            status: 'launched',
            owner_user_id: 'test-user-id',
            copied_from_study_id: null,
            created_at: '2026-08-16T10:00:00.000Z',
            updated_at: '2026-08-16T10:00:00.000Z',
          },
          steps: [],
        } as never);

        const response = await patchLinked({ inline_study: inlineStudy }).expect(400);

        expect(response.body.error).toBe(STUDY_KIND_MISMATCH.recorded);
        // Refused BEFORE the write, so updateStudy's own vocabulary guard -
        // which throws a raw Error this route answers as a 500 - is never the
        // thing the author sees.
        expect(mockUpdateStudy).not.toHaveBeenCalled();
        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('mints a study when the link points at one that no longer exists', async () => {
        // A dangling link protects nothing and orphans nothing, so authoring
        // repairs it rather than being refused. Without this the opportunity
        // stays permanently unfixable from the form.
        mockGetStudyById.mockResolvedValueOnce(null as never);
        mockCreateStudy.mockResolvedValueOnce({
          study: { id: 'study_replacement' },
          steps: []
        } as never);

        await patchLinked({ inline_study: inlineStudy }, true).expect(200);

        expect(mockUpdateStudy).not.toHaveBeenCalled();
        expect(mockCreateStudy).toHaveBeenCalledTimes(1);
        expect(opportunityWrite()[1]).toContain('study_replacement');
      });

      /**
       * FIX 5. The test above never actually reached the bug: it sends only
       * `inline_study`, and the real form ALSO resends `type` on every save.
       * `changesLinkage` is true whenever `data.type !== undefined`, so a
       * dangling-link repair with `type` in the body used to route through the
       * pre-check meant for a NEW `firsthand_study_id` on the request -
       * resolving the STORED (missing) id instead and refusing with "That
       * task list could not be found" before `updateLinkedStudyContent` below
       * ever got to answer 'missing' and mint the repair. Reproduced against
       * the running local server, traced to
       * `assertLinkedStudyKindMatches` (opportunities.ts:203).
       */
      it('repairs a dangling link even when the request resends its own type', async () => {
        mockGetStudyById.mockResolvedValueOnce(null as never);
        mockCreateStudy.mockResolvedValueOnce({
          study: { id: 'study_replacement' },
          steps: []
        } as never);

        await patchLinked(
          { type: 'unmoderated', inline_study: inlineStudy },
          true
        ).expect(200);

        expect(mockUpdateStudy).not.toHaveBeenCalled();
        expect(mockCreateStudy).toHaveBeenCalledTimes(1);
        expect(opportunityWrite()[1]).toContain('study_replacement');
      });

      it('mints a study when the linked one is deleted mid-request', async () => {
        // Between getStudyById and updateStudy's FOR UPDATE lock. Same answer
        // as never having existed - the alternative is a 403 or a 500 naming a
        // study the caller can no longer see.
        mockUpdateStudy.mockResolvedValueOnce({ ok: false, reason: 'not_found' } as never);
        mockCreateStudy.mockResolvedValueOnce({
          study: { id: 'study_replacement' },
          steps: []
        } as never);

        await patchLinked({ inline_study: inlineStudy }, true).expect(200);

        expect(mockCreateStudy).toHaveBeenCalledTimes(1);
      });
    });

    it('refuses authored tasks alongside an explicit link, including a null one', async () => {
      // firsthand_study_id is nullable on the update schema, and null?.trim()
      // is undefined - so a truthiness check let a caller clear the link and
      // author into the study it pointed at in one request, leaving that study
      // rewritten AND unreferenced. The blanket refusal on the stored link used
      // to cover this; nothing else did, so the guard now tests for `undefined`.
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [existingUnmoderated('study_already_linked')]
      });

      const response = await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ firsthand_study_id: null, inline_study: inlineStudy })
        .expect(400);

      expect(response.body.error).toBe(
        'Send either firsthand_study_id or inline_study, not both'
      );
      expect(mockCreateStudy).not.toHaveBeenCalled();
      expect(mockUpdateStudy).not.toHaveBeenCalled();
    });

    it('removes the created study when the opportunity vanished mid-update', async () => {
      mockCreateStudy.mockResolvedValueOnce({
        study: { id: 'study_raced' },
        steps: []
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated(null)] });
      // Deleted between the ownership check and the write: the UPDATE succeeds
      // but matches nothing.
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ inline_study: inlineStudy })
        .expect(404);

      expect(mockDeleteStudyUnchecked).toHaveBeenCalledWith('study_raced');
    });

    it('will not let a published unmoderated opportunity have its study cleared', async () => {
      // The guard used to fire only when the request itself set status, so
      // clearing the link on an already-published opportunity left it live with
      // no study - the very state the guard exists to prevent.
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [existingUnmoderated('study_live', 'published')]
      });

      const response = await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ firsthand_study_id: null })
        .expect(400);

      // Names what this caller is actually doing - they are removing a study,
      // not failing to publish one.
      expect(response.body.error).toBe(
        'A published unmoderated test cannot have its task list removed; unpublish it first'
      );
    });

    it('answers 404, not 500, when the opportunity vanishes before the type read', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      // Deleted between the ownership check and the existing-row lookup: the
      // row access used to throw a TypeError straight into the 500 branch.
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ title: 'A perfectly fine new title' })
        .expect(404);
    });

    it('still allows an unrelated edit to a legacy published row with no study', async () => {
      // The guard must not lock rows ALREADY in the bad state, or the
      // documented remediation for a legacy unmoderated+external row - which
      // reset-demo-data.ts seeds - becomes impossible to apply.
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            ...existingUnmoderated(null, 'published'),
            participant_type_required: 'external'
          }
        ]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
        rowCount: 1
      });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ participant_type_required: 'any' })
        .expect(200);
    });

    /*
     * The update guard reads the RESULTING state - the request merged over the
     * stored row - and until these three tests nothing proved it.
     *
     * Every other PATCH publish test resends the field the guard reads, so
     * "merged over the stored row" and "read straight off the request" were
     * indistinguishable. An independent mutation pass made the guard read the
     * request's own `external_link_optional` and its own `delivery_mode`, and
     * all 234 route tests stayed green - while both mutants falsely REFUSE a
     * bare publish of a row that is already complete.
     */
    it('publishes an external poll on its STORED link, without being resent one', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            ...existingUnmoderated(null, 'draft'),
            type: 'poll',
            delivery_mode: 'external',
            external_link_optional: 'https://example.com/already-stored'
          }
        ]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
        rowCount: 1
      });

      // Only the status. The link is never mentioned.
      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ status: 'published' })
        .expect(200);
    });

    it('publishes a native survey on its STORED delivery mode and study', async () => {
      // The twin: a guard reading the request's own delivery_mode sees
      // undefined, falls through to the external branch, and demands a link
      // that a native survey is never going to have.
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            ...existingUnmoderated('study_stored', 'draft'),
            type: 'survey',
            delivery_mode: 'native',
            external_link_optional: null
          }
        ]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
        rowCount: 1
      });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ status: 'published' })
        .expect(200);
    });

    it('treats an all-whitespace study id as no study at all', async () => {
      /*
       * The create guard has this test and the update guard did not, though
       * both carry the same comment about it. An untrimmed id satisfies the
       * check and then stores NULL, which is a published unmoderated test with
       * no task list - exactly the state the guard exists to refuse.
       */
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [existingUnmoderated('study_live', 'published')]
      });

      const response = await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ firsthand_study_id: '   ' })
        .expect(400);

      // The REMOVAL wording, because that is what taking the study away is.
      expect(response.body.error).toBe(
        'A published unmoderated test cannot have its task list removed; unpublish it first'
      );
    });

    it('will not turn a published opportunity into a poll with no link', async () => {
      // The matched half of the unmoderated guard: gating on the request's own
      // status let a type flip on an already-published row through, producing a
      // published poll whose call to action goes nowhere.
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            ...existingUnmoderated('study_live', 'published'),
            external_link_optional: null
          }
        ]
      });

      const response = await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ type: 'poll' })
        .expect(400);

      expect(response.body.error).toBe(
        'External link is required for published polls, surveys and one-question studies'
      );
    });

    /**
     * The update half of the native-or-external choice. Evaluated against the
     * state the request LEAVES BEHIND, like every other branch of this guard,
     * so flipping an already-published survey to native without questions is
     * refused rather than producing a live survey that asks nothing.
     */
    it('refuses to switch a published survey to native with no questions linked', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            type: 'survey',
            title: 'A survey',
            purpose_one_liner: 'Purpose',
            status: 'published',
            external_link_optional: 'https://example.com/form',
            firsthand_study_id: null,
            participant_type_required: 'any',
            delivery_mode: 'external'
          }
        ]
      });

      const response = await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ delivery_mode: 'native' })
        .expect(400);

      expect(response.body.error).toBe(NATIVE_SURVEY_STUDY_REQUIRED);
    });

    it('does not demand an external link once a survey is delivered natively', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            type: 'survey',
            title: 'A survey',
            purpose_one_liner: 'Purpose',
            status: 'published',
            external_link_optional: null,
            firsthand_study_id: 'study_questions',
            participant_type_required: 'any',
            delivery_mode: 'external'
          }
        ]
      });
      mockGetStudyById.mockResolvedValueOnce({
        study: {
          id: 'study_questions',
          title: 'Questions',
          intro_text: 'Intro',
          consent_text: 'Consent',
          status: 'launched' as const,
          kind: 'survey' as const,
          owner_user_id: 'test-user-id',
          copied_from_study_id: null,
          created_at: '2026-08-17T10:00:00.000Z',
          updated_at: '2026-08-17T10:00:00.000Z',
        },
        steps: []
      });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: '1',
            type: 'survey',
            delivery_mode: 'native',
            created_at: new Date(),
            updated_at: new Date()
          }
        ],
        rowCount: 1
      });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ delivery_mode: 'native' })
        .expect(200);
    });

    /**
     * The switch itself must not be a way past the linkage check: an external
     * survey could hold a recorded task list from some earlier edit, and going
     * native would then serve survey participants a task list.
     */
    /**
     * A row already in a bad state must stay repairable. Unconditionally, the
     * linkage check refused a title edit, refused unpublishing - so the
     * misleading live page could not even be taken down - and answered each one
     * with a message about question types the caller had not touched. DELETE
     * was the only way out, which loses the opportunity and its analytics.
     */
    it('lets an unrelated edit through on a row whose study does not match', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            type: 'survey',
            title: 'A survey',
            purpose_one_liner: 'Purpose',
            status: 'published',
            external_link_optional: null,
            firsthand_study_id: 'study_tasks',
            participant_type_required: 'any',
            delivery_mode: 'native'
          }
        ]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
        rowCount: 1
      });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ title: 'A slightly better survey title' })
        .expect(200);
    });

    it('lets a mismatched row be unpublished so the page can be taken down', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            type: 'survey',
            title: 'A survey',
            purpose_one_liner: 'Purpose',
            status: 'published',
            external_link_optional: null,
            firsthand_study_id: 'study_tasks',
            participant_type_required: 'any',
            delivery_mode: 'native'
          }
        ]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
        rowCount: 1
      });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ status: 'draft' })
        .expect(200);
    });

    it('refuses to go native while holding a recorded task list', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            type: 'survey',
            title: 'A survey',
            purpose_one_liner: 'Purpose',
            status: 'published',
            external_link_optional: null,
            firsthand_study_id: 'study_tasks',
            participant_type_required: 'any',
            delivery_mode: 'external'
          }
        ]
      });
      mockGetStudyById.mockResolvedValueOnce({
        study: {
          id: 'study_tasks',
          title: 'Task list',
          intro_text: 'Intro',
          consent_text: 'Consent',
          status: 'launched' as const,
          kind: 'recorded' as const,
          owner_user_id: 'test-user-id',
          copied_from_study_id: null,
          created_at: '2026-08-17T10:00:00.000Z',
          updated_at: '2026-08-17T10:00:00.000Z',
        },
        steps: []
      });

      const response = await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ delivery_mode: 'native' })
        .expect(400);

      expect(response.body.error).toMatch(/needs a set of survey questions/);
    });

    it('says "not both" rather than "already has one" when neither is stored', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated(null)] });

      const response = await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ firsthand_study_id: 'study_x', inline_study: inlineStudy })
        .expect(400);

      expect(response.body.error).toBe(
        'Send either firsthand_study_id or inline_study, not both'
      );
    });

    it('stores null, not an empty string, when the link is cleared', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...existingUnmoderated('study_old'), status: 'draft' }]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
        rowCount: 1
      });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ firsthand_study_id: '   ' })
        .expect(200);

      // Asserted against the parameter the SQL actually binds firsthand_study_id
      // to, not merely "a null exists somewhere in the values array" - which
      // would pass even if the null landed on the wrong column.
      const [sql, boundValues] = mockQuery.mock.calls[2];
      const assignments = String(sql).match(/SET ([^]*?)\s+WHERE/)![1].split(',').map(a => a.trim());
      const index = assignments.findIndex(a => a.startsWith('firsthand_study_id ='));
      expect(index).toBeGreaterThanOrEqual(0);
      // Create normalises the same input to NULL; two representations of "no
      // study" would defeat any later IS NOT NULL predicate.
      expect(boundValues[index]).toBeNull();
    });

    it('answers 503 when the studies pool is not configured', async () => {
      mockIsStudiesPersistenceConfigured.mockReturnValueOnce(false);
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated(null)] });

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ inline_study: inlineStudy })
        .expect(503);

      expect(mockCreateStudy).not.toHaveBeenCalled();
    });

    it('deletes the study it created when the update fails', async () => {
      mockCreateStudy.mockResolvedValueOnce({
        study: { id: 'study_orphan_patch' },
        steps: []
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated(null)] });
      mockQuery.mockRejectedValueOnce(new Error('update exploded'));

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ inline_study: inlineStudy })
        .expect(500);

      expect(mockDeleteStudyUnchecked).toHaveBeenCalledWith('study_orphan_patch');
    });

    it('still blocks publishing an unmoderated opportunity with neither route', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated(null)] });

      const response = await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ status: 'published' })
        .expect(400);

      expect(response.body.error).toBe(
        'Add at least one prompt to the task list, or link an existing task list, before publishing'
      );
    });

    /**
     * FIX 1 (security review, B3): a PATCH could still repoint
     * `firsthand_study_id` at a colleague's study - the exact shared-link
     * state B3's copy-on-select exists to remove - because the only
     * server-side check was kind-and-existence, never ownership.
     */
    describe('changing the linked study id respects ownership (FIX 1)', () => {
      const colleaguesStudy = (ownerUserId: string | null) => ({
        study: {
          id: 'study_colleagues',
          title: 'A task list',
          intro_text: 'Intro',
          consent_text: 'Consent',
          status: 'launched' as const,
          kind: 'recorded' as const,
          owner_user_id: ownerUserId,
          copied_from_study_id: null,
          created_at: '2026-08-17T10:00:00.000Z',
          updated_at: '2026-08-17T10:00:00.000Z',
        },
        steps: []
      });

      it('refuses to change the link to a study owned by another researcher', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
        mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated('study_mine')] });
        mockGetStudyById.mockResolvedValueOnce(colleaguesStudy('someone-else'));

        const response = await request(listening(app))
          .patch('/api/opportunities/1')
          .send({ firsthand_study_id: 'study_colleagues' })
          .expect(403);

        expect(response.body.error).toMatch(/belongs to another researcher/);
      });

      /**
       * The regression FIX 1 must not cause. The opportunity form legitimately
       * resends the SAME `firsthand_study_id` on every save while its author
       * edits an unrelated field, even when the linked study belongs to
       * someone else - reusing a colleague's study (pre-B3) or an unowned one
       * a colleague later claimed are both still-valid states to be linked to.
       * Written first, per the brief, as the regression this fix must not
       * cause.
       */
      it('still saves an unrelated edit while re-sending the same not-yours study id', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
        mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated('study_colleagues')] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
          rowCount: 1
        });
        mockGetStudyById.mockResolvedValueOnce(colleaguesStudy('someone-else'));

        await request(listening(app))
          .patch('/api/opportunities/1')
          .send({ title: 'A retitled opportunity', firsthand_study_id: 'study_colleagues' })
          .expect(200);
      });

      it('still clears the link to a study you do not own', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
        mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated('study_colleagues')] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
          rowCount: 1
        });

        await request(listening(app))
          .patch('/api/opportunities/1')
          .send({ firsthand_study_id: null })
          .expect(200);

        // Clearing never has a positive id to check the kind or ownership of.
        expect(mockGetStudyById).not.toHaveBeenCalled();
      });
    });

    /**
     * FIX 5: the missing-study pre-check must stay exactly as strict for the
     * case it was written for - LINKING to an id that does not exist - even
     * though authoring inline content now skips it. See the two
     * "repairs a dangling link" tests above for the case that changed.
     */
    describe('the missing-study refusal stays exact for an actual link (FIX 5)', () => {
      it('still refuses to link an id that does not exist', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
        mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated('study_mine')] });
        mockGetStudyById.mockResolvedValueOnce(null as never);

        const response = await request(listening(app))
          .patch('/api/opportunities/1')
          .send({ firsthand_study_id: 'study_does_not_exist' })
          .expect(400);

        expect(response.body.error).toBe('That task list could not be found');
      });

      it('still allows retitling an opportunity whose linked study has gone missing', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
        mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated('study_missing')] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: '1', created_at: new Date(), updated_at: new Date() }],
          rowCount: 1
        });

        await request(listening(app))
          .patch('/api/opportunities/1')
          .send({ title: 'A retitled opportunity' })
          .expect(200);

        // No content and no id change: changesLinkage never triggers on a bare
        // title edit, so the pre-check was never reached even before FIX 5 -
        // the point is that it stays that way.
        expect(mockGetStudyById).not.toHaveBeenCalled();
      });
    });
  });

  describe('PATCH /api/opportunities/:id', () => {
    it('should update an opportunity', async () => {
      const updatedOpportunity = {
        id: '1',
        type: 'test',
        title: 'Updated Title',
        purpose_one_liner: 'Updated purpose',
        default_duration_minutes: 60,
        status: 'published',
        owner_user_id: 'test-user-id',
        created_at: new Date(),
        updated_at: new Date()
      };

      // 1. Ownership check
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'test-user-id' }]
      });

      // 2. Existing-opportunity lookup (type/link/firsthand_study_id/participant_type_required)
      //    used to decide whether the published-link and participant-type rules apply
      mockQuery.mockResolvedValueOnce({
        rows: [{ type: 'test', external_link_optional: null, firsthand_study_id: null, participant_type_required: 'any' }]
      });

      // 3. Bookable-slot count (#118): a published `test`/`interview` is refused
      //    with no upcoming slot, so this generic "a normal publish succeeds"
      //    case supplies one. The gate reads `rowCount`, not the rows.
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });

      // 4. The actual UPDATE ... RETURNING *
      mockQuery.mockResolvedValueOnce({ rows: [updatedOpportunity] });

      const response = await request(listening(app))
        .patch('/api/opportunities/1')
        .send({
          title: 'Updated Title',
          status: 'published'
        })
        .expect(200);

      expect(response.body).toMatchObject({
        id: '1',
        title: 'Updated Title',
        status: 'published',
        sessions: []
      });
    });

    /*
     * The slot gate at the ROUTE (#118), not only against `findPublishProblem`.
     * The predicate being right proves nothing about whether this endpoint asks
     * it, or whether it supplies the count from the participant-actionable
     * `end_time > NOW()` set. A direct `PATCH { status: 'published' }` on a
     * slotless live session is exactly the hole the wizard's client gate could
     * not close - the whole reason this issue was an M.
     */
    it('refuses to publish a live session with no upcoming slot (#118)', async () => {
      // 1. Ownership check
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      // 2. Existing-opportunity lookup - a moderated (test) row
      mockQuery.mockResolvedValueOnce({
        rows: [{ type: 'test', external_link_optional: null, firsthand_study_id: null, participant_type_required: 'any' }]
      });
      // 3. Bookable-slot count returns none: nothing upcoming to book.
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ status: 'published' })
        .expect(400);

      expect(response.body.error).toBe(
        'Add at least one upcoming time slot before publishing a live session or interview'
      );
      // The refusal short-circuits BEFORE the UPDATE write: ownership, existing
      // lookup and slot count ran, and nothing else. If a later edit adds a
      // query ahead of the gate, this count moves and says so by name.
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    it('permits publishing a live session once an upcoming slot exists (#118)', async () => {
      const updated = {
        id: '1', type: 'test', title: 'Live Session', status: 'published',
        owner_user_id: 'test-user-id', created_at: new Date(), updated_at: new Date()
      };
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] }); // ownership
      mockQuery.mockResolvedValueOnce({
        rows: [{ type: 'test', external_link_optional: null, firsthand_study_id: null, participant_type_required: 'any' }]
      }); // existing
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 }); // one upcoming slot
      mockQuery.mockResolvedValueOnce({ rows: [updated] }); // UPDATE ... RETURNING *

      await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ status: 'published' })
        .expect(200);
    });

    it('should reject flipping an unmoderated opportunity to an external participant type (M2)', async () => {
      // 1. Ownership check
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'test-user-id' }]
      });
      // 2. Existing-opportunity lookup: an unmoderated opp currently using an
      //    internal-friendly participant type
      mockQuery.mockResolvedValueOnce({
        rows: [{ type: 'unmoderated', external_link_optional: null, firsthand_study_id: 'study_abc123', participant_type_required: 'any' }]
      });

      const response = await request(listening(app))
        .patch('/api/opportunities/1')
        .send({ participant_type_required: 'external' })
        .expect(400);

      expect(response.body.error).toBe(
        'Unmoderated studies cannot use an external participant type; participants must be logged-in Cortex users'
      );
    });

    it('should check ownership', async () => {
      // Mock ownership check - different owner
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'different-user-id' }]
      });

      const response = await request(listening(app))
        .patch('/api/opportunities/1')
        .send({
          title: 'Updated Title'
        })
        .expect(403);

      expect(response.body.error).toBe('Only the owner can edit this study');
    });
  });

  describe('POST /api/opportunities/:id/sessions - the location field', () => {
    /*
     * The same defect class as the external-link guard, one field over, found by
     * the security gate on that fix.
     *
     * `location_or_meet_link_optional` had NO validation, and `MyBookings`
     * decided whether to render it as an `href` with a substring test -
     * `str.includes('meet.google.com')` - so the `//` in
     * `javascript:alert(document.cookie)//meet.google.com` turned the
     * allowlisted host into a JavaScript comment and the value rendered as a
     * link labelled "Join via Google Meet". Set once by a researcher; seen by
     * every participant who booked that session.
     *
     * Its own describe rather than appended to a neighbour: my first attempt put
     * these inside `database outage propagation`, whose `beforeEach` makes the
     * database unavailable, so they failed for a reason that had nothing to do
     * with the schema - and leaked mocks into four earlier tests.
     */
    it.each([
      ['javascript:alert(document.cookie)//meet.google.com'],
      ['javascript:alert(1)/*teams.microsoft.com*/'],
      ['data:text/html,<script>alert(1)</script>#meet.google.com'],
      ['vbscript:msgbox(1)']
    ])('refuses an executable location: %s', async (location) => {
      // The route looks the opportunity up BEFORE it validates, so without this
      // the request 404s and the assertion below passes for the wrong reason -
      // which is exactly what my first version of this test did.
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });

      const response = await request(listening(app))
        .post('/api/opportunities/1/sessions')
        .send([
          {
            start_time: '2030-08-01T10:00:00Z',
            end_time: '2030-08-01T11:00:00Z',
            capacity: 1,
            location_or_meet_link_optional: location
          }
        ]);

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain(MEETING_LOCATION_SCHEME_MESSAGE);
    });

    it.each([
      ['a plain room, which is the common case', 'Room 3B'],
      ['a note rather than a link', 'Zoom, see the calendar invite'],
      ['a real joining link', 'https://meet.google.com/abc-defg-hij']
    ])('does not let validation refuse %s', async (_why, location) => {
      /*
       * Without these three the four refusals above would pass against a schema
       * that rejected every location, which would break every booking in a
       * physical room. Asserted as "not 400" rather than as a success, because
       * what is being pinned here is the validator's verdict, not the rest of
       * the route. The existence lookup is mocked for the same reason as above:
       * a 404 is also "not 400".
       */
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });

      const response = await request(listening(app))
        .post('/api/opportunities/1/sessions')
        .send([
          {
            start_time: '2030-08-01T10:00:00Z',
            end_time: '2030-08-01T11:00:00Z',
            capacity: 1,
            location_or_meet_link_optional: location
          }
        ]);

      expect(response.status).not.toBe(400);
      // And specifically not 404 either, so this really did reach validation.
      expect(response.status).not.toBe(404);
    });
  });

  describe('DELETE /api/opportunities/:id', () => {
    it('should delete an opportunity', async () => {
      // Mock ownership check
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'test-user-id' }]
      });

      // Mock delete query
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(listening(app))
        .delete('/api/opportunities/1')
        .expect(204);
    });

    it('should check ownership before delete', async () => {
      // Mock ownership check - different owner
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'different-user-id' }]
      });

      const response = await request(listening(app))
        .delete('/api/opportunities/1')
        .expect(403);

      expect(response.body.error).toBe('Only the owner can delete this study');
    });
  });

  describe('POST /api/opportunities/:id/duplicate', () => {
    it('should duplicate an opportunity', async () => {
      const originalOpportunity = {
        id: '1',
        type: 'test',
        title: 'Original Title',
        purpose_one_liner: 'Original purpose',
        description_optional: 'Original description',
        product_optional: 'Original product',
        default_duration_minutes: 30,
        external_link_optional: null
      };

      const duplicatedOpportunity = {
        id: '2',
        type: 'test',
        title: 'Original Title (copy)',
        purpose_one_liner: 'Original purpose',
        description_optional: 'Original description',
        product_optional: 'Original product',
        default_duration_minutes: 30,
        status: 'draft',
        owner_user_id: 'test-user-id',
        external_link_optional: null,
        created_at: new Date(),
        updated_at: new Date()
      };

      // Mock ownership check
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'test-user-id' }]
      });

      // Mock get original opportunity
      mockQuery.mockResolvedValueOnce({ rows: [originalOpportunity] });

      // Mock duplicate creation
      mockQuery.mockResolvedValueOnce({ rows: [duplicatedOpportunity] });

      const response = await request(listening(app))
        .post('/api/opportunities/1/duplicate')
        .expect(201);

      expect(response.body).toMatchObject({
        id: '2',
        title: 'Original Title (copy)',
        status: 'draft',
        sessions: []
      });
    });

    it('should check ownership before duplicating', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'different-user-id' }]
      });

      const response = await request(listening(app))
        .post('/api/opportunities/1/duplicate')
        .expect(403);

      expect(response.body.error).toBe('Only the owner can duplicate this study');
    });
  });

  describe('POST /api/opportunities/:id/close-if-past', () => {
    it('should close the opportunity once all sessions are past', async () => {
      // Ownership check
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'test-user-id' }]
      });

      // autoCloseOpportunityIfNeeded's session/status lookup
      mockQuery.mockResolvedValueOnce({
        rows: [{ total_sessions: '2', past_sessions: '2', status: 'published' }]
      });

      // autoCloseOpportunityIfNeeded's UPDATE
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(listening(app))
        .post('/api/opportunities/1/close-if-past')
        .expect(200);

      expect(response.body).toEqual({ message: 'Study auto-close check completed' });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE opportunities'),
        ['closed', '1']
      );
    });

    it('should check ownership before closing', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'different-user-id' }]
      });

      const response = await request(listening(app))
        .post('/api/opportunities/1/close-if-past')
        .expect(403);

      expect(response.body.error).toBe('Only the owner can close this study');
    });
  });

  // An app with NO session stub - requests arrive unauthenticated, like a
  // logged-out browser. Regression guard for the bug where these routes
  // checked req.user but no middleware ever populated it, so even
  // authenticated users got 401s.
  const unauthenticatedApp = express();
  unauthenticatedApp.use(express.json());
  unauthenticatedApp.use((req: any, res, next) => {
    req.session = {};
    next();
  });
  unauthenticatedApp.use('/api/opportunities', opportunitiesRouter);
  unauthenticatedApp.use(errorHandler);

  // The completion trace is attached only inside `req.user ? ...` on both the
  // list and the detail read. The signed-in cases live in the row-10 describe
  // above; these cover the signed-out branch, so a future refactor to
  // `req.user?.id` - which would key the query on `undefined` rather than skip
  // it - fails red here rather than quietly running an unscoped read for a
  // logged-out caller. (#119)
  describe('participant completion trace when signed out (audit row 10 / #119)', () => {
    const anonNativeSurveyRow = {
      id: 'op-anon',
      type: 'survey',
      delivery_mode: 'native',
      title: 'How was it',
      purpose_one_liner: 'A quick survey',
      default_duration_minutes: 30,
      status: 'published',
      owner_user_id: 'someone-else',
      firsthand_study_id: 'study-anon',
      external_link_optional: null,
      created_at: new Date('2026-09-01T10:00:00.000Z'),
      updated_at: new Date('2026-09-01T10:00:00.000Z'),
      start_date: null,
      end_date: null,
      owner_name: 'Owner',
      owner_email: 'owner@example.com'
    };

    it('attaches no completion to a native survey detail read for a signed-out caller, and never reaches the runtime', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [anonNativeSurveyRow] });

      const response = await request(listening(unauthenticatedApp))
        .get('/api/opportunities/op-anon')
        .expect(200);

      // A logged-out caller has no participant identity to scope the read to, so
      // the trace must be absent - not `{ completed: false }`, which would claim
      // the read ran and found nothing.
      expect(response.body.completion).toBeUndefined();
      expect(mockFindParticipantCompletions).not.toHaveBeenCalled();
    });

    it('never reaches the runtime for the listing when signed out, so the trace is only the un-read default', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [anonNativeSurveyRow] });

      const response = await request(listening(unauthenticatedApp))
        .get('/api/opportunities')
        .expect(200);

      const survey = response.body.find((o: { id: string }) => o.id === 'op-anon');
      expect(survey).toBeDefined();
      // The listing attaches the not-completed default to every native survey
      // (an empty-map miss), signed in or out - so `completion` being present
      // here is not a leak. The invariant that matters, and the one a
      // `req.user?.id` refactor would break, is that no participant-scoped read
      // was issued for a caller with no identity: the completion can only ever
      // be the default, never a real row.
      expect(survey.completion).toEqual({ completed: false, completedAt: null });
      expect(mockFindParticipantCompletions).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/opportunities/:id/recorded-study-session', () => {
    it('mints an in-process session and returns a same-origin URL', async () => {
      process.env.FRONTEND_URL = 'https://cortex.example.com';
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', type: 'unmoderated', firsthand_study_id: 'study_abc123', status: 'published' }]
      });
      mockCreateSession.mockResolvedValueOnce({
        ok: true,
        session: { session_id: 'session_x', session_token: 'fh_tok', expires_at: '2026-07-22T00:00:00.000Z' }
      });

      const response = await request(listening(app))
        .post('/api/opportunities/1/recorded-study-session')
        .expect(200);

      expect(response.body.session_url).toBe('https://cortex.example.com/session/fh_tok');
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        studyId: 'study_abc123',
        participant: expect.objectContaining({ participant_id: 'test-user-id', external_ref: '1' })
      }));
    });

    it('should reject an unauthenticated request with 401', async () => {
      const response = await request(listening(unauthenticatedApp))
        .post('/api/opportunities/1/recorded-study-session')
        .expect(401);

      expect(response.body.error).toBe('Authentication required');
    });

    /**
     * The guard the sibling brief route always had and this one never did.
     * Minting here starts a RECORDED session - a consent screen promising
     * screen and microphone capture - so it must be reachable only from the one
     * type that actually records. A native survey is served by its own route.
     */
    it('refuses to mint a recorded session for a native survey', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: '1',
          type: 'survey',
          firsthand_study_id: 'study_questions',
          status: 'published'
        }]
      });

      await request(listening(app))
        .post('/api/opportunities/1/recorded-study-session')
        .expect(404);

      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it('refuses to mint a recorded session for an interview carrying a study', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: '1',
          type: 'interview',
          firsthand_study_id: 'study_abc123',
          status: 'published'
        }]
      });

      await request(listening(app))
        .post('/api/opportunities/1/recorded-study-session')
        .expect(404);

      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    /**
     * Re-checked at mint, not only where the link was made. The link-time check
     * alone is a time-of-check problem with a wide window: the studies API
     * takes a client-supplied id, so a study can be planted at a previously
     * dangling id, or deleted and re-created with a different vocabulary, long
     * after the opportunity was published.
     */
    it('refuses when the linked study has become a set of survey questions', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: '1',
          type: 'unmoderated',
          firsthand_study_id: 'study_swapped',
          status: 'published'
        }]
      });
      mockGetStudyById.mockResolvedValueOnce({
        study: {
          id: 'study_swapped',
          title: 'Planted',
          intro_text: 'Intro',
          consent_text: 'Consent',
          status: 'launched' as const,
          kind: 'survey' as const,
          owner_user_id: 'someone-else',
          copied_from_study_id: null,
          created_at: '2026-08-17T10:00:00.000Z',
          updated_at: '2026-08-17T10:00:00.000Z',
        },
        steps: []
      });

      await request(listening(app))
        .post('/api/opportunities/1/recorded-study-session')
        .expect(404);

      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    /**
     * The opportunity a session is attributed to is the authorisation key for
     * reading that study's answers per opportunity. Two things have to hold,
     * and neither did.
     *
     * It has to be WIRED - deleting `opportunityId` from the createSession call
     * removed the feature at its only production entry point with the whole
     * suite still green.
     *
     * And it has to be CANONICAL. opportunities.id is a `uuid` column, so
     * Postgres matches several textual spellings of the same value - braces,
     * upper case, hyphens after any group of four digits - while the column
     * this lands in is TEXT and compares by bytes. Passing the path segment
     * through let a participant mint a family of distinct keys for one
     * opportunity and drop their own answers out of the researcher's results by
     * writing the URL differently. A route path parameter is caller-supplied;
     * only the id Postgres parsed is not.
     */
    it('attributes the session to the opportunity id the database parsed, not the one in the URL', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: '97bfe613-4e1f-472c-917e-b90d1c0326b8',
          type: 'unmoderated',
          firsthand_study_id: 'study_abc123',
          status: 'published'
        }]
      });
      mockCreateSession.mockResolvedValueOnce({
        ok: true,
        session: { session_id: 'session_x', session_token: 'fh_tok', expires_at: '2026-07-22T00:00:00.000Z' }
      });

      await request(listening(app))
        .post('/api/opportunities/{97BFE613-4E1F-472C-917E-B90D1C0326B8}/recorded-study-session')
        .expect(200);

      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        opportunityId: '97bfe613-4e1f-472c-917e-b90d1c0326b8'
      }));
      // Same treatment for the correlation field, so a future reader cannot
      // pick the unnormalised one of the two.
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        participant: expect.objectContaining({
          external_ref: '97bfe613-4e1f-472c-917e-b90d1c0326b8'
        })
      }));
    });

    it('ignores an opportunity id supplied in the request body', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', type: 'unmoderated', firsthand_study_id: 'study_abc123', status: 'published' }]
      });
      mockCreateSession.mockResolvedValueOnce({
        ok: true,
        session: { session_id: 'session_x', session_token: 'fh_tok', expires_at: '2026-07-22T00:00:00.000Z' }
      });

      await request(listening(app))
        .post('/api/opportunities/1/recorded-study-session')
        .send({ opportunity_id: 'someone-elses-opportunity' })
        .expect(200);

      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        opportunityId: '1'
      }));
    });

    it('maps a study-without-steps result to 400', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', type: 'unmoderated', firsthand_study_id: 'study_abc123', status: 'published' }]
      });
      mockCreateSession.mockResolvedValueOnce({ ok: false, error: 'study_has_no_steps' });

      const response = await request(listening(app))
        .post('/api/opportunities/1/recorded-study-session')
        .expect(400);
      expect(response.body.error).toBe('Linked recorded study has no steps');
    });

    it.each([
      ['persistence_not_configured', 503, 'Recorded-study sessions are not available'],
      ['study_not_found', 404, 'Linked recorded study not found'],
    ])('maps createSession error %s to HTTP %i', async (error, status, message) => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', type: 'unmoderated', firsthand_study_id: 'study_abc123', status: 'published' }]
      });
      mockCreateSession.mockResolvedValueOnce({ ok: false, error });

      const response = await request(listening(app))
        .post('/api/opportunities/1/recorded-study-session')
        .expect(status);
      expect(response.body.error).toBe(message);
      // Participant-visible bodies must not leak the internal product name
      expect(JSON.stringify(response.body)).not.toMatch(/firsthand/i);
    });

    it('maps payload_assembly_failed to a 500 with a neutral error code', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', type: 'unmoderated', firsthand_study_id: 'study_abc123', status: 'published' }]
      });
      mockCreateSession.mockResolvedValueOnce({ ok: false, error: 'payload_assembly_failed' });

      const response = await request(listening(app))
        .post('/api/opportunities/1/recorded-study-session')
        .expect(500);
      expect(response.body.error).toBe('Failed to assemble the recorded-study session');
      expect(response.body.code).toBe('SESSION_ASSEMBLY_FAILED');
      // Participant-visible bodies must not leak the internal product name
      expect(JSON.stringify(response.body)).not.toMatch(/firsthand/i);
    });

    it('maps an unmodelled createSession error through the default branch without leaking the raw value', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', type: 'unmoderated', firsthand_study_id: 'study_abc123', status: 'published' }]
      });
      // A value outside the CreateSessionError union drives the exhaustiveness
      // guard. Its message must be static, not the interpolated raw value.
      mockCreateSession.mockResolvedValueOnce({ ok: false, error: 'firsthand.runtime_sessions boom' });

      const response = await request(listening(app))
        .post('/api/opportunities/1/recorded-study-session')
        .expect(500);
      expect(response.body.error).toBe('Failed to assemble the recorded-study session');
      expect(response.body.code).toBe('SESSION_ASSEMBLY_FAILED');
      // The unmodelled value carried an internal identifier; it must be logged
      // server-side, never serialised into the participant-visible body.
      expect(JSON.stringify(response.body)).not.toMatch(/firsthand/i);
      expect(JSON.stringify(response.body)).not.toMatch(/boom/);
    });

    // The legacy /:id/firsthand-handoff path is kept as a deprecated alias so a cached
    // SPA can still reach the handler after the backend rolls. Removing the alias later
    // should turn this into a deliberate red test.
    it('still serves the deprecated /:id/firsthand-handoff alias path', async () => {
      process.env.FRONTEND_URL = 'https://cortex.example.com';
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: '1', type: 'unmoderated', firsthand_study_id: 'study_abc123', status: 'published' }]
      });
      mockCreateSession.mockResolvedValueOnce({
        ok: true,
        session: { session_id: 'session_x', session_token: 'fh_tok', expires_at: '2026-07-22T00:00:00.000Z' }
      });

      const response = await request(listening(app))
        .post('/api/opportunities/1/firsthand-handoff')
        .expect(200);

      expect(response.body.session_url).toBe('https://cortex.example.com/session/fh_tok');
    });
  });

  describe('GET /api/opportunities/:id/recorded-study-brief', () => {
    const publishedUnmoderatedRow = {
      status: 'published',
      type: 'unmoderated',
      firsthand_study_id: 'study_abc123'
    };

    it('reports the task count the study actually carries', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedUnmoderatedRow] });
      mockCountStudyTasks.mockResolvedValueOnce(4);

      const response = await request(listening(unauthenticatedApp))
        .get('/api/opportunities/1/recorded-study-brief')
        .expect(200);

      expect(response.body.task_count).toBe(4);
      expect(response.body.records_screen_and_voice).toBe(true);
      expect(mockCountStudyTasks).toHaveBeenCalledWith('study_abc123');
    });

    // An ALLOWLIST, not a denylist. Asserting "does not contain the prompt text"
    // passes against any fixture that happens not to include it, so a handler
    // spreading the whole study record would ship intro_text and consent_text
    // with every test still green. Pinning the exact key set is the only form
    // of this assertion that cannot rot.
    it('returns counts and constants, and nothing else', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedUnmoderatedRow] });
      mockCountStudyTasks.mockResolvedValueOnce(4);

      const response = await request(listening(unauthenticatedApp))
        .get('/api/opportunities/1/recorded-study-brief')
        .expect(200);

      expect(Object.keys(response.body).sort()).toEqual([
        'estimated_duration_minutes',
        'records_screen_and_voice',
        'requires_chromium',
        'task_count'
      ]);
    });

    // Duration was removed from this payload entirely, because unmoderated had
    // no duration field in the authoring form and every such opportunity
    // carried the column default - stating it above a consent CTA invented a
    // figure no researcher chose. The field exists now, so the figure comes
    // back, but ONLY when someone actually set it.
    it('states the duration a researcher chose', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedUnmoderatedRow] });
      mockCountStudyTasks.mockResolvedValueOnce(4);
      mockGetStudyById.mockResolvedValueOnce({
        study: {
          id: 'study_abc123',
          title: 'A study',
          intro_text: 'Intro',
          consent_text: 'Consent',
          estimated_duration_minutes: 25,
          status: 'launched' as const,
          kind: 'recorded' as const,
          owner_user_id: 'test-user-id',
          copied_from_study_id: null,
          created_at: '2026-08-16T10:00:00.000Z',
          updated_at: '2026-08-16T10:00:00.000Z',
        },
        steps: []
      });

      const response = await request(listening(unauthenticatedApp))
        .get('/api/opportunities/1/recorded-study-brief')
        .expect(200);

      expect(response.body.estimated_duration_minutes).toBe(25);
    });

    it('states no duration when nobody set one, rather than the opportunity default', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedUnmoderatedRow] });
      mockCountStudyTasks.mockResolvedValueOnce(4);
      mockGetStudyById.mockResolvedValueOnce({
        // undefined, not null: the repository maps a NULL column to undefined,
        // and the route turns that into the null the API contract carries.
        study: {
          id: 'study_abc123',
          title: 'A study',
          intro_text: 'Intro',
          consent_text: 'Consent',
          estimated_duration_minutes: undefined,
          status: 'launched' as const,
          kind: 'recorded' as const,
          owner_user_id: 'test-user-id',
          copied_from_study_id: null,
          created_at: '2026-08-16T10:00:00.000Z',
          updated_at: '2026-08-16T10:00:00.000Z',
        },
        steps: []
      });

      const response = await request(listening(unauthenticatedApp))
        .get('/api/opportunities/1/recorded-study-brief')
        .expect(200);

      expect(response.body.estimated_duration_minutes).toBeNull();
      // The original guard, kept: the figure must never be sourced from
      // `opportunities.default_duration_minutes`, which is NOT NULL DEFAULT 30.
      expect(mockQuery.mock.calls[0][0]).not.toContain('default_duration_minutes');
    });

    // Asserting only on the 404 here would be vacuous: the harness feeds the
    // route an empty row set, so the status merely echoes the fixture and the
    // published filter could be deleted with every test still green (it was,
    // and this mutation survived). The gate lives in the SQL, so the SQL is
    // what has to be asserted on.
    it('filters a non-admin to published opportunities in the query itself', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(listening(unauthenticatedApp))
        .get('/api/opportunities/1/recorded-study-brief')
        .expect(404);

      expect(mockQuery.mock.calls[0][0]).toContain("status = 'published'");
      expect(mockCountStudyTasks).not.toHaveBeenCalled();
    });

    it('lets an admin read the brief for their unpublished study so they can preview it', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...publishedUnmoderatedRow, status: 'draft' }]
      });
      mockCountStudyTasks.mockResolvedValueOnce(4);

      const response = await request(listening(app))
        .get('/api/opportunities/1/recorded-study-brief')
        .expect(200);

      expect(mockQuery.mock.calls[0][0]).not.toContain("status = 'published'");
      expect(response.body.task_count).toBe(4);
    });

    it('answers 404 without looking up a study when none is linked', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...publishedUnmoderatedRow, firsthand_study_id: null }]
      });

      await request(listening(unauthenticatedApp))
        .get('/api/opportunities/1/recorded-study-brief')
        .expect(404);

      // Without this the guard is untestable: a null id falls through to the
      // count, which also misses, and the 404 looks identical.
      expect(mockCountStudyTasks).not.toHaveBeenCalled();
    });

    // An opportunity authored as unmoderated and later switched to another type
    // keeps its firsthand_study_id. Without the type guard the API would tell an
    // anonymous caller that a poll records their screen and voice.
    it.each(['poll', 'survey', 'question', 'test', 'interview'])(
      'refuses to describe a %s as a recorded study, even with a study still linked',
      async (type) => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ ...publishedUnmoderatedRow, type }]
        });

        await request(listening(unauthenticatedApp))
          .get('/api/opportunities/1/recorded-study-brief')
          .expect(404);

        expect(mockCountStudyTasks).not.toHaveBeenCalled();
      }
    );

    it('answers 404 when the linked study has gone missing', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedUnmoderatedRow] });
      mockCountStudyTasks.mockResolvedValueOnce(null);

      await request(listening(unauthenticatedApp))
        .get('/api/opportunities/1/recorded-study-brief')
        .expect(404);
    });
  });

  describe('POST /api/opportunities/:id/survey-session', () => {
    const surveyRow = (overrides: Record<string, unknown> = {}) => ({
      id: '1',
      type: 'survey',
      firsthand_study_id: 'study_questions',
      status: 'published',
      delivery_mode: 'native',
      ...overrides
    });

    const surveyStudy = {
      study: {
        id: 'study_questions',
        title: 'Questions',
        intro_text: 'Intro',
        consent_text: 'Consent',
        status: 'launched' as const,
        kind: 'survey' as const,
        owner_user_id: 'test-user-id',
        copied_from_study_id: null,
        created_at: '2026-08-17T10:00:00.000Z',
        updated_at: '2026-08-17T10:00:00.000Z',
      },
      steps: []
    };

    it('mints a session and returns a same-origin survey URL', async () => {
      process.env.FRONTEND_URL = 'https://cortex.example.com';
      mockQuery.mockResolvedValueOnce({ rows: [surveyRow()] });
      mockGetStudyById.mockResolvedValueOnce(surveyStudy);
      mockCreateSession.mockResolvedValueOnce({
        ok: true,
        session: { session_id: 's', session_token: 'fh_tok', expires_at: '2026-09-01T00:00:00.000Z' }
      });

      const response = await request(listening(app))
        .post('/api/opportunities/1/survey-session')
        .expect(200);

      expect(response.body.session_url).toBe('https://cortex.example.com/survey/fh_tok');
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ studyId: 'study_questions', opportunityId: '1' })
      );
    });

    it('rejects an unauthenticated request', async () => {
      await request(listening(unauthenticatedApp))
        .post('/api/opportunities/1/survey-session')
        .expect(401);
    });

    /**
     * BOTH conditions, not either. The mode says the researcher meant this to
     * run in Cortex; the study's kind says the questions are written in a
     * vocabulary this runner can draw. A switch to external leaves the study
     * linked, so the mode alone would let a stale link run.
     */
    it('refuses a survey that hands off externally, even with questions linked', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [surveyRow({ delivery_mode: 'external' })]
      });
      await request(listening(app)).post('/api/opportunities/1/survey-session').expect(404);

      // The guard has to be the SOURCE of the 404, and asserting the study
      // was never read is what proves it: the file-level getStudyById
      // default is a recorded study, so the kind re-check would produce the
      // same 404 - which is why this passed with the guard deleted.
      expect(mockGetStudyById).not.toHaveBeenCalled();

      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it('refuses when the linked study is a recorded task list', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [surveyRow()] });
      mockGetStudyById.mockResolvedValueOnce({
        ...surveyStudy,
        study: { ...surveyStudy.study, kind: 'recorded' as const }
      });

      await request(listening(app)).post('/api/opportunities/1/survey-session').expect(404);

      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it('refuses a recorded study, which has its own route', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [surveyRow({ type: 'unmoderated' })]
      });

      await request(listening(app)).post('/api/opportunities/1/survey-session').expect(404);

      expect(mockGetStudyById).not.toHaveBeenCalled();
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it('mints for a poll too, not only a survey', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [surveyRow({ type: 'poll' })] });
      mockGetStudyById.mockResolvedValueOnce(surveyStudy);
      mockCreateSession.mockResolvedValueOnce({
        ok: true,
        session: { session_id: 's', session_token: 'fh_poll', expires_at: '2026-09-01T00:00:00.000Z' }
      });

      await request(listening(app)).post('/api/opportunities/1/survey-session').expect(200);

      expect(mockCreateSession).toHaveBeenCalled();
    });

    /**
     * #78: a one-question opportunity is answered here too.
     *
     * This route IS the native path. Before it accepted the type there was no
     * way to answer a `question` inside Cortex at all, whatever the form
     * offered - so this test is the one that would go red if the type half of
     * the guard were narrowed back to two types.
     */
    it('mints for a one-question opportunity', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [surveyRow({ type: 'question' })] });
      mockGetStudyById.mockResolvedValueOnce(surveyStudy);
      mockCreateSession.mockResolvedValueOnce({
        ok: true,
        session: { session_id: 's', session_token: 'fh_q', expires_at: '2026-09-01T00:00:00.000Z' }
      });

      await request(listening(app)).post('/api/opportunities/1/survey-session').expect(200);

      expect(mockCreateSession).toHaveBeenCalled();
    });

    /**
     * The control for the test above: the MODE half still decides. An external
     * one-question opportunity hands its participant to another site, so there
     * is nothing here to mint - and asserting the study was never read is what
     * proves this 404 comes from the guard rather than from the kind re-check
     * below it, exactly as the survey twin does.
     */
    it('refuses a one-question opportunity that hands off externally', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [surveyRow({ type: 'question', delivery_mode: 'external' })]
      });

      await request(listening(app)).post('/api/opportunities/1/survey-session').expect(404);

      expect(mockGetStudyById).not.toHaveBeenCalled();
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    /**
     * One session per participant per opportunity. Every mint is a row the
     * results aggregation counts as a respondent, so minting freely is vote
     * stuffing - proven end to end as an ordinary employee, three extra mints
     * taking a rating question from 3 respondents to 6.
     */
    it('resumes an unfinished session instead of minting a second one', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [surveyRow()] });
      mockGetStudyById.mockResolvedValueOnce(surveyStudy);
      mockFindParticipantSession.mockResolvedValueOnce({
        token: 'fh_existing',
        sessionStatus: 'link_opened'
      });

      const response = await request(listening(app))
        .post('/api/opportunities/1/survey-session')
        .expect(200);

      expect(response.body.session_url).toContain('fh_existing');
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it('refuses a second answer once the participant has finished', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [surveyRow()] });
      mockGetStudyById.mockResolvedValueOnce(surveyStudy);
      mockFindParticipantSession.mockResolvedValueOnce({
        token: 'fh_done',
        sessionStatus: 'completed'
      });

      await request(listening(app)).post('/api/opportunities/1/survey-session').expect(409);

      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    /**
     * A published opportunity can link a study that is still a draft, and the
     * opportunity's own status says nothing about it. Without this the
     * unfinished question wording was served to participants and their answers
     * counted in the results.
     */
    it('refuses a study that is still a draft', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [surveyRow()] });
      mockGetStudyById.mockResolvedValueOnce({
        ...surveyStudy,
        study: { ...surveyStudy.study, status: 'draft' as const }
      });

      await request(listening(app)).post('/api/opportunities/1/survey-session').expect(404);

      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it('refuses a study id that resolves to nothing', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [surveyRow()] });
      mockGetStudyById.mockResolvedValueOnce(null as never);

      await request(listening(app)).post('/api/opportunities/1/survey-session').expect(404);

      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it('refuses a draft', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [surveyRow({ status: 'draft' })] });

      await request(listening(app)).post('/api/opportunities/1/survey-session').expect(403);

      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it('says so when nothing is linked yet', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [surveyRow({ firsthand_study_id: null })]
      });

      const response = await request(listening(app))
        .post('/api/opportunities/1/survey-session')
        .expect(400);

      expect(response.body.error).toBe('Study has no questions linked');
    });
  });

  describe('GET /api/opportunities/:id/session-events', () => {
    const sessionEventRows = [{
      id: 'evt-1',
      opportunity_id: '1',
      participant_user_id: 'test-user-id',
      firsthand_session_id: 'fh-session-1',
      event_type: 'session.completed',
      occurred_at: '2026-07-15T00:00:00Z',
      payload: {},
      received_at: '2026-07-15T00:00:01Z',
      participant_name: 'Test User',
      participant_email: 'test@example.com'
    }];

    it('should return session events for the opportunity owner', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'test-user-id' }]
      });
      mockQuery.mockResolvedValueOnce({ rows: sessionEventRows });

      const response = await request(listening(app))
        .get('/api/opportunities/1/session-events')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].event_type).toBe('session.completed');
    });

    it('should reject an unauthenticated request with 401', async () => {
      const response = await request(listening(unauthenticatedApp))
        .get('/api/opportunities/1/session-events')
        .expect(401);

      expect(response.body.error).toBe('Authentication required');
    });

    it('should reject an admin who does not own the opportunity with 403', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'different-user-id' }]
      });

      const response = await request(listening(app))
        .get('/api/opportunities/1/session-events')
        .expect(403);

      expect(response.body.error).toBe('Only the study owner can view session events');
    });

    it('should return 404 when the opportunity does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(listening(app))
        .get('/api/opportunities/1/session-events')
        .expect(404);
    });

    it('should allow a superadmin who does not own the opportunity', async () => {
      const superadminApp = express();
      superadminApp.use(express.json());
      superadminApp.use((req: any, res, next) => {
        req.session = {
          user: {
            id: 'superadmin-id',
            name: 'Super Admin',
            email: 'super@example.com',
            role: 'superadmin'
          }
        };
        next();
      });
      superadminApp.use('/api/opportunities', opportunitiesRouter);
      superadminApp.use(errorHandler);

      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'different-user-id' }]
      });
      mockQuery.mockResolvedValueOnce({ rows: sessionEventRows });

      const response = await request(listening(superadminApp))
        .get('/api/opportunities/1/session-events')
        .expect(200);

      expect(response.body).toHaveLength(1);
    });
  });

  // Phase 4e. The researcher-facing results read, scoped to one opportunity.
  // Its superadmin-only twin (GET /api/firsthand/studies/:id/results) spans
  // every opportunity that used the study, which is why it cannot be the one a
  // researcher gets.
  describe('GET /api/opportunities/:id/survey-results', () => {
    // Deliberately unlike each other, and unlike the path segment used below.
    // Fixtures that share a value cannot tell "read the parsed id" apart from
    // "read the path segment", and this file has shipped that mistake before.
    const CANONICAL_ID = 'canonical-parsed-id';
    const PATH_SEGMENT = 'PATH-SEGMENT-ID';
    const STUDY_ID = 'study_linked_by_the_row';

    const storedStudy = {
      study: {
        id: STUDY_ID,
        title: 'How was it',
        intro_text: 'Intro',
        consent_text: 'Consent',
        kind: 'survey' as const,
        estimated_duration_minutes: undefined,
        status: 'launched' as const,
        owner_user_id: 'someone-else',
        copied_from_study_id: null,
        created_at: '2026-08-16T10:00:00.000Z',
        updated_at: '2026-08-16T10:00:00.000Z',
      },
      steps: [
        {
          step_id: 'q1',
          order: 1,
          type: 'rating' as const,
          prompt: 'How easy was that?',
          config: { scale_max: 5 },
        },
      ],
    };

    const queueOpportunity = (ownerUserId: string, studyId: string | null = STUDY_ID) => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: CANONICAL_ID, owner_user_id: ownerUserId, firsthand_study_id: studyId }]
      });
    };

    beforeEach(() => {
      // jest.clearAllMocks() clears CALLS, not an implementation installed by
      // mockReturnValue. Without this, the "runtime database unconfigured"
      // test below leaves it false for every test after it, and three
      // unrelated 404 assertions fail as 503 - which reads as a route bug.
      mockIsStudiesPersistenceConfigured.mockReturnValue(true);
    });

    it('refuses an admin who does not own the opportunity, without reading any answers', async () => {
      queueOpportunity('a-different-researcher');

      const response = await request(listening(app))
        .get(`/api/opportunities/${PATH_SEGMENT}/survey-results`)
        .expect(403);

      expect(response.body.error).toBe('Only the study owner can view survey responses');
      // The status alone would still pass with the gate moved below the read.
      // Participants' answers must not have been loaded at all.
      expect(mockListResponsesForOpportunity).not.toHaveBeenCalled();
    });

    it('refuses the CSV export before any download header is set', async () => {
      queueOpportunity('a-different-researcher');

      const response = await request(listening(app))
        .get(`/api/opportunities/${PATH_SEGMENT}/survey-results.csv`)
        .expect(403);

      // The substance of this test. Express keeps an already-set Content-Type
      // through an error, so a refusal written after res.setHeader still hands
      // over a file with a 403 on it. Asserting the status would not see that.
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(mockListResponsesForOpportunity).not.toHaveBeenCalled();
    });

    /**
     * THE EXISTENCE ORACLE (cto/AdaptaLabs#7).
     *
     * `loadOpportunityResultsContext` threw `NotFoundError` for a missing row
     * and `ForbiddenError` for one this caller does not own, so a
     * researcher_admin could tell the two apart - an oracle over opportunity
     * ids, to a caller entitled to neither answer.
     *
     * Unlike the study results routes there is no reordering available here:
     * ownership cannot be evaluated without the row. So the refusal is
     * collapsed onto the 404 instead, message included.
     *
     * Asserted as INDISTINGUISHABILITY, not as "returns 404". A test that only
     * checked the refused case could not see the 403 come back.
     */
    describe('tells a caller who may not read nothing about which ids exist', () => {
      /**
       * EVERYTHING A CALLER CAN OBSERVE, minus what varies for reasons that
       * carry no information about the resource.
       *
       * An earlier version picked two headers by name - content-type and
       * content-disposition - and a review gate broke it in one line: adding
       * `res.setHeader('X-Refusal-Reason', 'not-the-owner')` on the non-owner
       * branch passed all 295 tests in this file. An allow-list of headers
       * cannot see an oracle carried by a header nobody thought of, which is
       * the only kind anybody would add.
       *
       * So the whole bag is compared and the volatile ones are named. Named,
       * not pattern-matched: every one of these was OBSERVED to differ between
       * two identical refusals, and anything else that starts differing should
       * fail this rather than be waved through.
       *
       *  - `date`, `etag`: `errorHandler` stamps the body with the wall clock,
       *    so two refusals a millisecond apart differ in both.
       *  - `ratelimit-*`: a monotone per-user counter, so the SECOND request in
       *    any pair differs from the first whatever it asked for.
       *  - `x-request-id`: per-request by construction.
       */
      const VOLATILE_HEADERS = /^(date|etag|x-request-id|ratelimit-)/;

      /**
       * The raw body too, with the clock normalised OUT BY NAME rather than
       * dropped. `body` is parsed, so it cannot see key order or a body that
       * is not JSON at all; the raw text can. Replacing the timestamp value
       * in place keeps the length identical, so `content-length` stays a live
       * part of the comparison.
       */
      const withoutClock = (text: string) =>
        text.replace(/"timestamp":"[^"]*"/, '"timestamp":"<clock>"');

      const shapeOf = (res: request.Response) => {
        const { timestamp: _stamped, ...body } = res.body ?? {};
        return {
          status: res.status,
          body,
          text: withoutClock(res.text ?? ''),
          headers: Object.fromEntries(
            Object.entries(res.headers).filter(
              ([name]) => !VOLATILE_HEADERS.test(name)
            )
          )
        };
      };

      it.each([
        { what: 'the aggregate', suffix: 'survey-results' },
        { what: 'the CSV export', suffix: 'survey-results.csv' }
      ])('answers $what identically whether or not the opportunity exists', async ({ suffix }) => {
        // No row at all.
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const missing = shapeOf(
          await request(listening(app)).get(
            `/api/opportunities/${PATH_SEGMENT}/${suffix}`
          )
        );

        // A row belonging to somebody else.
        queueOpportunity('a-different-researcher');
        const existing = shapeOf(
          await request(listening(app)).get(
            `/api/opportunities/${PATH_SEGMENT}/${suffix}`
          )
        );

        expect(missing).toEqual(existing);
        expect(missing.status).toBe(403);
        // A refusal that had already set the download header would hand over a
        // file whichever way this went.
        expect(missing.headers['content-disposition']).toBeUndefined();

        // THE CONTROL. Two responses compared with `toEqual` is precisely the
        // assertion that passes when the probe cannot see a difference. This
        // proves it can: the owner asks for the SAME id and gets something
        // else entirely.
        queueOpportunity('test-user-id');
        mockGetStudyById.mockResolvedValueOnce(storedStudy);
        const entitled = shapeOf(
          await request(listening(app)).get(
            `/api/opportunities/${PATH_SEGMENT}/${suffix}`
          )
        );
        expect(entitled.status).toBe(200);
        expect(entitled).not.toEqual(existing);
      });

      it('refuses an opportunity nobody owns, rather than letting it fail open', async () => {
        // `owner_user_id` NULL is the case a permissive comparison waves
        // through: `canWriteStudy` fails OPEN for an unowned study because a
        // write can adopt the row, and a read can adopt nothing. Nothing here
        // pinned it, so widening the check to
        // `owner_user_id != null && owner_user_id !== req.user.id` passed all
        // 293 tests in this file while handing every admin the answers of any
        // opportunity whose owner had been removed.
        queueOpportunity(null as unknown as string);

        await request(listening(app))
          .get(`/api/opportunities/${PATH_SEGMENT}/survey-results`)
          .expect(403);

        expect(mockListResponsesForOpportunity).not.toHaveBeenCalled();
      });

      it('lets a superadmin read an opportunity nobody owns', async () => {
        // The control for the test above: an assertion that everything is
        // refused would pass just as well against a route that refused
        // everybody.
        const superadminApp = express();
        superadminApp.use(express.json());
        // Cast rather than `any`: this file's no-explicit-any allowance is
        // held per file in eslint-suppressions.json, so one more `any` turns
        // every existing one in the file into an error.
        superadminApp.use((req, _res, next) => {
          (req as unknown as { session: unknown }).session = {
            user: {
              id: 'superadmin-id',
              name: 'Super Admin',
              email: 'super@example.com',
              role: 'superadmin'
            }
          };
          next();
        });
        superadminApp.use('/api/opportunities', opportunitiesRouter);
        superadminApp.use(errorHandler);

        queueOpportunity(null as unknown as string);
        mockGetStudyById.mockResolvedValueOnce(storedStudy);

        await request(listening(superadminApp))
          .get(`/api/opportunities/${PATH_SEGMENT}/survey-results`)
          .expect(200);
      });

      it('still tells a superadmin the truth about an id that is not there', async () => {
        // THE POINT OF COLLAPSING ONLY FOR THE UNENTITLED. Without this,
        // answering 403 to everybody - superadmin included - passed all 295
        // tests, and the accurate answer would have been lost for the one
        // caller who is allowed to have it.
        const superadminApp = express();
        superadminApp.use(express.json());
        superadminApp.use((req, _res, next) => {
          (req as unknown as { session: unknown }).session = {
            user: {
              id: 'superadmin-id',
              name: 'Super Admin',
              email: 'super@example.com',
              role: 'superadmin'
            }
          };
          next();
        });
        superadminApp.use('/api/opportunities', opportunitiesRouter);
        superadminApp.use(errorHandler);

        mockQuery.mockResolvedValueOnce({ rows: [] });

        const response = await request(listening(superadminApp))
          .get(`/api/opportunities/${PATH_SEGMENT}/survey-results`)
          .expect(404);

        expect(response.body.error).toBe('Study not found');
      });

      it('still logs the refusal, so the operator keeps the answer the caller lost', async () => {
        // The whole cost of collapsing the two is that the caller is told
        // something less true. That is only acceptable while the accurate
        // reason survives somewhere, and this is where.
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

        try {
          queueOpportunity('a-different-researcher');

          await request(listening(app))
            .get(`/api/opportunities/${PATH_SEGMENT}/survey-results`)
            .expect(403);

          expect(warn).toHaveBeenCalledWith(
            'Refused a survey results read below the opportunity owner',
            expect.objectContaining({ userId: 'test-user-id', found: true })
          );

          // `found` IS THE DISCRIMINATOR, and without it this log would be
          // worthless: the two cases now return the same refusal, so a line
          // that fired identically for a probe at a real id and one that never
          // existed would tell the operator exactly what the caller is told.
          // The control below is what proves the field moves.
          warn.mockClear();
          mockQuery.mockResolvedValueOnce({ rows: [] });

          await request(listening(app))
            .get(`/api/opportunities/${PATH_SEGMENT}/survey-results`)
            .expect(403);

          expect(warn).toHaveBeenCalledWith(
            'Refused a survey results read below the opportunity owner',
            expect.objectContaining({ userId: 'test-user-id', found: false })
          );
        } finally {
          warn.mockRestore();
        }
      });
    });

    it('reads the answers of the id Postgres parsed, not the path segment', async () => {
      queueOpportunity('test-user-id');
      mockGetStudyById.mockResolvedValueOnce(storedStudy);

      await request(listening(app))
        .get(`/api/opportunities/${PATH_SEGMENT}/survey-results`)
        .expect(200);

      // `opportunities.id` is uuid and `runtime_sessions.opportunity_id` is
      // TEXT, so filtering on the raw segment returns nothing for a URL written
      // with different casing or braces - and silently, as an empty result.
      expect(mockListResponsesForOpportunity).toHaveBeenCalledWith({
        opportunityId: CANONICAL_ID,
        studyId: STUDY_ID,
      });
    });

    it('gives the owner the aggregated answers', async () => {
      queueOpportunity('test-user-id');
      mockGetStudyById.mockResolvedValueOnce(storedStudy);
      mockListResponsesForOpportunity.mockResolvedValueOnce([
        { session_id: 's1', step_id: 'q1', step_prompt: null, step_type: 'rating', response_payload: { rating: 4 }, saved_at: '2026-08-17T10:00:00.000Z' },
        { session_id: 's2', step_id: 'q1', step_prompt: null, step_type: 'rating', response_payload: { rating: 5 }, saved_at: '2026-08-17T10:01:00.000Z' },
      ]);

      const response = await request(listening(app))
        .get(`/api/opportunities/${PATH_SEGMENT}/survey-results`)
        .expect(200);

      expect(response.body.title).toBe('How was it');
      expect(response.body.results.respondents).toBe(2);
      expect(response.body.results.questions[0].mean).toBe(4.5);
    });

    it('gives a superadmin who does not own the opportunity the answers', async () => {
      // Typed rather than `(req: any)`: this file's no-explicit-any allowance
      // is held per file in eslint-suppressions.json, so one more untyped
      // request handler turns all fourteen existing ones into errors.
      const superadminApp = express();
      superadminApp.use(express.json());
      superadminApp.use((req, _res, next) => {
        // Through `unknown`, because express-session's declaration merging
        // types req.session as a full Session and an intersection cannot
        // widen it back to the plain stub these routes actually read.
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id: 'superadmin-id', name: 'Super Admin', email: 'super@example.com', role: 'superadmin' }
        };
        next();
      });
      superadminApp.use('/api/opportunities', opportunitiesRouter);
      superadminApp.use(errorHandler);

      queueOpportunity('a-different-researcher');
      mockGetStudyById.mockResolvedValueOnce(storedStudy);

      await request(listening(superadminApp))
        .get(`/api/opportunities/${PATH_SEGMENT}/survey-results`)
        .expect(200);

      expect(mockListResponsesForOpportunity).toHaveBeenCalled();
    });

    // Run against BOTH routes. They share one resolver, so they refuse
    // identically by construction - but only the CSV one can hand over a file
    // with a refusal on it, so its refusal paths are the ones worth pinning.
    // Before this, every path but the 403 was proven on the JSON route alone,
    // and deleting the CSV route's 503 guard left all 165 tests passing.
    describe.each([
      ['/survey-results'],
      ['/survey-results.csv'],
    ])('refusals on %s', (suffix) => {
      const get = () => request(listening(app)).get(`/api/opportunities/${PATH_SEGMENT}${suffix}`);

      // Asserted on every refusal, not only the 403: any status that arrives
      // with these set has already offered the file.
      const expectNoDownload = (response: request.Response) => {
        expect(response.headers['content-disposition']).toBeUndefined();
        expect(response.headers['content-type']).not.toMatch(/text\/csv/);
      };

      it('answers 403 for an opportunity that does not exist', async () => {
        // 403, NOT 404, and this test asserting 404 is what the oracle looked
        // like from the inside: the status a non-superadmin gets here used to
        // depend on whether the row was real. See the indistinguishability
        // block above for why both cases now answer the same refusal.
        mockQuery.mockResolvedValueOnce({ rows: [] });

        expectNoDownload(await get().expect(403));
        expect(mockListResponsesForOpportunity).not.toHaveBeenCalled();
      });

      it('answers 404 when the opportunity links no questions', async () => {
        queueOpportunity('test-user-id', null);

        expectNoDownload(await get().expect(404));
        expect(mockListResponsesForOpportunity).not.toHaveBeenCalled();
      });

      it('answers 404 when the linked study has been deleted', async () => {
        // Reachable: DELETE /api/firsthand/studies/:studyId does not clear the
        // opportunity's firsthand_study_id, so the link outlives the study.
        // Without this, a missing study could return 200 with no questions -
        // zero respondents reported for a survey nobody could read.
        queueOpportunity('test-user-id');
        mockGetStudyById.mockResolvedValueOnce(null);

        expectNoDownload(await get().expect(404));
        expect(mockListResponsesForOpportunity).not.toHaveBeenCalled();
      });

      it('answers 503 rather than an empty result when the database is unavailable', async () => {
        mockIsDatabaseAvailable.mockResolvedValue(false);

        const response = await get().expect(503);

        // Zero respondents is a finding. Reporting it without having looked
        // would be a wrong one.
        expect(response.body.error).toBe('Survey results are not available');
        expectNoDownload(response);
      });

      it('answers 503, not 404, when the runtime database is unconfigured', async () => {
        // The questions and answers live on the FirstHand runtime pool, which
        // is configured separately from the main one. Checking only the main
        // pool made getStudyById answer null, and the route then told the
        // researcher their survey did not exist.
        mockIsStudiesPersistenceConfigured.mockReturnValue(false);

        const response = await get().expect(503);

        expect(response.body.error).toBe('Survey results are not available');
        expectNoDownload(response);
      });
    });

    it('serves a failure as JSON, not as a file, if opening the export throws', async () => {
      queueOpportunity('test-user-id');
      mockGetStudyById.mockResolvedValueOnce(storedStudy);
      mockListResponsesForOpportunity.mockRejectedValueOnce(
        new Error('the read blew up')
      );

      const response = await request(listening(app))
        .get(`/api/opportunities/${PATH_SEGMENT}/survey-results.csv`)
        .expect(500);

      // The same hazard the 403 ordering guards against, one line lower down:
      // Express keeps an already-set Content-Type through the error handler,
      // so headers set before the body was opened would have made the browser
      // download the error object as "<title> responses.csv".
      //
      // Streaming makes this MORE important, not less: `openSurveyCsvExport`
      // is awaited before the first setHeader precisely so that every refusal
      // and every read failure still lands here, where a status can still be
      // chosen.
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(response.headers['content-type']).not.toMatch(/text\/csv/);
    });

    it('exports the answers of THIS opportunity, not the whole study', async () => {
      queueOpportunity('test-user-id');
      mockGetStudyById.mockResolvedValueOnce(storedStudy);

      await request(listening(app))
        .get(`/api/opportunities/${PATH_SEGMENT}/survey-results.csv`)
        .expect(200);

      // A study is reusable by an opportunity its author did not create, so
      // `kind: 'study'` here would return every participant another researcher
      // recruited, under their consent wording. And it is the canonical id
      // Postgres parsed, never the raw path segment - `opportunity_id` is TEXT
      // against a uuid, so a differently-cased URL would silently drop rows.
      const { __scopeSpy } = jest.requireMock<{ __scopeSpy: jest.Mock }>(
        '../../firsthand/survey-results-repository'
      );
      expect(__scopeSpy).toHaveBeenCalledWith({
        kind: 'opportunity',
        studyId: STUDY_ID,
        opportunityId: CANONICAL_ID
      });
    });

    /**
     * THE ROUTE'S HALF OF THE DEADLINE (cto/AdaptaLabs#5).
     *
     * `writeSurveyCsv` owns the export's wall-clock deadline and hands its
     * AbortSignal to the generator factory, so the bound reaches the batch
     * reads and not only the writes to the socket. This route's whole job is
     * to hand `csvExport.participants` over UNCALLED.
     *
     * A review gate broke exactly that with the suite green: substituting
     * `() => csvExport.participants(new AbortController().signal)` type-checks
     * and passes everything, leaving the database half unbounded. Nothing here
     * could see it, because the stand-in generator took no parameter.
     */
    it('hands the export the deadline signal the writer will abort', async () => {
      queueOpportunity('test-user-id');
      mockGetStudyById.mockResolvedValueOnce(storedStudy);

      const { __signalSpy } = jest.requireMock<{ __signalSpy: jest.Mock }>(
        '../../firsthand/survey-results-repository'
      );
      __signalSpy.mockClear();

      // THE CONTROL: a signal that arrived already aborted would satisfy the
      // assertion below while bounding nothing.
      //
      // RECORDED here, ASSERTED in the test body. An `expect` thrown inside a
      // jest mock implementation is swallowed by `writeSurveyCsv`'s catch and
      // reported as a socket error with no assertion failure recorded - a gate
      // proved a deliberately false version of this control passing. See the
      // twin in firsthand.test.ts.
      let abortedAtFirstPull: boolean | undefined;
      __signalSpy.mockImplementationOnce((...args: unknown[]) => {
        abortedAtFirstPull = (args[0] as AbortSignal).aborted;
      });

      await request(listening(app))
        .get(`/api/opportunities/${PATH_SEGMENT}/survey-results.csv`)
        .expect(200);

      expect(__signalSpy).toHaveBeenCalledTimes(1);
      expect(abortedAtFirstPull).toBe(false);
      const signal = __signalSpy.mock.calls[0][0] as AbortSignal;

      // The writer aborts on every exit, so its own signal ends up aborted and
      // a substituted one does not. That is the discriminator.
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(true);
    });

    it('destroys the download rather than finishing it short, if a row throws mid-stream', async () => {
      queueOpportunity('test-user-id');
      mockGetStudyById.mockResolvedValueOnce(storedStudy);
      mockListResponsesForOpportunity.mockResolvedValueOnce([
        { session_id: 'session-1', step_id: 'q1', step_prompt: null, step_type: 'open_text', response_payload: { text: 'Fine' }, saved_at: '2026-08-17T10:00:00.000Z' },
        { session_id: 'session-2', step_id: 'q1', step_prompt: null, step_type: 'open_text', response_payload: { text: 'Also fine' }, saved_at: '2026-08-17T10:01:00.000Z' },
      ]);
      // First participant writes, second blows up - after the 200 and the
      // headers have already gone out.
      mockToCsvParticipantRow
        .mockImplementationOnce(() => 'session-1,Fine')
        .mockImplementationOnce(() => {
          throw new Error('row blew up');
        });

      // REFUSED, NOT TRUNCATED, at the only point where the tools are worse.
      // The status is already 200 and cannot be taken back, so the honest
      // failure is a transfer that ends early. `res.end()` here would hand the
      // researcher a CSV that parses and contains part of their data - a mean
      // computed over a subset with nothing on the page saying so.
      // Asserted by SIGNATURE, not by `rejects.toThrow()` alone. The review
      // gate was right that a bare toThrow accepts anything - and until !208
      // landed, `socket hang up` was also the signature of the ambient
      // supertest flake in this very file, so the test could have passed for a
      // reason entirely unrelated to the destroy it claims to prove.
      await expect(
        request(listening(app)).get(
          `/api/opportunities/${PATH_SEGMENT}/survey-results.csv`
        )
      ).rejects.toThrow(/socket hang up|ECONNRESET|aborted/i);
    });

    it('reports zero respondents as a real answer once it has looked', async () => {
      queueOpportunity('test-user-id');
      mockGetStudyById.mockResolvedValueOnce(storedStudy);

      const response = await request(listening(app))
        .get(`/api/opportunities/${PATH_SEGMENT}/survey-results`)
        .expect(200);

      // The state every survey starts in, and the one the 503 above exists to
      // stay distinguishable from.
      expect(response.body.results.respondents).toBe(0);
      expect(response.body.results.questions[0].answered).toBe(0);
    });

    it('exports the CSV to the owner with both download headers', async () => {
      queueOpportunity('test-user-id');
      mockGetStudyById.mockResolvedValueOnce(storedStudy);
      mockListResponsesForOpportunity.mockResolvedValueOnce([
        { session_id: 's1', step_id: 'q1', step_prompt: null, step_type: 'rating', response_payload: { rating: 4 }, saved_at: '2026-08-17T10:00:00.000Z' },
      ]);

      const response = await request(listening(app))
        .get(`/api/opportunities/${PATH_SEGMENT}/survey-results.csv`)
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/csv/);
      expect(response.headers['content-disposition']).toContain('How was it responses.csv');
      expect(response.text).toContain('How easy was that?');
      expect(response.text).toContain('s1');
    });
  });

  // The limiter runs between the auth middleware and the handler, so every
  // request that gets past auth spends a token whatever the handler then
  // answers. These fire requests that 404 cheaply, which is enough to count.
  describe('rate limiting on the participant and results routes', () => {
    const appAsUser = (id: string, role: string) => {
      const scoped = express();
      scoped.use(express.json());
      scoped.use((req, _res, next) => {
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id, name: id, email: `${id}@example.com`, role }
        };
        next();
      });
      scoped.use('/api/opportunities', opportunitiesRouter);
      scoped.use(errorHandler);
      return scoped;
    };

    const fire = async (target: express.Express, path: string, times: number) => {
      const codes: number[] = [];
      for (let i = 0; i < times; i += 1) {
        codes.push((await request(listening(target)).get(path)).status);
      }
      return codes;
    };

    it('refuses a researcher who loops the results read', async () => {
      const codes = await fire(app, '/api/opportunities/opp-1/survey-results', 61);

      // 60 through, then the ceiling. Not a quota on a person - a backstop on
      // a loop, because the projection has no LIMIT and runs on the
      // 5-connection runtime pool that live participant sessions share.
      expect(codes.slice(0, 60).every((code) => code !== 429)).toBe(true);
      expect(codes[60]).toBe(429);
    });

    it('counts the CSV export against the same ceiling as the JSON read', async () => {
      await fire(app, '/api/opportunities/opp-1/survey-results', 60);

      // Deliberately one bucket: they read the same rows off the same pool, so
      // separate ceilings would double the exposure the limit exists to cap.
      const response = await request(listening(app)).get('/api/opportunities/opp-1/survey-results.csv');

      expect(response.status).toBe(429);
    });

    it('refuses a participant who loops the survey mint', async () => {
      const participant = appAsUser('participant-a', 'employee');
      const codes: number[] = [];
      for (let i = 0; i < 21; i += 1) {
        codes.push((await request(listening(participant)).post('/api/opportunities/opp-1/survey-session')).status);
      }

      // 60 sessions in under a second from one cookie was measured before this
      // existed. Idempotent minting removed the vote-stuffing value of that;
      // the ceiling removes the cost.
      expect(codes.slice(0, 20).every((code) => code !== 429)).toBe(true);
      expect(codes[20]).toBe(429);
      resetParticipantRouteLimits('participant-a');
    });

    it('refuses a researcher who loops opportunity writes', async () => {
      // Each inline_survey write inserts a study plus up to 51 step rows on the
      // 5-connection runtime pool live participant sessions share.
      const codes: number[] = [];
      for (let i = 0; i < 31; i += 1) {
        codes.push((await request(listening(app)).delete('/api/opportunities/opp-1')).status);
      }

      expect(codes.slice(0, 30).every((code) => code !== 429)).toBe(true);
      expect(codes[30]).toBe(429);
    });

    it('keeps reading an opportunity off the write bucket', async () => {
      for (let i = 0; i < 31; i += 1) {
        await request(listening(app)).delete('/api/opportunities/opp-1');
      }

      // Browsing is not writing. A researcher who saved a lot must still be
      // able to look at the list.
      expect((await request(listening(app)).get('/api/opportunities')).status).not.toBe(429);
    });

    it('gives each caller their own bucket, so one cannot refuse another', async () => {
      // The substance of the design. `trust proxy: 1` resolves req.ip to the
      // ingress behind two proxy hops, so an IP-keyed limiter would be ONE
      // bucket shared by every external caller and this flood would 429 an
      // unrelated researcher. These routes are authenticated, so the key is
      // the session's user id instead - not spoofable, and not collapsible by
      // a proxy.
      const noisy = appAsUser('noisy-researcher', 'researcher_admin');
      const quiet = appAsUser('quiet-researcher', 'researcher_admin');

      const noisyCodes = await fire(noisy, '/api/opportunities/opp-1/survey-results', 61);
      expect(noisyCodes[60]).toBe(429);

      const quietResponse = await request(listening(quiet)).get('/api/opportunities/opp-1/survey-results');
      expect(quietResponse.status).not.toBe(429);

      resetParticipantRouteLimits('noisy-researcher');
      resetParticipantRouteLimits('quiet-researcher');
    });

    it('spends no budget on requests that never got past auth', async () => {
      const anonymous = express();
      anonymous.use(express.json());
      anonymous.use('/api/opportunities', opportunitiesRouter);
      anonymous.use(errorHandler);

      const codes = await fire(anonymous, '/api/opportunities/opp-1/survey-results', 70);

      // Every one is a 401, and none reached the limiter - which is why it is
      // mounted AFTER the auth middleware. Mounted before, an unauthenticated
      // flood would fill a bucket and lock out the real caller.
      expect(codes.every((code) => code === 401)).toBe(true);
      expect((await request(listening(app)).get('/api/opportunities/opp-1/survey-results')).status).not.toBe(429);
    });
  });

  describe('GET /api/opportunities/:id/analytics', () => {
    // Query order the route issues once ownership passes: overall totals,
    // per-click-type totals (view/action), daily breakdown, hourly breakdown,
    // weekday breakdown, previous-7-days count (for week-over-week).
    const queueFullAnalyticsMocks = () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'test-user-id', created_at: new Date('2026-01-01T00:00:00.000Z') }]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          total: 8,
          unique_users: 5,
          count_24h: 2,
          count_7d: 6,
          first_click: new Date('2026-07-01T10:00:00.000Z'),
          last_click: new Date('2026-07-15T09:30:00.000Z')
        }]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [
          { click_type: 'view', total: 5, unique_count: 4, count_24h: 1, count_7d: 4 },
          { click_type: 'action', total: 3, unique_count: 2, count_24h: 1, count_7d: 2 }
        ]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [
          { date: new Date('2026-07-14T00:00:00.000Z'), count: 5, views: 3, actions: 2 },
          { date: new Date('2026-07-15T00:00:00.000Z'), count: 3, views: 2, actions: 1 }
        ]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [
          { hour: 9, count: 5 },
          { hour: 14, count: 3 }
        ]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [
          { weekday_num: 2, count: 5 },
          { weekday_num: 3, count: 3 }
        ]
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 4 }] });
    };

    const queueAnalyticsMocksWithDailyRows = (dailyRows: unknown[]) => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'test-user-id', created_at: new Date('2026-01-01T00:00:00.000Z') }]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          total: 8, unique_users: 5, count_24h: 2, count_7d: 6,
          first_click: new Date('2026-08-16T11:30:00.000Z'),
          last_click: new Date('2026-08-16T11:58:00.000Z')
        }]
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: dailyRows });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 4 }] });
    };

    it('should return the full analytics breakdown for the opportunity owner', async () => {
      queueFullAnalyticsMocks();

      const response = await request(listening(app))
        .get('/api/opportunities/1/analytics')
        .expect(200);

      expect(response.body).toMatchObject({
        clicks_total: 8,
        clicks_24h: 2,
        clicks_7d: 6,
        unique_users: 5,
        avg_clicks_per_day: 0.3,
        week_over_week_change: 50,

        views_total: 5,
        views_24h: 1,
        views_7d: 4,
        unique_viewers: 4,

        actions_total: 3,
        actions_24h: 1,
        actions_7d: 2,
        unique_actors: 2,

        conversion_rate: 60,

        first_click: '2026-07-01T10:00:00.000Z',
        last_click: '2026-07-15T09:30:00.000Z',
        opportunity_created: '2026-01-01T00:00:00.000Z',

        period: 30
      });

      expect(response.body.clicks_by_day).toEqual([
        { date: '2026-07-14', count: 5, views: 3, actions: 2 },
        { date: '2026-07-15', count: 3, views: 2, actions: 1 }
      ]);
      expect(response.body.peak_day).toEqual({ date: '2026-07-14', count: 5, views: 3, actions: 2 });

      expect(response.body.clicks_by_hour).toHaveLength(24);
      expect(response.body.clicks_by_hour[9]).toEqual({ hour: 9, count: 5 });
      expect(response.body.clicks_by_hour[14]).toEqual({ hour: 14, count: 3 });
      expect(response.body.clicks_by_hour[0]).toEqual({ hour: 0, count: 0 });
      expect(response.body.peak_hour).toEqual({ hour: 9, hour_label: '9:00', count: 5 });

      expect(response.body.clicks_by_weekday).toHaveLength(7);
      expect(response.body.clicks_by_weekday[2]).toEqual({ weekday: 'Tuesday', weekday_num: 2, count: 5 });
      expect(response.body.clicks_by_weekday[3]).toEqual({ weekday: 'Wednesday', weekday_num: 3, count: 3 });
      expect(response.body.clicks_by_weekday[0]).toEqual({ weekday: 'Sunday', weekday_num: 0, count: 0 });
    });

    it('should default the period to 30 days and echo a valid requested period back', async () => {
      queueFullAnalyticsMocks();

      const response = await request(listening(app))
        .get('/api/opportunities/1/analytics')
        .expect(200);

      expect(response.body.period).toBe(30);

      mockQuery.mockClear();
      queueFullAnalyticsMocks();

      const response7d = await request(listening(app))
        .get('/api/opportunities/1/analytics?period=7')
        .expect(200);

      expect(response7d.body.period).toBe(7);
    });

    it('should fall back to 30 days for an invalid period value', async () => {
      queueFullAnalyticsMocks();

      const response = await request(listening(app))
        .get('/api/opportunities/1/analytics?period=99')
        .expect(200);

      expect(response.body.period).toBe(30);
    });

    it('should return zeroed stats, null peaks, and empty series when there are no clicks', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'test-user-id', created_at: new Date('2026-01-01T00:00:00.000Z') }]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ total: 0, unique_users: 0, count_24h: 0, count_7d: 0, first_click: null, last_click: null }]
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // no view/action rows
      mockQuery.mockResolvedValueOnce({ rows: [] }); // no daily rows
      mockQuery.mockResolvedValueOnce({ rows: [] }); // no hourly rows
      mockQuery.mockResolvedValueOnce({ rows: [] }); // no weekday rows
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] }); // no prior week

      const response = await request(listening(app))
        .get('/api/opportunities/1/analytics')
        .expect(200);

      expect(response.body).toMatchObject({
        clicks_total: 0,
        views_total: 0,
        actions_total: 0,
        conversion_rate: 0,
        avg_clicks_per_day: 0,
        // Null, not 0. Zero reads as "flat" - a measurement - when there is no
        // previous week to have measured anything against.
        week_over_week_change: null,
        first_click: null,
        last_click: null,
        peak_day: null,
        peak_hour: null,
        clicks_by_day: [],
        period_clicks_total: 0,
        period_views_total: 0,
        period_actions_total: 0
      });
      expect(response.body.clicks_by_hour).toHaveLength(24);
      expect(response.body.clicks_by_hour.every((h: { count: number }) => h.count === 0)).toBe(true);
      expect(response.body.clicks_by_weekday).toHaveLength(7);
    });

    it('cuts days, hours and weekdays in the analytics zone rather than the database session zone', async () => {
      // The bucketing has to happen where the data is. `DATE(clicked_at)` cut
      // the day in the DB session's zone - UTC everywhere Cortex runs - so a
      // click at 00:30 London on the 17th landed in the 16th, and the reverse
      // at the other end of the day.
      queueFullAnalyticsMocks();

      await request(listening(app)).get('/api/opportunities/1/analytics').expect(200);

      const sql: string[] = mockQuery.mock.calls.map((call: unknown[]) => String(call[0]));
      const daily = sql.find((q: string) => q.includes('AS date'));
      const hourly = sql.find((q: string) => q.includes('AS hour'));
      const weekday = sql.find((q: string) => q.includes('AS weekday_num'));

      // Every bucketing query, not just the one that was reported.
      expect(daily).toBeDefined();
      expect(hourly).toBeDefined();
      expect(weekday).toBeDefined();
      expect(daily).toContain('AT TIME ZONE');
      expect(hourly).toContain('AT TIME ZONE');
      expect(weekday).toContain('AT TIME ZONE');

      // ...and the zone is passed as a parameter, not interpolated.
      const dailyCall = mockQuery.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('AS date')
      );
      expect(dailyCall?.[1]).toContain('Europe/London');
    });

    it('returns the day as text, so nothing downstream re-reads it as an instant', async () => {
      // A `date` column arrives in JS as LOCAL midnight; reading that back in
      // UTC is the previous day in any positive offset. Casting in SQL removes
      // the round trip that lost the day.
      queueFullAnalyticsMocks();

      await request(listening(app)).get('/api/opportunities/1/analytics').expect(200);

      const daily = mockQuery.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .find((q: string) => q.includes('AS date'));
      expect(daily).toContain('to_char');
      expect(daily).not.toMatch(/DATE\(clicked_at\)/);
      // The PROJECTED column, specifically. Asserting only that the query
      // mentions AT TIME ZONE somewhere let a mutation strip it from the SELECT
      // and survive on the GROUP BY, which would have returned UTC days under a
      // query that still looked zone-aware.
      expect(daily).toMatch(/to_char\(\s*clicked_at AT TIME ZONE/);
      expect(daily).not.toMatch(/to_char\(\s*clicked_at\s*,/);
    });

    it('keeps the calendar day it was given, even if the driver hands back a Date', async () => {
      queueAnalyticsMocksWithDailyRows([
        { date: new Date(2026, 7, 16, 0, 0, 0), count: 2, views: 2, actions: 0 }
      ]);

      const response = await request(listening(app)).get('/api/opportunities/1/analytics').expect(200);

      expect(response.body.clicks_by_day).toEqual([
        { date: '2026-08-16', count: 2, views: 2, actions: 0 }
      ]);
      expect(response.body.peak_day).toMatchObject({ date: '2026-08-16' });
    });

    it('totals the selected period, not a fixed seven days', async () => {
      queueAnalyticsMocksWithDailyRows([
        { date: '2026-08-01', count: 4, views: 3, actions: 1 },
        { date: '2026-08-16', count: 6, views: 4, actions: 2 }
      ]);

      const response = await request(listening(app)).get('/api/opportunities/1/analytics?period=30').expect(200);

      expect(response.body.period_clicks_total).toBe(10);
      expect(response.body.period_views_total).toBe(7);
      expect(response.body.period_actions_total).toBe(3);
    });

    it('names the zone its buckets were cut in', async () => {
      queueFullAnalyticsMocks();
      const response = await request(listening(app)).get('/api/opportunities/1/analytics').expect(200);
      expect(response.body.time_zone).toBe('Europe/London');
    });

    it('should reject a non-owner, non-superadmin user with 403', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'different-user-id', created_at: new Date('2026-01-01T00:00:00.000Z') }]
      });

      const response = await request(listening(app))
        .get('/api/opportunities/1/analytics')
        .expect(403);

      expect(response.body.error).toBe('Only the study owner can view analytics');
    });

    it('should return 404 for a missing opportunity', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(listening(app))
        .get('/api/opportunities/1/analytics')
        .expect(404);

      expect(response.body.error).toContain('not found');
    });

    it('should return zeroed defaults for every field when the database is unavailable', async () => {
      mockIsDatabaseAvailable.mockResolvedValueOnce(false);

      const response = await request(listening(app))
        .get('/api/opportunities/1/analytics?period=14')
        .expect(200);

      expect(response.body).toEqual({
        clicks_total: 0,
        clicks_24h: 0,
        clicks_7d: 0,
        unique_users: 0,
        avg_clicks_per_day: 0,
        // Matches the live path: there is no week-over-week figure to give.
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
        time_zone: 'Europe/London',
        period: 14
      });
    });

    it('should reject an unauthenticated request with 401', async () => {
      const response = await request(listening(unauthenticatedApp))
        .get('/api/opportunities/1/analytics')
        .expect(401);

      expect(response.body.error).toBe('Authentication required');
    });
  });

  describe('POST /api/opportunities/:id/click', () => {
    const publishedUnmoderated = { id: '1', type: 'unmoderated', status: 'published' };

    // The click INSERT is the query whose SQL targets opportunity_clicks.
    const findInsertCall = () =>
      mockQuery.mock.calls.find(
        ([sql]: [unknown]) =>
          typeof sql === 'string' && sql.includes('INSERT INTO opportunity_clicks')
      );

    it('persists click_type="view" so views are tracked separately from actions', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedUnmoderated] }); // opportunity lookup
      mockQuery.mockResolvedValueOnce({ rows: [] }); // click insert

      const response = await request(listening(app))
        .post('/api/opportunities/1/click')
        .send({ click_type: 'view' })
        .expect(200);

      expect(response.body).toEqual({ ok: true });

      const insertCall = findInsertCall();
      expect(insertCall).toBeDefined();
      expect(insertCall![0]).toContain('click_type');
      expect(insertCall![1]).toContain('view');
    });

    it('persists click_type="action" for action clicks', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedUnmoderated] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(listening(app))
        .post('/api/opportunities/1/click')
        .send({ click_type: 'action' })
        .expect(200);

      expect(findInsertCall()![1]).toContain('action');
    });

    it('defaults to click_type="action" when the body omits it', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedUnmoderated] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(listening(app))
        .post('/api/opportunities/1/click')
        .expect(200);

      expect(findInsertCall()![1]).toContain('action');
    });

    it('rejects an invalid click_type without touching the database', async () => {
      const response = await request(listening(app))
        .post('/api/opportunities/1/click')
        .send({ click_type: 'bogus' })
        .expect(400);

      expect(response.body.error).toContain('click_type');
      expect(findInsertCall()).toBeUndefined();
    });

    // #125: the visitor_nonce is persisted so anonymous distinct counts survive
    // the proxy. The INSERT params order is [opp, user, clickType, ua, ipHash,
    // visitorNonce], so params[5] is the nonce.
    it('persists a valid visitor_nonce on the click row', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedUnmoderated] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(listening(app))
        .post('/api/opportunities/1/click')
        .send({ click_type: 'view', visitor_nonce: 'abcd1234-EF_90' })
        .expect(200);

      const insertCall = findInsertCall();
      expect(insertCall![0]).toContain('visitor_nonce');
      expect(insertCall![1][5]).toBe('abcd1234-EF_90');
    });

    it('stores null for a malformed visitor_nonce rather than rejecting the click', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedUnmoderated] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      // Too short (< 8 chars) and an out-of-charset char: degrade to ip_hash, do
      // not 400 - tracking must never fail on a hostile or stale client value.
      await request(listening(app))
        .post('/api/opportunities/1/click')
        .send({ click_type: 'action', visitor_nonce: 'no spaces!' })
        .expect(200);

      expect(findInsertCall()![1][5]).toBeNull();
    });

    it('stores null when the body omits visitor_nonce', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedUnmoderated] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(listening(app))
        .post('/api/opportunities/1/click')
        .send({ click_type: 'view' })
        .expect(200);

      expect(findInsertCall()![1][5]).toBeNull();
    });
  });

  // GET / and GET /:id are optionalAuth by design - anonymous participants land
  // on published opportunities. The owner's identity (owner_user_id, owner_name,
  // owner_email) is an admin-surface concern only: the participant landing page
  // renders none of it, so the public serializer must strip all three.
  describe('public opportunity serializer', () => {
    const publishedRow = {
      id: '1',
      type: 'unmoderated',
      title: 'Published study',
      purpose_one_liner: 'A valid purpose line for participants',
      default_duration_minutes: 30,
      status: 'published',
      owner_user_id: 'owner-user-id',
      firsthand_study_id: 'study_abc123',
      created_at: new Date(),
      updated_at: new Date(),
      owner_name: 'Owner Name',
      owner_email: 'owner@example.com'
    };

    // Authenticated but non-admin - sees published studies, not owner identity
    const employeeApp = express();
    employeeApp.use(express.json());
    employeeApp.use((req: any, res, next) => {
      req.session = {
        user: {
          id: 'employee-id',
          name: 'Employee User',
          email: 'employee@example.com',
          role: 'employee'
        }
      };
      next();
    });
    employeeApp.use('/api/opportunities', opportunitiesRouter);
    employeeApp.use(errorHandler);

    it('strips owner fields from GET /:id for anonymous participants', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedRow] }); // opportunity lookup
      mockQuery.mockResolvedValueOnce({ rows: [] }); // sessions

      const response = await request(listening(unauthenticatedApp))
        .get('/api/opportunities/1')
        .expect(200);

      expect(response.body).not.toHaveProperty('owner_user_id');
      expect(response.body).not.toHaveProperty('owner_name');
      expect(response.body).not.toHaveProperty('owner_email');
      // Participant-facing fields survive the strip
      expect(response.body).toMatchObject({
        id: '1',
        type: 'unmoderated',
        title: 'Published study',
        firsthand_study_id: 'study_abc123',
        sessions: []
      });
    });

    it('strips owner fields from GET /:id for authenticated non-admin users', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedRow] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(listening(employeeApp))
        .get('/api/opportunities/1')
        .expect(200);

      expect(response.body).not.toHaveProperty('owner_user_id');
      expect(response.body).not.toHaveProperty('owner_name');
      expect(response.body).not.toHaveProperty('owner_email');
    });

    // The routes select `s.*`, so the session joining link was going out to
    // anyone who could name a published opportunity id, with no login at all.
    // It is closer to a credential than a detail - holding a Zoom or Meet link
    // is usually the whole of what you need to walk into the call.
    const sessionRow = {
      id: 'sess-1',
      opportunity_id: '1',
      start_time: new Date('2026-09-01T10:00:00.000Z'),
      end_time: new Date('2026-09-01T11:00:00.000Z'),
      capacity: 3,
      actual_booked_count: 0,
      // The route calls .toISOString() on all four of these, so a fixture
      // missing created_at/updated_at 500s rather than failing the assertion.
      created_at: new Date('2026-08-01T00:00:00.000Z'),
      updated_at: new Date('2026-08-01T00:00:00.000Z'),
      location_or_meet_link_optional: 'https://meet.google.com/abc-defg-hij'
    };

    it('strips the session joining link from GET /:id for anonymous participants', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedRow] });
      mockQuery.mockResolvedValueOnce({ rows: [sessionRow] });

      const response = await request(listening(unauthenticatedApp))
        .get('/api/opportunities/1')
        .expect(200);

      expect(response.body.sessions).toHaveLength(1);
      expect(response.body.sessions[0]).not.toHaveProperty('location_or_meet_link_optional');
      // Asserted on the value as well, so renaming the column cannot quietly
      // turn the property check above into a tautology.
      expect(JSON.stringify(response.body)).not.toContain('meet.google.com');
      // The rest of the session still has to reach the participant, or they
      // cannot see what they are booking.
      // The whole participant-visible shape, not a token field or two: adding
      // any of these to the destructure in toPublicSession would otherwise pass
      // every test, and `remaining` is what drives the spots-left display and
      // whether Book is enabled at all.
      expect(response.body.sessions[0]).toMatchObject({
        id: 'sess-1',
        capacity: 3,
        booked_count: 0,
        remaining: 3,
        start_time: '2026-09-01T10:00:00.000Z',
        end_time: '2026-09-01T11:00:00.000Z'
      });
    });

    it('strips the session joining link from GET /:id for authenticated non-admins', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedRow] });
      mockQuery.mockResolvedValueOnce({ rows: [sessionRow] });

      const response = await request(listening(employeeApp))
        .get('/api/opportunities/1')
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain('meet.google.com');
    });

    // GET /:id/sessions is the second door, and it stayed open through the
    // first version of this fix: it is optionalAuth, selects s.* and returns
    // bare session rows, so it never went near the opportunity serializer.
    // Both gates found it independently. The opportunity id is not a secret
    // either - GET / lists every published one to anonymous callers - so this
    // was one enumeration plus one request away from every joining link.
    it('strips the joining link from GET /:id/sessions for anonymous participants', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedRow] }); // opportunity access check
      mockQuery.mockResolvedValueOnce({ rows: [sessionRow] });   // sessions

      const response = await request(listening(unauthenticatedApp))
        .get('/api/opportunities/1/sessions')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).not.toHaveProperty('location_or_meet_link_optional');
      expect(JSON.stringify(response.body)).not.toContain('meet.google.com');
      expect(response.body[0]).toMatchObject({ id: 'sess-1', capacity: 3, remaining: 3 });
    });

    it('strips the joining link from GET /:id/sessions for authenticated non-admins', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedRow] });
      mockQuery.mockResolvedValueOnce({ rows: [sessionRow] });

      const response = await request(listening(employeeApp))
        .get('/api/opportunities/1/sessions')
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain('meet.google.com');
    });

    it('keeps the joining link on GET /:id/sessions for admins', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedRow] });
      mockQuery.mockResolvedValueOnce({ rows: [sessionRow] });

      const response = await request(listening(app))
        .get('/api/opportunities/1/sessions')
        .expect(200);

      // NOT optional, and the reason the strip is isAdmin-branched rather than
      // unconditional: OpportunityForm loads sessions from THIS endpoint when
      // editing (getSessions with include_past) and writes the location
      // straight back when it recreates them. Strip it for admins and every
      // session silently loses its location on the next edit.
      expect(response.body[0].location_or_meet_link_optional).toBe(
        'https://meet.google.com/abc-defg-hij'
      );
    });

    it('keeps the session joining link on GET /:id for admins', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedRow] });
      mockQuery.mockResolvedValueOnce({ rows: [sessionRow] });

      const response = await request(listening(app))
        .get('/api/opportunities/1')
        .expect(200);

      // Admins author it, and AdminSessionManager renders it.
      expect(response.body.sessions[0].location_or_meet_link_optional).toBe(
        'https://meet.google.com/abc-defg-hij'
      );
    });

    it('keeps owner fields on GET /:id for admins', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedRow] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(listening(app))
        .get('/api/opportunities/1')
        .expect(200);

      expect(response.body).toMatchObject({
        owner_user_id: 'owner-user-id',
        owner_name: 'Owner Name',
        owner_email: 'owner@example.com'
      });
    });

    // Row 3 of the Mav/Petra audit: a non-admin landing on a study that exists
    // but is not published must get an answer that names WHY - closed vs not
    // yet open - rather than the same 404 a genuinely-missing id gets. The
    // codes are what the participant page reads to pick its message and to drop
    // the dead Retry button, so they are pinned by name here.
    const closedRow = { ...publishedRow, status: 'closed' };
    const draftRow = { ...publishedRow, status: 'draft' };

    it('answers 410 OPPORTUNITY_CLOSED to a non-admin for a closed study', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [closedRow] });

      const response = await request(listening(employeeApp))
        .get('/api/opportunities/1')
        .expect(410);

      expect(response.body.code).toBe('OPPORTUNITY_CLOSED');
      // The sessions query must NOT have run - an unavailable study pays for one
      // read, not two. Only the opportunity lookup was queued above.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('answers 404 OPPORTUNITY_NOT_OPEN to a non-admin for a draft study', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [draftRow] });

      const response = await request(listening(employeeApp))
        .get('/api/opportunities/1')
        .expect(404);

      expect(response.body.code).toBe('OPPORTUNITY_NOT_OPEN');
      // No draft contents leak: only the reason is disclosed.
      expect(JSON.stringify(response.body)).not.toContain('Published study');
    });

    it('answers a plain 404 NOT_FOUND to a non-admin for a missing id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(listening(employeeApp))
        .get('/api/opportunities/1')
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('still serves a closed study to an admin at 200', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [closedRow] });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // sessions

      const response = await request(listening(app))
        .get('/api/opportunities/1')
        .expect(200);

      expect(response.body).toMatchObject({ id: '1', status: 'closed' });
    });

    it('strips owner fields from the GET / list for anonymous participants', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedRow] }); // opportunities query
      mockQuery.mockResolvedValueOnce({ rows: [] }); // sessions batch

      const response = await request(listening(unauthenticatedApp))
        .get('/api/opportunities')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).not.toHaveProperty('owner_user_id');
      expect(response.body[0]).not.toHaveProperty('owner_name');
      expect(response.body[0]).not.toHaveProperty('owner_email');
      expect(response.body[0]).toMatchObject({ id: '1', title: 'Published study' });
    });

    it('keeps owner fields on the GET / list for admins', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedRow] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(listening(app))
        .get('/api/opportunities')
        .expect(200);

      expect(response.body[0]).toMatchObject({
        owner_user_id: 'owner-user-id',
        owner_name: 'Owner Name',
        owner_email: 'owner@example.com'
      });
    });

    it('strips owner fields in mock-data mode too', async () => {
      // With the database unavailable both GET routes serve the in-memory demo
      // store, which carries the same owner fields - the strip must apply there
      // as well or demo deployments leak identities the same way. Seeded
      // explicitly rather than relying on whatever the store happens to hold,
      // which keeps this test independent of the demo fixtures. It originally
      // had to be seeded because a tracked stale demo/mock-data.js shadowed
      // mock-data.ts under jest; that file is deleted and gitignored now.
      mockIsDatabaseAvailable.mockResolvedValue(false);
      addMockOpportunity({
        id: 'mock-owner-strip',
        type: 'unmoderated',
        title: 'Mock published study',
        purpose_one_liner: 'A valid purpose line for participants',
        default_duration_minutes: 30,
        status: 'published',
        owner_user_id: 'admin-user-id',
        owner_name: 'Research Team',
        owner_email: 'research@adaptalabs.com',
        created_at: new Date(),
        updated_at: new Date(),
        sessions: []
      });

      try {
        const listResponse = await request(listening(unauthenticatedApp))
          .get('/api/opportunities')
          .expect(200);

        expect(listResponse.body.length).toBeGreaterThan(0);
        for (const opportunity of listResponse.body) {
          expect(opportunity).not.toHaveProperty('owner_user_id');
          expect(opportunity).not.toHaveProperty('owner_name');
          expect(opportunity).not.toHaveProperty('owner_email');
        }

        const detailResponse = await request(listening(unauthenticatedApp))
          .get('/api/opportunities/mock-owner-strip')
          .expect(200);

        expect(detailResponse.body).not.toHaveProperty('owner_user_id');
        expect(detailResponse.body).not.toHaveProperty('owner_name');
        expect(detailResponse.body).not.toHaveProperty('owner_email');
        expect(detailResponse.body).toMatchObject({
          id: 'mock-owner-strip',
          title: 'Mock published study'
        });
      } finally {
        // The demo store is module-level state shared across tests
        deleteMockOpportunity('mock-owner-strip');
      }
    });
  });
  // Pins the route-layer half of the database-outage fix. Without these, the
  // `if (error instanceof AppError) throw error` guards in the catch-alls can
  // be deleted and the rest of the suite still passes: the catch would flatten
  // the 503 to a generic 500 and the outage would look like an app bug.
  describe('database outage propagation', () => {
    const outage = () =>
      new AppError('Service temporarily unavailable', 503, 'DB_CONNECTION_FAILED');

    it('surfaces 503 and the code on GET / rather than flattening to 500', async () => {
      mockIsDatabaseAvailable.mockRejectedValue(outage());

      const response = await request(listening(app)).get('/api/opportunities');

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('DB_CONNECTION_FAILED');
    });

    // The whole point of the fix: an outage must never look like a success.
    it('never answers 200 with fixture data during an outage', async () => {
      mockIsDatabaseAvailable.mockRejectedValue(outage());

      const response = await request(listening(app)).get('/api/opportunities');

      expect(response.status).not.toBe(200);
      expect(Array.isArray(response.body)).toBe(false);
    });

    it('surfaces 503 on the sessions listing rather than 500', async () => {
      mockIsDatabaseAvailable.mockRejectedValue(outage());

      const response = await request(listening(app)).get('/api/opportunities/some-id/sessions');

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('DB_CONNECTION_FAILED');
    });

    // The two admin write routes have their own catch-alls. Without these two
    // cases their guards can be deleted individually with the suite still
    // green, even though removing all six is caught.
    it('surfaces 503 on POST /:id/sessions rather than 500', async () => {
      mockIsDatabaseAvailable.mockRejectedValue(outage());

      const response = await request(listening(app))
        .post('/api/opportunities/some-id/sessions')
        .send([{ start_time: '2026-08-01T10:00:00Z', end_time: '2026-08-01T11:00:00Z', capacity: 1 }]);

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('DB_CONNECTION_FAILED');
    });

    it('surfaces 503 on DELETE /:id/sessions rather than 500', async () => {
      mockIsDatabaseAvailable.mockRejectedValue(outage());

      const response = await request(listening(app)).delete('/api/opportunities/some-id/sessions');

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('DB_CONNECTION_FAILED');
    });

    it('leaks no driver detail in the outage body', async () => {
      mockIsDatabaseAvailable.mockRejectedValue(outage());

      const response = await request(listening(app)).get('/api/opportunities');

      expect(JSON.stringify(response.body)).not.toMatch(/password|postgres|ECONNREFUSED/i);
    });
  });
});
