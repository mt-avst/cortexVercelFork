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
  // NOT a jest.fn(). canWriteStudy is the authorisation rule itself, and the
  // point of the GET route reporting it is that the client is told the same
  // answer the write path would give - a stub here would let this file agree
  // with itself while the two drifted apart.
  canWriteStudy: jest.requireActual<typeof import('../../firsthand/studies-repository')>(
    '../../firsthand/studies-repository'
  ).canWriteStudy,
}));
jest.mock('../../firsthand/survey-results-repository', () => ({
  listResponsesForStudy: jest.fn(),
}));
jest.mock('../../utils/database', () => ({ isDatabaseAvailable: jest.fn() }));
// redactSensitiveUrl belongs here too: errorHandler imports it from this
// module, so a factory listing only `logger` left it undefined, errorHandler
// threw while handling the error, and Express fell through to the generic
// handler below - turning every 403 and 404 into a 500. An omitted export in a
// mock factory fails for a reason no assertion names.
jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  redactSensitiveUrl: (url: string) => url,
}));

// ─── Typed references to mocked functions ────────────────────────────────────
import firsthandRouter from '../firsthand';
import { errorHandler } from '../../utils/errorHandler';
import {
  isStudiesPersistenceConfigured,
  listStudies,
  createStudy,
  getStudyById,
  updateStudy,
  deleteStudy,
} from '../../firsthand/studies-repository';
import { listResponsesForStudy } from '../../firsthand/survey-results-repository';
import { isDatabaseAvailable } from '../../utils/database';
import { logger } from '../../utils/logger';

const mockIsStudiesPersistenceConfigured = (isStudiesPersistenceConfigured as jest.MockedFunction<typeof isStudiesPersistenceConfigured>);
const mockListStudies = (listStudies as jest.MockedFunction<typeof listStudies>);
const mockCreateStudy = (createStudy as jest.MockedFunction<typeof createStudy>);
const mockGetStudyById = (getStudyById as jest.MockedFunction<typeof getStudyById>);
const mockUpdateStudy = (updateStudy as jest.MockedFunction<typeof updateStudy>);
const mockDeleteStudy = (deleteStudy as jest.MockedFunction<typeof deleteStudy>);
const mockListResponsesForStudy = (listResponsesForStudy as jest.MockedFunction<typeof listResponsesForStudy>);
const mockIsDatabaseAvailable = (isDatabaseAvailable as jest.MockedFunction<typeof isDatabaseAvailable>);
const mockLogger = logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
};

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
  // The real app mounts this after the /api routes (index.ts), so without it
  // here a thrown ForbiddenError surfaced as a 500 in tests and as a 403 in
  // production - the harness disagreeing with the thing it tests.
  app.use(errorHandler);
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
    // Every study that predates the survey vocabulary is a recorded task list,
    // which is what the column defaults to.
    kind: 'recorded' as const,
    owner_user_id: null,
    copied_from_study_id: null,
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
      // Survey results are participant data. Both the aggregate and the CSV
      // export belong in this table for the same reason as the rest.
      { method: 'get', path: '/api/firsthand/studies/study_abc/results' },
      { method: 'get', path: '/api/firsthand/studies/study_abc/results.csv' },
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
      expect(mockListResponsesForStudy).not.toHaveBeenCalled();
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

    it('stamps the session user as the owner', async () => {
      (mockCreateStudy as any).mockResolvedValue(storedStudy);
      await request(app)
        .post('/api/firsthand/studies')
        .type('json')
        .send(JSON.stringify(validStudyBody))
        .expect(201);
      expect(mockCreateStudy).toHaveBeenCalledWith(
        expect.objectContaining({ owner_user_id: 'admin-1' })
      );
    });

    // A body-supplied owner would let an author plant a study under someone
    // else's name - and then be locked out of the study they just wrote.
    it('ignores an owner_user_id sent in the body', async () => {
      (mockCreateStudy as any).mockResolvedValue(storedStudy);
      await request(app)
        .post('/api/firsthand/studies')
        .type('json')
        .send(JSON.stringify({ ...validStudyBody, owner_user_id: 'someone-else' }))
        .expect(201);
      expect(mockCreateStudy).toHaveBeenCalledWith(
        expect.objectContaining({ owner_user_id: 'admin-1' })
      );
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

    /**
     * `can_edit` tells the reader whether a later save would be allowed, so the
     * opportunity form can show an author their own study as an editable
     * surface and a colleague's as a read-only one instead of guessing.
     *
     * It is a DISCLOSURE, not a gate - the binding check is the one updateStudy
     * takes under its own FOR UPDATE lock - which is exactly why these assert
     * the rule's four outcomes rather than that the field is merely present.
     */
    it.each([
      ['the owner', 'admin-1', 'researcher_admin' as const, 'admin-1', true],
      ['another researcher', 'someone-else', 'researcher_admin' as const, 'admin-1', false],
      ['a superadmin over someone else', 'someone-else', 'superadmin' as const, 'root-1', true],
      ['any admin over an unowned legacy study', null, 'researcher_admin' as const, 'admin-1', true],
    ])(
      'reports can_edit for %s',
      async (_label, ownerUserId, role, userId, expected) => {
        mockGetStudyById.mockResolvedValue({
          ...storedStudy,
          study: { ...storedStudy.study, owner_user_id: ownerUserId },
        } as Awaited<ReturnType<typeof getStudyById>>);

        const res = await request(
          buildApp({ id: userId, name: 'A', email: 'a@test.com', role })
        )
          .get('/api/firsthand/studies/study_abc')
          .expect(200);

        expect(res.body.can_edit).toBe(expected);
      }
    );
  });

  describe('PUT /api/firsthand/studies/:studyId', () => {
    it('updates a study → 200', async () => {
      (mockUpdateStudy as any).mockResolvedValue({ ok: true, claimed: false, ...storedStudy });
      const res = await request(app)
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(JSON.stringify({ title: 'Renamed' }))
        .expect(200);
      expect(res.body.study.id).toBe('study_abc');
      expect(mockUpdateStudy).toHaveBeenCalledWith(
        'study_abc',
        { title: 'Renamed' },
        { userId: 'admin-1', isSuperadmin: false }
      );
    });

    /**
     * The classification describes the wording, so it cannot arrive without it.
     *
     * The repository already ignores a lone claim, so nothing is stored either
     * way - this is about what the caller is TOLD. Answering 200 to a request
     * that set out to record which template a study runs on, having recorded
     * nothing, is how a client comes to depend on behaviour that does not exist.
     */
    it('refuses a consent classification sent without the wording it describes', async () => {
      // `as never` rather than `as any`: this file's `any` budget is pinned
      // exactly in eslint-suppressions.json, which is shrink-only.
      mockUpdateStudy.mockResolvedValue({
        ok: true,
        claimed: false,
        ...storedStudy
      } as never);
      await request(app)
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(
          JSON.stringify({
            consent_template_id: 'recorded-default',
            consent_template_version: 1
          })
        )
        .expect(400);

      expect(mockUpdateStudy).not.toHaveBeenCalled();
    });

    it('accepts the classification when the wording travels with it', async () => {
      mockUpdateStudy.mockResolvedValue({
        ok: true,
        claimed: false,
        ...storedStudy
      } as never);
      await request(app)
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(
          JSON.stringify({
            consent_text: 'Some consent wording',
            consent_template_id: 'recorded-default',
            consent_template_version: 1
          })
        )
        .expect(200);

      expect(mockUpdateStudy).toHaveBeenCalledWith(
        'study_abc',
        {
          consent_text: 'Some consent wording',
          consent_template_id: 'recorded-default',
          consent_template_version: 1
        },
        { userId: 'admin-1', isSuperadmin: false }
      );
    });

    it('marks a superadmin requester so the repository can bypass ownership', async () => {
      const superadminApp = buildApp({
        id: 'super-1', name: 'Super', email: 'super@test.com', role: 'superadmin',
      });
      (mockUpdateStudy as any).mockResolvedValue({ ok: true, claimed: false, ...storedStudy });
      await request(superadminApp)
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(JSON.stringify({ title: 'Renamed' }))
        .expect(200);
      expect(mockUpdateStudy).toHaveBeenCalledWith(
        'study_abc',
        { title: 'Renamed' },
        { userId: 'super-1', isSuperadmin: true }
      );
    });

    it('returns 404 for an unknown study', async () => {
      (mockUpdateStudy as any).mockResolvedValue({ ok: false, reason: 'not_found' });
      const res = await request(app)
        .put('/api/firsthand/studies/missing')
        .type('json')
        .send(JSON.stringify({ title: 'New' }))
        .expect(404);
      expect(res.body).toMatchObject({ error: 'not_found' });
    });

    // The attack this route now blocks: a second researcher_admin rewriting
    // another owner's consent copy and task target_url on a launched study.
    it('returns 403 when the repository refuses a non-owner edit', async () => {
      (mockUpdateStudy as any).mockResolvedValue({ ok: false, reason: 'forbidden' });
      const res = await request(app)
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(JSON.stringify({ consent_text: 'Rewritten by someone else' }))
        .expect(403);
      expect(res.body).toMatchObject({
        error: 'forbidden',
        message: 'Only the owner of this task list can edit it',
      });
    });

    // These handlers answer directly rather than throwing ForbiddenError, so
    // they never reach errorHandler - the only thing that logs the
    // opportunities equivalent. Without this the attempt is silent.
    it('logs a refused cross-owner write', async () => {
      (mockUpdateStudy as any).mockResolvedValue({ ok: false, reason: 'forbidden' });
      await request(app)
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(JSON.stringify({ consent_text: 'Rewritten by someone else' }))
        .expect(403);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Refused a cross-owner study write',
        expect.objectContaining({ studyId: 'study_abc', userId: 'admin-1', verb: 'edit' })
      );
    });

    it('does not log a refusal when the study simply does not exist', async () => {
      (mockUpdateStudy as any).mockResolvedValue({ ok: false, reason: 'not_found' });
      await request(app)
        .put('/api/firsthand/studies/missing')
        .type('json')
        .send(JSON.stringify({ title: 'New' }))
        .expect(404);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('logs an ownership claim, which has no UI and no undo below superadmin', async () => {
      (mockUpdateStudy as any).mockResolvedValue({ ok: true, claimed: true, ...storedStudy });
      await request(app)
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(JSON.stringify({ title: 'Tidied up' }))
        .expect(200);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Unowned study claimed by its first editor',
        expect.objectContaining({ studyId: 'study_abc', newOwnerUserId: 'admin-1' })
      );
    });

    it('does not log a claim on an ordinary edit', async () => {
      (mockUpdateStudy as any).mockResolvedValue({ ok: true, claimed: false, ...storedStudy });
      await request(app)
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(JSON.stringify({ title: 'Renamed' }))
        .expect(200);

      expect(mockLogger.info).not.toHaveBeenCalled();
    });

    // A repository throw here can be a duplicate step id (the author's
    // problem) or a dropped connection (nobody's), and both answer 400. The
    // log is the only thing that tells them apart.
    it('logs the cause when the repository throws', async () => {
      (mockUpdateStudy as any).mockRejectedValue(new Error('connection terminated'));
      await request(app)
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(JSON.stringify({ title: 'Renamed' }))
        .expect(400);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Study update failed',
        expect.objectContaining({ studyId: 'study_abc', userId: 'admin-1' })
      );
    });

    // Superadmin-only, and the repository is what enforces it - the route must
    // pass the field through rather than stripping it.
    it('passes an owner reassignment through to the repository', async () => {
      (mockUpdateStudy as any).mockResolvedValue({ ok: true, claimed: false, ...storedStudy });
      await request(app)
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(JSON.stringify({ owner_user_id: 'user-rightful' }))
        .expect(200);

      expect(mockUpdateStudy).toHaveBeenCalledWith(
        'study_abc',
        { owner_user_id: 'user-rightful' },
        { userId: 'admin-1', isSuperadmin: false }
      );
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
      (mockDeleteStudy as any).mockResolvedValue({ ok: true });
      const res = await request(app).delete('/api/firsthand/studies/study_abc').expect(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockDeleteStudy).toHaveBeenCalledWith('study_abc', {
        userId: 'admin-1',
        isSuperadmin: false,
      });
    });

    it('returns 404 when the study does not exist', async () => {
      (mockDeleteStudy as any).mockResolvedValue({ ok: false, reason: 'not_found' });
      const res = await request(app).delete('/api/firsthand/studies/missing').expect(404);
      expect(res.body).toMatchObject({ error: 'not_found' });
    });

    // Deleting someone else's study is the other half of the attack: it breaks
    // the published opportunity that points at it.
    it('returns 403 when the repository refuses a non-owner delete', async () => {
      (mockDeleteStudy as any).mockResolvedValue({ ok: false, reason: 'forbidden' });
      const res = await request(app)
        .delete('/api/firsthand/studies/study_abc')
        .expect(403);
      expect(res.body).toMatchObject({
        error: 'forbidden',
        message: 'Only the owner of this task list can delete it',
      });
    });
  });

  // ── Survey results ownership ───────────────────────────────────────────────
  // requireAdmin alone is not the boundary here. The study LIST and the single
  // study GET are deliberately open to every admin (study copy is authoring
  // metadata, reused across opportunities), but these two routes return
  // participants' actual answers, so they carry the same owner-or-superadmin
  // rule the writes do.
  describe('survey results ownership', () => {
    // Asserted through the repository's own return type rather than through an
    // explicit any. This file's explicit-any count is a lint backlog held per
    // file, and it is meant to shrink - new tests should not spend against it.
    type StoredStudy = NonNullable<Awaited<ReturnType<typeof getStudyById>>>;

    function studyOwnedBy(owner_user_id: string | null) {
      mockGetStudyById.mockResolvedValue({
        ...storedStudy,
        study: { ...storedStudy.study, owner_user_id },
      } as StoredStudy);
    }

    const superadminApp = buildApp({
      id: 'root-1',
      name: 'Root',
      email: 'root@test.com',
      role: 'superadmin',
    });

    beforeEach(() => {
      mockListResponsesForStudy.mockResolvedValue([]);
    });

    it('lets a superadmin read the aggregate', async () => {
      studyOwnedBy('other-admin-9');
      const res = await request(superadminApp)
        .get('/api/firsthand/studies/study_abc/results')
        .expect(200);
      expect(res.body).toMatchObject({ title: storedStudy.study.title });
      // One envelope for one logical resource - the per-opportunity reader
      // returns the same shape, and `study` is gone rather than duplicated.
      expect(res.body.study).toBeUndefined();
      expect(mockListResponsesForStudy).toHaveBeenCalledWith('study_abc');
    });

    it('lets a superadmin export the CSV', async () => {
      studyOwnedBy('other-admin-9');
      const res = await request(superadminApp)
        .get('/api/firsthand/studies/study_abc/results.csv')
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
    });

    // These results aggregate across EVERY opportunity using the study, and a
    // study is reusable by an opportunity its author did not create. So the
    // study's own owner is refused too: granting them would hand them answers
    // from participants another researcher recruited.
    //
    // Superadmin-only is the END STATE here, not an interim one. Phase 4e gave
    // a researcher GET /api/opportunities/:id/survey-results instead, gated on
    // opportunity ownership - it resolved this by building a different route
    // rather than by loosening this one.
    it('refuses even the study owner, because results span other researchers opportunities', async () => {
      studyOwnedBy('admin-1');
      const res = await request(app)
        .get('/api/firsthand/studies/study_abc/results')
        .expect(403);
      expect(res.body).toMatchObject({ error: 'Only a superadmin can view survey responses across every opportunity', code: 'FORBIDDEN' });
      expect(mockListResponsesForStudy).not.toHaveBeenCalled();
    });

    it('refuses the study owner the CSV as well, and serves no CSV body', async () => {
      studyOwnedBy('admin-1');
      const res = await request(app)
        .get('/api/firsthand/studies/study_abc/results.csv')
        .expect(403);
      expect(res.headers['content-type']).not.toContain('text/csv');
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(mockListResponsesForStudy).not.toHaveBeenCalled();
    });

    // The defect this block exists for: a researcher_admin reading a colleague's
    // participant answers.
    it('refuses a non-owner admin the aggregate, without reading any responses', async () => {
      studyOwnedBy('other-admin-9');
      const res = await request(app)
        .get('/api/firsthand/studies/study_abc/results')
        .expect(403);
      expect(res.body).toMatchObject({ error: 'Only a superadmin can view survey responses across every opportunity', code: 'FORBIDDEN' });
      // Refusing after loading the answers would still have read them.
      expect(mockListResponsesForStudy).not.toHaveBeenCalled();
    });

    it('refuses a non-owner admin the CSV, and serves no CSV body', async () => {
      studyOwnedBy('other-admin-9');
      const res = await request(app)
        .get('/api/firsthand/studies/study_abc/results.csv')
        .expect(403);
      expect(res.body).toMatchObject({ error: 'Only a superadmin can view survey responses across every opportunity' });
      // A refusal that still set the download headers would hand over a file.
      expect(res.headers['content-type']).not.toContain('text/csv');
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(mockListResponsesForStudy).not.toHaveBeenCalled();
    });

    // canWriteStudy fails OPEN on a null owner so legacy rows stay editable by
    // whoever authored them. Reads of participant answers must not inherit that:
    // a read cannot adopt the row the way a write does, and an unowned study is
    // the case where nobody can be held accountable for the data at all.
    it('refuses an unowned study, which the write path would have let through', async () => {
      studyOwnedBy(null);
      await request(app)
        .get('/api/firsthand/studies/study_abc/results')
        .expect(403);
      expect(mockListResponsesForStudy).not.toHaveBeenCalled();
    });

    it('still lets a superadmin read an unowned study', async () => {
      studyOwnedBy(null);
      await request(superadminApp)
        .get('/api/firsthand/studies/study_abc/results')
        .expect(200);
    });

    it('logs the refusal, so an attempt on participant answers is not silent', async () => {
      studyOwnedBy('other-admin-9');
      await request(app)
        .get('/api/firsthand/studies/study_abc/results')
        .expect(403);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Refused a study results read below superadmin',
        expect.objectContaining({ studyId: 'study_abc', userId: 'admin-1' })
      );
    });

    it('answers 404 for a missing study before any access decision', async () => {
      mockGetStudyById.mockResolvedValue(null);
      const res = await request(app)
        .get('/api/firsthand/studies/missing/results')
        .expect(404);
      expect(res.body).toMatchObject({ error: 'Survey not found', code: 'NOT_FOUND' });
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

});
