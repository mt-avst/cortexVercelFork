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

jest.mock('../../utils/firsthand-client', () => ({
  isFirstHandConfigured: jest.fn(),
  firstHandPost: jest.fn(),
}));

import opportunitiesRouter from '../opportunities';
import { addMockOpportunity, deleteMockOpportunity } from '../../../../demo/mock-data';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { isFirstHandConfigured, firstHandPost } from '../../utils/firsthand-client';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as jest.MockedFunction<any>;
const mockConnect = pool.connect as jest.MockedFunction<any>;
const mockIsDatabaseAvailable = isDatabaseAvailable as jest.MockedFunction<any>;
const mockIsFirstHandConfigured = isFirstHandConfigured as jest.MockedFunction<any>;
const mockFirstHandPost = firstHandPost as jest.MockedFunction<any>;

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

    it('should require a FirstHand study to publish an unmoderated opportunity (A1)', async () => {
      const response = await request(app)
        .post('/api/opportunities')
        .send({
          type: 'unmoderated',
          title: 'Valid Unmoderated Title',
          purpose_one_liner: 'This is a valid purpose that meets the minimum length requirement',
          status: 'published'
          // Missing firsthand_study_id
        })
        .expect(400);

      expect(response.body.error).toBe(
        'A FirstHand study is required to publish an unmoderated test'
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

  describe('POST /api/opportunities/:id/firsthand-handoff', () => {
    it('should create a FirstHand session for an authenticated user', async () => {
      mockIsFirstHandConfigured.mockReturnValue(true);
      mockQuery.mockResolvedValueOnce({
        rows: [{ firsthand_study_id: 'study_abc123', status: 'published' }]
      });
      mockFirstHandPost.mockResolvedValueOnce({
        session_url: 'https://first-hand.vercel.app/session/xyz'
      });

      const response = await request(app)
        .post('/api/opportunities/1/firsthand-handoff')
        .expect(200);

      expect(response.body.session_url).toBe('https://first-hand.vercel.app/session/xyz');
      expect(mockFirstHandPost).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({
        study_id: 'study_abc123',
        participant: expect.objectContaining({ participant_id: 'test-user-id' })
      }));
    });

    it('should reject an unauthenticated request with 401', async () => {
      const response = await request(unauthenticatedApp)
        .post('/api/opportunities/1/firsthand-handoff')
        .expect(401);

      expect(response.body.error).toBe('Authentication required');
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
});
