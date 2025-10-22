import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import session from 'express-session';
import opportunitiesRouter from '../opportunities';
import { pool } from '../../config';

// Mock the database pool for testing
jest.mock('../../config', () => ({
  pool: {
    query: jest.fn() as any,
    connect: jest.fn() as any
  }
})) as any;

const app = express();
app.use(express.json());
app.use(session({
  secret: 'test-secret',
  resave: false,
  saveUninitialized: false
}));

// Mock authentication middleware
app.use((req, res, next) => {
  req.user = {
    id: 'test-user-id',
    name: 'Test User',
    email: 'test@example.com',
    business_unit: 'Engineering',
    role_title: 'Developer',
    role: 'researcher_admin'
  };
  next();
});

app.use('/api/opportunities', opportunitiesRouter);

describe('Opportunities API', () => {
  const mockQuery = pool.query as jest.MockedFunction<typeof pool.query>;

  beforeEach(() => {
    jest.clearAllMocks();
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

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('AND o.type = $2'),
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

      mockQuery.mockResolvedValueOnce({ rows: [newOpportunity] });

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
      const response = await request(app)
        .post('/api/opportunities')
        .send({
          type: 'test'
          // Missing title and purpose
        })
        .expect(400);

      expect(response.body.error).toBe('Type, title, and purpose are required');
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
      expect(response.body.details).toContain('Title must be between 4 and 140 characters');
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
      expect(response.body.details).toContain('Purpose must be between 10 and 180 characters');
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

      expect(response.body.error).toBe('External link is required for published polls and surveys');
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

      // Mock ownership check
      mockQuery.mockResolvedValueOnce({ 
        rows: [{ owner_user_id: 'test-user-id' }] 
      });
      
      // Mock update query
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
  });
});
