import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

// Mock the database pool for testing (factory uses only inline jest.fn() to avoid TDZ)
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
jest.mock('../../firsthand/studies-repository', () => ({
  createStudy: jest.fn(),
  deleteStudy: jest.fn(),
  // Default true so the inline path runs; the route checks this before
  // building a study so a misconfigured runtime pool answers 503 rather than
  // letting createStudy throw a bare Error into the 500 branch.
  isStudiesPersistenceConfigured: jest.fn(() => true),
}));

import opportunitiesRouter from '../opportunities';
import { addMockOpportunity, deleteMockOpportunity } from '../../../../demo/mock-data';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { createSession } from '../../firsthand/session-create';
import { createStudy, deleteStudy, isStudiesPersistenceConfigured } from '../../firsthand/studies-repository';
import { errorHandler, AppError } from '../../utils/errorHandler';

const mockQuery = pool.query as jest.MockedFunction<any>;
const mockConnect = pool.connect as jest.MockedFunction<any>;
const mockIsDatabaseAvailable = isDatabaseAvailable as jest.MockedFunction<any>;
const mockCreateSession = createSession as jest.MockedFunction<any>;
const mockCreateStudy = createStudy as jest.MockedFunction<any>;
const mockDeleteStudy = deleteStudy as jest.MockedFunction<any>;
const mockIsStudiesPersistenceConfigured = isStudiesPersistenceConfigured as jest.MockedFunction<any>;

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

      const response = await request(app)
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

      await request(app)
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

      await request(app)
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

      const response = await request(app)
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
      const response = await request(app)
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
      const response = await request(app)
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
      const response = await request(app)
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

    it('should require external link for published polls/surveys', async () => {
      const response = await request(app)
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
        'External link is required for published polls and surveys'
      );
    });

    it('should require a study to publish an unmoderated opportunity (A1)', async () => {
      const response = await request(app)
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
        'Add at least one prompt to the study, or link an existing recorded study, before publishing'
      );
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

      const response = await request(app)
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

        const response = await request(app)
          .post('/api/opportunities')
          .send(inlineBody)
          .expect(201);

        // Launched, not draft: a draft study cannot be selected, so an
        // opportunity pointing at one would be unrunnable.
        expect(mockCreateStudy).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'launched' })
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

        await request(app).post('/api/opportunities').send(inlineBody).expect(500);

        // Studies and opportunities sit on different pools, so this
        // compensating delete is the only thing preventing a launched study
        // that no opportunity references.
        expect(mockDeleteStudy).toHaveBeenCalledWith('study_orphan');
      });

      it('rejects a body carrying both a linked study and an authored one', async () => {
        // Resolving this by precedence silently discarded whichever lost, so
        // the ambiguity is refused instead.
        const response = await request(app)
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

        await request(app)
          .post('/api/opportunities')
          .send({ ...linkedOnly, firsthand_study_id: 'study_existing' })
          .expect(201);

        expect(mockCreateStudy).not.toHaveBeenCalled();
        expect(mockQuery.mock.calls[1][1][10]).toBe('study_existing');
      });

      it('refuses to publish on a whitespace-only study id instead of storing null', async () => {
        const { inline_study, ...linkedOnly } = inlineBody;

        const response = await request(app)
          .post('/api/opportunities')
          .send({ ...linkedOnly, firsthand_study_id: '   ' })
          .expect(400);

        expect(response.body.error).toBe(
          'Add at least one prompt to the study, or link an existing recorded study, before publishing'
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

        await request(app).post('/api/opportunities').send(inlineBody).expect(201);
        await request(app).post('/api/opportunities').send(inlineBody).expect(201);

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

        await request(app)
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
        const response = await request(app)
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
        const response = await request(app)
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
        await request(app)
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
        const response = await request(app)
          .post('/api/opportunities')
          .send({ ...inlineBody, type: 'poll', external_link_optional: 'https://example.com' })
          .expect(400);

        expect(response.body.error).toBe(
          'Only unmoderated opportunities can carry a study'
        );
        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('rejects a whitespace-only title rather than naming the study ""', async () => {
        // title and purpose_one_liner become the study's title and intro_text.
        // Validating them untrimmed let "    " satisfy min(4) and store '',
        // producing a study whose session payload cannot assemble.
        const response = await request(app)
          .post('/api/opportunities')
          .send({ ...inlineBody, title: '      ' })
          .expect(400);

        expect(response.body.error).toBe('Validation failed');
        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('rejects a whitespace-only purpose, which becomes the study intro', async () => {
        await request(app)
          .post('/api/opportunities')
          .send({ ...inlineBody, purpose_one_liner: '             ' })
          .expect(400);

        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('answers 503, not 500, when the studies pool is not configured', async () => {
        mockIsStudiesPersistenceConfigured.mockReturnValueOnce(false);

        await request(app).post('/api/opportunities').send(inlineBody).expect(503);

        expect(mockCreateStudy).not.toHaveBeenCalled();
      });

      it('rejects a choice step with fewer than two options', async () => {
        const response = await request(app)
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
    });

    it('should reject an unmoderated opportunity with an external participant type (M2)', async () => {
      const response = await request(app)
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

      await request(app)
        .patch('/api/opportunities/1')
        .send({ status: 'published', inline_study: inlineStudy })
        .expect(200);

      expect(mockCreateStudy).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'launched' })
      );
      // Inherits the opportunity's own title rather than a placeholder, which
      // needs title/purpose in the existing-row SELECT.
      expect(mockCreateStudy.mock.calls[0][0].title).toBe('Existing title');

      // The generated id reaches the UPDATE, and inline_study never becomes a
      // column name in it.
      const updateSql = mockQuery.mock.calls[2][0];
      expect(updateSql).toContain('firsthand_study_id');
      expect(updateSql).not.toContain('inline_study');
      expect(mockQuery.mock.calls[2][1]).toContain('study_from_edit');
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

      await request(app)
        .patch('/api/opportunities/1')
        .send({ inline_study: inlineStudy })
        .expect(200);

      const created = mockCreateStudy.mock.calls[0][0];
      expect(created.title).toBe('Untitled study');
      expect(created.intro_text).toBe('Recorded study');
    });

    it('refuses to author over an opportunity that already has a study', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [existingUnmoderated('study_already_linked')]
      });

      const response = await request(app)
        .patch('/api/opportunities/1')
        .send({ inline_study: inlineStudy })
        .expect(400);

      expect(response.body.error).toBe(
        'This opportunity already has a recorded study; edit its tasks in the studies area'
      );
      expect(mockCreateStudy).not.toHaveBeenCalled();
    });

    it('refuses to author over a linked study even when the request nulls the link', async () => {
      // firsthand_study_id is nullable on the update schema, and null?.trim()
      // is falsy - so checking only the merged value let a caller clear the
      // link and author a replacement in one request, orphaning the study a
      // live opportunity was running.
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [existingUnmoderated('study_already_linked')]
      });

      const response = await request(app)
        .patch('/api/opportunities/1')
        .send({ firsthand_study_id: null, inline_study: inlineStudy })
        .expect(400);

      expect(response.body.error).toBe(
        'This opportunity already has a recorded study; edit its tasks in the studies area'
      );
      expect(mockCreateStudy).not.toHaveBeenCalled();
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

      await request(app)
        .patch('/api/opportunities/1')
        .send({ inline_study: inlineStudy })
        .expect(404);

      expect(mockDeleteStudy).toHaveBeenCalledWith('study_raced');
    });

    it('will not let a published unmoderated opportunity have its study cleared', async () => {
      // The guard used to fire only when the request itself set status, so
      // clearing the link on an already-published opportunity left it live with
      // no study - the very state the guard exists to prevent.
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [existingUnmoderated('study_live', 'published')]
      });

      const response = await request(app)
        .patch('/api/opportunities/1')
        .send({ firsthand_study_id: null })
        .expect(400);

      // Names what this caller is actually doing - they are removing a study,
      // not failing to publish one.
      expect(response.body.error).toBe(
        'A published unmoderated test cannot have its recorded study removed; unpublish it first'
      );
    });

    it('answers 404, not 500, when the opportunity vanishes before the type read', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      // Deleted between the ownership check and the existing-row lookup: the
      // row access used to throw a TypeError straight into the 500 branch.
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(app)
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

      await request(app)
        .patch('/api/opportunities/1')
        .send({ participant_type_required: 'any' })
        .expect(200);
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

      const response = await request(app)
        .patch('/api/opportunities/1')
        .send({ type: 'poll' })
        .expect(400);

      expect(response.body.error).toBe(
        'External link is required for published polls and surveys'
      );
    });

    it('says "not both" rather than "already has one" when neither is stored', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated(null)] });

      const response = await request(app)
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

      await request(app)
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

      await request(app)
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

      await request(app)
        .patch('/api/opportunities/1')
        .send({ inline_study: inlineStudy })
        .expect(500);

      expect(mockDeleteStudy).toHaveBeenCalledWith('study_orphan_patch');
    });

    it('still blocks publishing an unmoderated opportunity with neither route', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ owner_user_id: 'test-user-id' }] });
      mockQuery.mockResolvedValueOnce({ rows: [existingUnmoderated(null)] });

      const response = await request(app)
        .patch('/api/opportunities/1')
        .send({ status: 'published' })
        .expect(400);

      expect(response.body.error).toBe(
        'Add at least one prompt to the study, or link an existing recorded study, before publishing'
      );
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

      // 3. The actual UPDATE ... RETURNING *
      mockQuery.mockResolvedValueOnce({ rows: [updatedOpportunity] });

      const response = await request(app)
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

      const response = await request(app)
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

      const response = await request(app)
        .patch('/api/opportunities/1')
        .send({
          title: 'Updated Title'
        })
        .expect(403);

      expect(response.body.error).toBe('Only the owner can edit this opportunity');
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

      await request(app)
        .delete('/api/opportunities/1')
        .expect(204);
    });

    it('should check ownership before delete', async () => {
      // Mock ownership check - different owner
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'different-user-id' }]
      });

      const response = await request(app)
        .delete('/api/opportunities/1')
        .expect(403);

      expect(response.body.error).toBe('Only the owner can delete this opportunity');
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

      const response = await request(app)
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

      const response = await request(app)
        .post('/api/opportunities/1/duplicate')
        .expect(403);

      expect(response.body.error).toBe('Only the owner can duplicate this opportunity');
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

      const response = await request(app)
        .post('/api/opportunities/1/close-if-past')
        .expect(200);

      expect(response.body).toEqual({ message: 'Opportunity auto-close check completed' });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE opportunities'),
        ['closed', '1']
      );
    });

    it('should check ownership before closing', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'different-user-id' }]
      });

      const response = await request(app)
        .post('/api/opportunities/1/close-if-past')
        .expect(403);

      expect(response.body.error).toBe('Only the owner can close this opportunity');
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

  describe('POST /api/opportunities/:id/recorded-study-session', () => {
    it('mints an in-process session and returns a same-origin URL', async () => {
      process.env.FRONTEND_URL = 'https://cortex.example.com';
      mockQuery.mockResolvedValueOnce({
        rows: [{ firsthand_study_id: 'study_abc123', status: 'published' }]
      });
      mockCreateSession.mockResolvedValueOnce({
        ok: true,
        session: { session_id: 'session_x', session_token: 'fh_tok', expires_at: '2026-07-22T00:00:00.000Z' }
      });

      const response = await request(app)
        .post('/api/opportunities/1/recorded-study-session')
        .expect(200);

      expect(response.body.session_url).toBe('https://cortex.example.com/session/fh_tok');
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        studyId: 'study_abc123',
        participant: expect.objectContaining({ participant_id: 'test-user-id', external_ref: '1' })
      }));
    });

    it('should reject an unauthenticated request with 401', async () => {
      const response = await request(unauthenticatedApp)
        .post('/api/opportunities/1/recorded-study-session')
        .expect(401);

      expect(response.body.error).toBe('Authentication required');
    });

    it('maps a study-without-steps result to 400', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ firsthand_study_id: 'study_abc123', status: 'published' }]
      });
      mockCreateSession.mockResolvedValueOnce({ ok: false, error: 'study_has_no_steps' });

      const response = await request(app)
        .post('/api/opportunities/1/recorded-study-session')
        .expect(400);
      expect(response.body.error).toBe('Linked recorded study has no steps');
    });

    it.each([
      ['persistence_not_configured', 503, 'Recorded-study sessions are not available'],
      ['study_not_found', 404, 'Linked recorded study not found'],
    ])('maps createSession error %s to HTTP %i', async (error, status, message) => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ firsthand_study_id: 'study_abc123', status: 'published' }]
      });
      mockCreateSession.mockResolvedValueOnce({ ok: false, error });

      const response = await request(app)
        .post('/api/opportunities/1/recorded-study-session')
        .expect(status);
      expect(response.body.error).toBe(message);
      // Participant-visible bodies must not leak the internal product name
      expect(JSON.stringify(response.body)).not.toMatch(/firsthand/i);
    });

    it('maps payload_assembly_failed to a 500 with a neutral error code', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ firsthand_study_id: 'study_abc123', status: 'published' }]
      });
      mockCreateSession.mockResolvedValueOnce({ ok: false, error: 'payload_assembly_failed' });

      const response = await request(app)
        .post('/api/opportunities/1/recorded-study-session')
        .expect(500);
      expect(response.body.error).toBe('Failed to assemble the recorded-study session');
      expect(response.body.code).toBe('SESSION_ASSEMBLY_FAILED');
      // Participant-visible bodies must not leak the internal product name
      expect(JSON.stringify(response.body)).not.toMatch(/firsthand/i);
    });

    it('maps an unmodelled createSession error through the default branch without leaking the raw value', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ firsthand_study_id: 'study_abc123', status: 'published' }]
      });
      // A value outside the CreateSessionError union drives the exhaustiveness
      // guard. Its message must be static, not the interpolated raw value.
      mockCreateSession.mockResolvedValueOnce({ ok: false, error: 'firsthand.runtime_sessions boom' });

      const response = await request(app)
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
        rows: [{ firsthand_study_id: 'study_abc123', status: 'published' }]
      });
      mockCreateSession.mockResolvedValueOnce({
        ok: true,
        session: { session_id: 'session_x', session_token: 'fh_tok', expires_at: '2026-07-22T00:00:00.000Z' }
      });

      const response = await request(app)
        .post('/api/opportunities/1/firsthand-handoff')
        .expect(200);

      expect(response.body.session_url).toBe('https://cortex.example.com/session/fh_tok');
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

      const response = await request(app)
        .get('/api/opportunities/1/session-events')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].event_type).toBe('session.completed');
    });

    it('should reject an unauthenticated request with 401', async () => {
      const response = await request(unauthenticatedApp)
        .get('/api/opportunities/1/session-events')
        .expect(401);

      expect(response.body.error).toBe('Authentication required');
    });

    it('should reject an admin who does not own the opportunity with 403', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'different-user-id' }]
      });

      const response = await request(app)
        .get('/api/opportunities/1/session-events')
        .expect(403);

      expect(response.body.error).toBe('Only the opportunity owner can view session events');
    });

    it('should return 404 when the opportunity does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(app)
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

      const response = await request(superadminApp)
        .get('/api/opportunities/1/session-events')
        .expect(200);

      expect(response.body).toHaveLength(1);
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

    it('should return the full analytics breakdown for the opportunity owner', async () => {
      queueFullAnalyticsMocks();

      const response = await request(app)
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

      const response = await request(app)
        .get('/api/opportunities/1/analytics')
        .expect(200);

      expect(response.body.period).toBe(30);

      mockQuery.mockClear();
      queueFullAnalyticsMocks();

      const response7d = await request(app)
        .get('/api/opportunities/1/analytics?period=7')
        .expect(200);

      expect(response7d.body.period).toBe(7);
    });

    it('should fall back to 30 days for an invalid period value', async () => {
      queueFullAnalyticsMocks();

      const response = await request(app)
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

      const response = await request(app)
        .get('/api/opportunities/1/analytics')
        .expect(200);

      expect(response.body).toMatchObject({
        clicks_total: 0,
        views_total: 0,
        actions_total: 0,
        conversion_rate: 0,
        avg_clicks_per_day: 0,
        week_over_week_change: 0,
        first_click: null,
        last_click: null,
        peak_day: null,
        peak_hour: null,
        clicks_by_day: []
      });
      expect(response.body.clicks_by_hour).toHaveLength(24);
      expect(response.body.clicks_by_hour.every((h: { count: number }) => h.count === 0)).toBe(true);
      expect(response.body.clicks_by_weekday).toHaveLength(7);
    });

    it('should reject a non-owner, non-superadmin user with 403', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ owner_user_id: 'different-user-id', created_at: new Date('2026-01-01T00:00:00.000Z') }]
      });

      const response = await request(app)
        .get('/api/opportunities/1/analytics')
        .expect(403);

      expect(response.body.error).toBe('Only the opportunity owner can view analytics');
    });

    it('should return 404 for a missing opportunity', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .get('/api/opportunities/1/analytics')
        .expect(404);

      expect(response.body.error).toContain('not found');
    });

    it('should return zeroed defaults for every field when the database is unavailable', async () => {
      mockIsDatabaseAvailable.mockResolvedValueOnce(false);

      const response = await request(app)
        .get('/api/opportunities/1/analytics?period=14')
        .expect(200);

      expect(response.body).toEqual({
        clicks_total: 0,
        clicks_24h: 0,
        clicks_7d: 0,
        unique_users: 0,
        avg_clicks_per_day: 0,
        week_over_week_change: 0,
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
        period: 14
      });
    });

    it('should reject an unauthenticated request with 401', async () => {
      const response = await request(unauthenticatedApp)
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

      const response = await request(app)
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

      await request(app)
        .post('/api/opportunities/1/click')
        .send({ click_type: 'action' })
        .expect(200);

      expect(findInsertCall()![1]).toContain('action');
    });

    it('defaults to click_type="action" when the body omits it', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedUnmoderated] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(app)
        .post('/api/opportunities/1/click')
        .expect(200);

      expect(findInsertCall()![1]).toContain('action');
    });

    it('rejects an invalid click_type without touching the database', async () => {
      const response = await request(app)
        .post('/api/opportunities/1/click')
        .send({ click_type: 'bogus' })
        .expect(400);

      expect(response.body.error).toContain('click_type');
      expect(findInsertCall()).toBeUndefined();
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

      const response = await request(unauthenticatedApp)
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

      const response = await request(employeeApp)
        .get('/api/opportunities/1')
        .expect(200);

      expect(response.body).not.toHaveProperty('owner_user_id');
      expect(response.body).not.toHaveProperty('owner_name');
      expect(response.body).not.toHaveProperty('owner_email');
    });

    it('keeps owner fields on GET /:id for admins', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedRow] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .get('/api/opportunities/1')
        .expect(200);

      expect(response.body).toMatchObject({
        owner_user_id: 'owner-user-id',
        owner_name: 'Owner Name',
        owner_email: 'owner@example.com'
      });
    });

    it('strips owner fields from the GET / list for anonymous participants', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [publishedRow] }); // opportunities query
      mockQuery.mockResolvedValueOnce({ rows: [] }); // sessions batch

      const response = await request(unauthenticatedApp)
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

      const response = await request(app)
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
      // explicitly because under jest the tracked stale demo/mock-data.js
      // shadows mock-data.ts and its store starts empty.
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
        const listResponse = await request(unauthenticatedApp)
          .get('/api/opportunities')
          .expect(200);

        expect(listResponse.body.length).toBeGreaterThan(0);
        for (const opportunity of listResponse.body) {
          expect(opportunity).not.toHaveProperty('owner_user_id');
          expect(opportunity).not.toHaveProperty('owner_name');
          expect(opportunity).not.toHaveProperty('owner_email');
        }

        const detailResponse = await request(unauthenticatedApp)
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

      const response = await request(app).get('/api/opportunities');

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('DB_CONNECTION_FAILED');
    });

    // The whole point of the fix: an outage must never look like a success.
    it('never answers 200 with fixture data during an outage', async () => {
      mockIsDatabaseAvailable.mockRejectedValue(outage());

      const response = await request(app).get('/api/opportunities');

      expect(response.status).not.toBe(200);
      expect(Array.isArray(response.body)).toBe(false);
    });

    it('surfaces 503 on the sessions listing rather than 500', async () => {
      mockIsDatabaseAvailable.mockRejectedValue(outage());

      const response = await request(app).get('/api/opportunities/some-id/sessions');

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('DB_CONNECTION_FAILED');
    });

    // The two admin write routes have their own catch-alls. Without these two
    // cases their guards can be deleted individually with the suite still
    // green, even though removing all six is caught.
    it('surfaces 503 on POST /:id/sessions rather than 500', async () => {
      mockIsDatabaseAvailable.mockRejectedValue(outage());

      const response = await request(app)
        .post('/api/opportunities/some-id/sessions')
        .send([{ start_time: '2026-08-01T10:00:00Z', end_time: '2026-08-01T11:00:00Z', capacity: 1 }]);

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('DB_CONNECTION_FAILED');
    });

    it('surfaces 503 on DELETE /:id/sessions rather than 500', async () => {
      mockIsDatabaseAvailable.mockRejectedValue(outage());

      const response = await request(app).delete('/api/opportunities/some-id/sessions');

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('DB_CONNECTION_FAILED');
    });

    it('leaks no driver detail in the outage body', async () => {
      mockIsDatabaseAvailable.mockRejectedValue(outage());

      const response = await request(app).get('/api/opportunities');

      expect(JSON.stringify(response.body)).not.toMatch(/password|postgres|ECONNREFUSED/i);
    });
  });
});
