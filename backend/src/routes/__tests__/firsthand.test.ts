import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

// ─── Mocks (factories use only inline jest.fn() to avoid TDZ) ────────────────
jest.mock('../../config', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../firsthand/studies-repository', () => ({
  isStudiesPersistenceConfigured: jest.fn(),
  listStudies: jest.fn(),
  createStudy: jest.fn(),
  getStudyById: jest.fn(),
  updateStudy: jest.fn(),
  deleteStudy: jest.fn(),
}));
jest.mock('../../utils/database', () => ({ isDatabaseAvailable: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── Typed references to mocked functions ────────────────────────────────────
import firsthandRouter from '../firsthand';
import { pool } from '../../config';
import {
  isStudiesPersistenceConfigured,
  listStudies,
  createStudy,
  getStudyById,
  updateStudy,
  deleteStudy,
} from '../../firsthand/studies-repository';
import { isDatabaseAvailable } from '../../utils/database';

const mockQuery = (pool.query as jest.MockedFunction<typeof pool.query>);
const mockIsStudiesPersistenceConfigured = (isStudiesPersistenceConfigured as jest.MockedFunction<typeof isStudiesPersistenceConfigured>);
const mockListStudies = (listStudies as jest.MockedFunction<typeof listStudies>);
const mockCreateStudy = (createStudy as jest.MockedFunction<typeof createStudy>);
const mockGetStudyById = (getStudyById as jest.MockedFunction<typeof getStudyById>);
const mockUpdateStudy = (updateStudy as jest.MockedFunction<typeof updateStudy>);
const mockDeleteStudy = (deleteStudy as jest.MockedFunction<typeof deleteStudy>);
const mockIsDatabaseAvailable = (isDatabaseAvailable as jest.MockedFunction<typeof isDatabaseAvailable>);

// ─── Constants ────────────────────────────────────────────────────────────────
type SessionRole = 'researcher_admin' | 'superadmin' | 'employee';

// Build an app with an optional injected session user, so requireAdmin gating
// can be exercised for both the authorized and rejected paths.
function buildApp(user: { id: string; name: string; email: string; role: SessionRole } | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (user) {
      req.session = { user };
      req.user = user;
    } else {
      req.session = {};
    }
    next();
  });
  app.use('/api/firsthand', firsthandRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status || 500).json({ error: err.message || 'server_error' });
  });
  return app;
}

const adminUser = { id: 'admin-1', name: 'Admin', email: 'admin@test.com', role: 'researcher_admin' as const };
const app = buildApp(adminUser);

const validStudyBody = {
  title: 'Sample',
  intro_text: 'Intro',
  consent_text: 'Consent',
  brand_name: 'Adaptavist',
  estimated_duration_minutes: 12,
  locale: 'en-GB',
  steps: [
    { step_id: 'step_001', order: 1, type: 'instruction' as const, prompt: 'Talk through the page' },
    { step_id: 'step_end', order: 2, type: 'end' as const, prompt: 'Thanks' },
  ],
};

const storedStudy = {
  study: {
    id: 'study_abc',
    ...validStudyBody,
    status: 'draft' as const,
    created_at: '2026-06-08T00:00:00.000Z',
    updated_at: '2026-06-08T00:00:00.000Z',
  },
  steps: validStudyBody.steps,
};

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('FirstHand Express router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsStudiesPersistenceConfigured.mockReturnValue(true);
    mockIsDatabaseAvailable.mockResolvedValue(true);
    (mockQuery as any).mockResolvedValue({ rows: [] });
  });

  // ── Studies CRUD (B3a, in-process) ────────────────────────────────────────
  describe('GET /api/firsthand/studies', () => {
    it('returns the in-process study list', async () => {
      const studies = [{ id: 's-1', title: 'Usability Study', status: 'launched' }];
      (mockListStudies as any).mockResolvedValue(studies);
      const res = await request(app).get('/api/firsthand/studies').expect(200);
      expect(res.body).toEqual({ studies });
      expect(mockListStudies).toHaveBeenCalledTimes(1);
    });

    it('returns an empty list when persistence is unconfigured (repo soft-empty)', async () => {
      (mockListStudies as any).mockResolvedValue([]);
      const res = await request(app).get('/api/firsthand/studies').expect(200);
      expect(res.body).toEqual({ studies: [] });
    });

    it('propagates repository errors as 500', async () => {
      (mockListStudies as any).mockRejectedValue(new Error('db down'));
      await request(app).get('/api/firsthand/studies').expect(500);
    });
  });

  // ── H4: requireAdmin gating on EVERY studies route (reviewer OIDC dropped) ─
  // Every studies verb — including the destructive DELETE — must be gated, and
  // must reject before any persistence call. Table-driven so a future refactor
  // that drops requireAdmin from any one route fails CI.
  describe('studies authorization (requireAdmin)', () => {
    const guardedRoutes: Array<{ method: 'get' | 'post' | 'put' | 'delete'; path: string }> = [
      { method: 'get', path: '/api/firsthand/studies' },
      { method: 'post', path: '/api/firsthand/studies' },
      { method: 'get', path: '/api/firsthand/studies/study_abc' },
      { method: 'put', path: '/api/firsthand/studies/study_abc' },
      { method: 'delete', path: '/api/firsthand/studies/study_abc' },
    ];

    function fire(app: express.Express, method: string, path: string) {
      const req = (request(app) as any)[method](path);
      return method === 'post' || method === 'put'
        ? req.type('json').send(JSON.stringify(validStudyBody))
        : req;
    }

    function expectNoRepositoryCall() {
      expect(mockListStudies).not.toHaveBeenCalled();
      expect(mockCreateStudy).not.toHaveBeenCalled();
      expect(mockGetStudyById).not.toHaveBeenCalled();
      expect(mockUpdateStudy).not.toHaveBeenCalled();
      expect(mockDeleteStudy).not.toHaveBeenCalled();
    }

    it.each(guardedRoutes)('rejects unauthenticated $method $path with 401', async ({ method, path }) => {
      const anon = buildApp(null);
      const res = await fire(anon, method, path).expect(401);
      expect(res.body).toMatchObject({ error: 'Authentication required' });
      expectNoRepositoryCall();
    });

    it.each(guardedRoutes)('rejects non-admin (employee) $method $path with 403', async ({ method, path }) => {
      const employee = buildApp({ id: 'e-1', name: 'Emp', email: 'e@test.com', role: 'employee' });
      const res = await fire(employee, method, path).expect(403);
      expect(res.body).toMatchObject({ error: 'Admin access required' });
      expectNoRepositoryCall();
    });
  });

  describe('POST /api/firsthand/studies', () => {
    it('rejects invalid payloads with 400 invalid_payload', async () => {
      const res = await request(app)
        .post('/api/firsthand/studies')
        .type('json')
        .send(JSON.stringify({ title: 'Missing fields' }))
        .expect(400);
      expect(res.body.error).toBe('invalid_payload');
      expect(mockCreateStudy).not.toHaveBeenCalled();
    });

    it('creates a study when the payload is valid → 201', async () => {
      (mockCreateStudy as any).mockResolvedValue(storedStudy);
      const res = await request(app)
        .post('/api/firsthand/studies')
        .type('json')
        .send(JSON.stringify(validStudyBody))
        .expect(201);
      expect(mockCreateStudy).toHaveBeenCalledTimes(1);
      expect(res.body.study.id).toBe('study_abc');
      expect(res.body.steps).toHaveLength(2);
    });

    it('returns 503 when persistence is not configured', async () => {
      mockIsStudiesPersistenceConfigured.mockReturnValue(false);
      const res = await request(app)
        .post('/api/firsthand/studies')
        .type('json')
        .send(JSON.stringify(validStudyBody))
        .expect(503);
      expect(res.body.error).toBe('persistence_not_configured');
      expect(mockCreateStudy).not.toHaveBeenCalled();
    });

    it('maps a repository create failure to 400 create_failed', async () => {
      (mockCreateStudy as any).mockRejectedValue(new Error('duplicate step order'));
      const res = await request(app)
        .post('/api/firsthand/studies')
        .type('json')
        .send(JSON.stringify(validStudyBody))
        .expect(400);
      expect(res.body).toMatchObject({ error: 'create_failed', message: 'duplicate step order' });
    });
  });

  describe('GET /api/firsthand/studies/:studyId', () => {
    it('returns the study with steps', async () => {
      (mockGetStudyById as any).mockResolvedValue(storedStudy);
      const res = await request(app).get('/api/firsthand/studies/study_abc').expect(200);
      expect(res.body.study.id).toBe('study_abc');
      expect(mockGetStudyById).toHaveBeenCalledWith('study_abc');
    });

    it('returns 404 for an unknown study', async () => {
      (mockGetStudyById as any).mockResolvedValue(null);
      const res = await request(app).get('/api/firsthand/studies/missing').expect(404);
      expect(res.body).toMatchObject({ error: 'not_found' });
    });
  });

  describe('PUT /api/firsthand/studies/:studyId', () => {
    it('updates a study → 200', async () => {
      (mockUpdateStudy as any).mockResolvedValue(storedStudy);
      const res = await request(app)
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(JSON.stringify({ title: 'Renamed' }))
        .expect(200);
      expect(res.body.study.id).toBe('study_abc');
      expect(mockUpdateStudy).toHaveBeenCalledWith('study_abc', { title: 'Renamed' });
    });

    it('returns 404 for an unknown study', async () => {
      (mockUpdateStudy as any).mockResolvedValue(null);
      const res = await request(app)
        .put('/api/firsthand/studies/missing')
        .type('json')
        .send(JSON.stringify({ title: 'New' }))
        .expect(404);
      expect(res.body).toMatchObject({ error: 'not_found' });
    });

    it('rejects invalid update payloads with 400 invalid_payload', async () => {
      const res = await request(app)
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(JSON.stringify({ estimated_duration_minutes: -5 }))
        .expect(400);
      expect(res.body.error).toBe('invalid_payload');
      expect(mockUpdateStudy).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/firsthand/studies/:studyId', () => {
    it('deletes a study → 200 { ok: true }', async () => {
      (mockDeleteStudy as any).mockResolvedValue(true);
      const res = await request(app).delete('/api/firsthand/studies/study_abc').expect(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockDeleteStudy).toHaveBeenCalledWith('study_abc');
    });

    it('returns 404 when the study does not exist', async () => {
      (mockDeleteStudy as any).mockResolvedValue(false);
      const res = await request(app).delete('/api/firsthand/studies/missing').expect(404);
      expect(res.body).toMatchObject({ error: 'not_found' });
    });
  });

});
