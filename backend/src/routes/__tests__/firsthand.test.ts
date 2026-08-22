import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
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
  answerCountsByStep: jest.fn(),
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
import firsthandRouter, {
  resetFirsthandStudyLimits,
  studyReadLimiter,
  studyWriteLimiter,
  studyResultsLimiter,
} from '../firsthand';
import { requireAdmin } from '../../middleware/authenticate';
import { errorHandler } from '../../utils/errorHandler';
import {
  isStudiesPersistenceConfigured,
  listStudies,
  createStudy,
  getStudyById,
  updateStudy,
  deleteStudy,
} from '../../firsthand/studies-repository';
import {
  answerCountsByStep,
  listResponsesForStudy,
} from '../../firsthand/survey-results-repository';
import { isDatabaseAvailable } from '../../utils/database';
import {
  RuntimeDatabaseAdmissionTimeoutError,
  RuntimeDatabaseBusyError,
} from '../../firsthand/runtime-pool-admission';
import { logger } from '../../utils/logger';

const mockIsStudiesPersistenceConfigured = (isStudiesPersistenceConfigured as jest.MockedFunction<typeof isStudiesPersistenceConfigured>);
const mockListStudies = (listStudies as jest.MockedFunction<typeof listStudies>);
const mockCreateStudy = (createStudy as jest.MockedFunction<typeof createStudy>);
const mockGetStudyById = (getStudyById as jest.MockedFunction<typeof getStudyById>);
const mockUpdateStudy = (updateStudy as jest.MockedFunction<typeof updateStudy>);
const mockDeleteStudy = (deleteStudy as jest.MockedFunction<typeof deleteStudy>);
const mockListResponsesForStudy = (listResponsesForStudy as jest.MockedFunction<typeof listResponsesForStudy>);
const mockAnswerCountsByStep = (answerCountsByStep as jest.MockedFunction<typeof answerCountsByStep>);
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
    mockAnswerCountsByStep.mockResolvedValue({});
    // The counters live in an in-process MemoryStore that outlives a test, so
    // without this a suite exercising these routes hundreds of times as one
    // admin starts answering 429 partway through and every later assertion
    // fails for a reason none of them names.
    resetFirsthandStudyLimits(adminUser.id);
    resetFirsthandStudyLimits('other-admin');
  });

  // ── Studies CRUD (B3a, in-process) ────────────────────────────────────────
  describe('GET /api/firsthand/studies', () => {
    it('returns the in-process study list', async () => {
      const studies = [{ id: 's-1', title: 'Usability Study', status: 'launched' }];
      (mockListStudies as any).mockResolvedValue(studies);
      const res = await request(listening(app)).get('/api/firsthand/studies').expect(200);
      expect(res.body).toEqual({ studies });
      expect(mockListStudies).toHaveBeenCalledTimes(1);
    });

    it('returns an empty list when persistence is unconfigured (repo soft-empty)', async () => {
      (mockListStudies as any).mockResolvedValue([]);
      const res = await request(listening(app)).get('/api/firsthand/studies').expect(200);
      expect(res.body).toEqual({ studies: [] });
    });

    it('propagates repository errors as 500', async () => {
      (mockListStudies as any).mockRejectedValue(new Error('db down'));
      await request(listening(app)).get('/api/firsthand/studies').expect(500);
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
      const req = (request(listening(app)) as any)[method](path);
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
      const res = await request(listening(app))
        .post('/api/firsthand/studies')
        .type('json')
        .send(JSON.stringify({ title: 'Missing fields' }))
        .expect(400);
      expect(res.body.error).toBe('invalid_payload');
      expect(mockCreateStudy).not.toHaveBeenCalled();
    });

    it('creates a study when the payload is valid → 201', async () => {
      (mockCreateStudy as any).mockResolvedValue(storedStudy);
      const res = await request(listening(app))
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
      await request(listening(app))
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
      await request(listening(app))
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
      const res = await request(listening(app))
        .post('/api/firsthand/studies')
        .type('json')
        .send(JSON.stringify(validStudyBody))
        .expect(503);
      expect(res.body.error).toBe('persistence_not_configured');
      expect(mockCreateStudy).not.toHaveBeenCalled();
    });

    it('maps a repository create failure to 400 create_failed', async () => {
      (mockCreateStudy as any).mockRejectedValue(new Error('duplicate step order'));
      const res = await request(listening(app))
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
      const res = await request(listening(app)).get('/api/firsthand/studies/study_abc').expect(200);
      expect(res.body.study.id).toBe('study_abc');
      expect(mockGetStudyById).toHaveBeenCalledWith('study_abc');
    });

    it('returns 404 for an unknown study', async () => {
      (mockGetStudyById as any).mockResolvedValue(null);
      const res = await request(listening(app)).get('/api/firsthand/studies/missing').expect(404);
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

        const res = await request(listening(buildApp({ id: userId, name: 'A', email: 'a@test.com', role })))
          .get('/api/firsthand/studies/study_abc')
          .expect(200);

        expect(res.body.can_edit).toBe(expected);
      }
    );

    /**
     * `answer_counts` is what lets the authoring form tell an author that the
     * question they are about to remove has been answered by people.
     *
     * Reported keyed by STEP KEY rather than by the stored step id, because the
     * key is the only half of that id the form ever holds: `_clientId` on a
     * question card IS its step key, minted when the question was created and
     * carried through every edit and reorder. Sending whole ids would make the
     * client re-derive the namespacing, which is the split step-identity.ts
     * exists to keep on the server.
     */
    /**
     * The study whose counts this caller may legitimately read: a SURVEY, owned
     * by them.
     *
     * `storedStudy` is neither - it is a recorded task list with no owner - and
     * using it here is what made the first version of these tests assert the
     * leak rather than the guard: `canWriteStudy` fails open on an unowned row,
     * so `can_edit` was true and the counts were served to an admin who did not
     * own the study.
     */
    const ownedSurvey = {
      ...storedStudy,
      study: {
        ...storedStudy.study,
        kind: 'survey' as const,
        owner_user_id: 'admin-1',
      },
    } as NonNullable<Awaited<ReturnType<typeof getStudyById>>>;

    it('reports answer counts keyed by the step key the form holds', async () => {
      mockGetStudyById.mockResolvedValue(ownedSurvey);
      mockAnswerCountsByStep.mockResolvedValue({
        study_abc_step_001: 47,
      });

      const res = await request(listening(app)).get('/api/firsthand/studies/study_abc').expect(200);

      expect(res.body.answer_counts).toEqual({ step_001: 47 });
      expect(mockAnswerCountsByStep).toHaveBeenCalledWith('study_abc');
    });

    it('omits an answer count whose step id is outside this study', async () => {
      mockGetStudyById.mockResolvedValue(ownedSurvey);
      mockAnswerCountsByStep.mockResolvedValue({
        study_abc_step_001: 47,
        // Nothing this product writes produces one, but a de-namespaced id
        // passed through raw would land in the map under a key no card holds
        // at best, and collide with a real key at worst.
        study_other_step_001: 9000,
      });

      const res = await request(listening(app)).get('/api/firsthand/studies/study_abc').expect(200);

      expect(res.body.answer_counts).toEqual({ step_001: 47 });
    });

    it('reports null rather than an empty map when the count could not be read', async () => {
      mockGetStudyById.mockResolvedValue(ownedSurvey);
      mockAnswerCountsByStep.mockResolvedValue(null);

      const res = await request(listening(app)).get('/api/firsthand/studies/study_abc').expect(200);

      // Flattened to `{}` this would read as "no question has any answers" and
      // silence the warning at exactly the moment the runtime database is under
      // the pressure that suggests there are participants answering. And it is
      // NULL rather than absent: the count was attempted and failed, which is a
      // claim, where an absent key makes none.
      expect(res.body.answer_counts).toBeNull();
    });

    /**
     * Whether a study has collected answers - and how many, per question - is a
     * fact about another researcher's work.
     *
     * `updateLinkedStudyContent` moved its ownership check ahead of
     * `studyHasResponses` precisely because a refusal naming "already collected
     * answers" told a caller who could not write the study something they had
     * never been granted. Reporting the counts on the read side would give that
     * away far more precisely, and to every admin rather than only to one who
     * tried to save.
     */
    it('does not count answers for a reader who may not write the study', async () => {
      mockGetStudyById.mockResolvedValue({
        ...ownedSurvey,
        study: { ...ownedSurvey.study, owner_user_id: 'someone-else' },
      } as Awaited<ReturnType<typeof getStudyById>>);
      mockAnswerCountsByStep.mockResolvedValue({ study_abc_step_001: 47 });

      const res = await request(listening(app)).get('/api/firsthand/studies/study_abc').expect(200);

      expect(res.body.can_edit).toBe(false);
      // ABSENT, not null. Null is reserved for a count that was attempted and
      // could not be established, which the form renders as "could not be
      // checked"; withholding one says nothing about answers at all.
      expect(res.body).not.toHaveProperty('answer_counts');
      // And not merely filtered out of the response: the read never happens, so
      // a colleague browsing studies cannot make the runtime pool work either.
      expect(mockAnswerCountsByStep).not.toHaveBeenCalled();
    });

    /**
     * The fail-open in `canWriteStudy` is right for a WRITE and wrong for this.
     *
     * An unowned legacy study is editable by any admin, because 0007's backfill
     * could not attribute it and locking those rows would strand them. A write
     * adopts the row and makes somebody accountable for it. A read adopts
     * nothing, so serving counts here would report per-question participation
     * volume for research nobody is accountable for, to every admin - and the
     * study picker fetches any listed study to preview it, so no crafted
     * request is needed to reach it.
     *
     * `requireSuperadminForStudyResults` already refuses the unowned case for
     * exactly this reason, and says so in its own docblock.
     */
    it('does not count answers for a study nobody owns, where the write path fails open', async () => {
      mockGetStudyById.mockResolvedValue({
        ...ownedSurvey,
        study: { ...ownedSurvey.study, owner_user_id: null },
      } as Awaited<ReturnType<typeof getStudyById>>);
      mockAnswerCountsByStep.mockResolvedValue({ study_abc_step_001: 47 });

      const res = await request(listening(app)).get('/api/firsthand/studies/study_abc').expect(200);

      // Editable, and still not entitled to the counts. The two answers differ
      // on purpose, which is the whole finding.
      expect(res.body.can_edit).toBe(true);
      expect(res.body).not.toHaveProperty('answer_counts');
      expect(mockAnswerCountsByStep).not.toHaveBeenCalled();
    });

    /**
     * "Removed questions" is a section of the SURVEY results view. A recorded
     * task list has no surface on which its author could be shown a count, so
     * reading one spends a connection from the five-connection runtime pool
     * that live participants share, and puts a value on the wire that nothing
     * reads.
     */
    it('does not count answers for a recorded task list, which has nowhere to show them', async () => {
      mockGetStudyById.mockResolvedValue({
        ...ownedSurvey,
        study: { ...ownedSurvey.study, kind: 'recorded' as const },
      } as Awaited<ReturnType<typeof getStudyById>>);
      mockAnswerCountsByStep.mockResolvedValue({ study_abc_step_001: 47 });

      const res = await request(listening(app)).get('/api/firsthand/studies/study_abc').expect(200);

      expect(res.body).not.toHaveProperty('answer_counts');
      expect(mockAnswerCountsByStep).not.toHaveBeenCalled();
    });

    it('still returns the study when the answer count is unavailable', async () => {
      mockGetStudyById.mockResolvedValue(ownedSurvey);
      mockAnswerCountsByStep.mockResolvedValue(null);

      // The opportunity form cannot render at all until this route answers, so
      // an advisory count must never be able to take the form down with it.
      const res = await request(listening(app)).get('/api/firsthand/studies/study_abc').expect(200);

      expect(res.body.study.id).toBe('study_abc');
      expect(res.body.steps).toHaveLength(2);
    });
  });

  describe('PUT /api/firsthand/studies/:studyId', () => {
    it('updates a study → 200', async () => {
      (mockUpdateStudy as any).mockResolvedValue({ ok: true, claimed: false, ...storedStudy });
      const res = await request(listening(app))
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(JSON.stringify({ title: 'Renamed' }))
        .expect(200);
      expect(res.body.study.id).toBe('study_abc');
      expect(mockUpdateStudy).toHaveBeenCalledWith(
        'study_abc',
        { title: 'Renamed' },
        { userId: 'admin-1', isSuperadmin: false },
        // The fourth argument is the optimistic-concurrency precondition, and
        // it is undefined here because this request asserted none.
        undefined
      );
    });

    it('forwards the precondition as an argument, not as a column to write', async () => {
      // `expected_updated_at` is a PRECONDITION. Leaving it in the payload
      // would put a non-column into UpdateStudyInput, where the next field
      // added to the repository's dynamic update builder could pick it up.
      // `as never`, not `as any`: this file's `any` budget is pinned exactly in
      // eslint-suppressions.json and that budget is shrink-only.
      mockUpdateStudy.mockResolvedValue({
        ok: true,
        claimed: false,
        ...storedStudy
      } as never);

      await request(listening(app))
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(
          JSON.stringify({
            title: 'Renamed',
            expected_updated_at: '2026-08-21T09:15:30.123Z'
          })
        )
        .expect(200);

      expect(mockUpdateStudy).toHaveBeenCalledWith(
        'study_abc',
        { title: 'Renamed' },
        { userId: 'admin-1', isSuperadmin: false },
        '2026-08-21T09:15:30.123Z'
      );
    });

    it('answers 409 when the study moved under the caller, and says what is stored now', async () => {
      mockUpdateStudy.mockResolvedValue({
        ok: false,
        reason: 'stale',
        current_updated_at: '2026-08-21T09:15:30.123Z'
      } as never);

      const res = await request(listening(app))
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(
          JSON.stringify({
            title: 'Mine',
            expected_updated_at: '2026-08-21T09:15:29.123Z'
          })
        )
        .expect(409);

      expect(res.body.error).toBe('stale_study');
      // Returned so the client can offer a deliberate re-save. Without it the
      // author can only re-send a token that can never match again, and is
      // locked out of their own study.
      expect(res.body.current_updated_at).toBe('2026-08-21T09:15:30.123Z');
      // Legible, and it has to say the edits survived - that is the whole
      // promise the refusal is making.
      expect(res.body.message).toMatch(/somebody else/i);
      expect(res.body.message).toMatch(/still here/i);
    });

    /**
     * The whole written justification for shipping a fail-open is that the
     * omission is DISCOVERABLE. Nothing verified that, so deleting the warning -
     * or inverting its condition, so it fired on protected requests and stayed
     * silent on unprotected ones - left the suite green and the justification
     * false.
     */
    it('warns when a study is updated with no precondition at all', async () => {
      mockUpdateStudy.mockResolvedValue({
        ok: true,
        claimed: false,
        ...storedStudy
      } as never);

      await request(listening(app))
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(JSON.stringify({ title: 'Renamed' }))
        .expect(200);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Study updated with no concurrency precondition',
        { studyId: 'study_abc', userId: 'admin-1' }
      );
    });

    it('stays silent when the precondition WAS sent', async () => {
      // The inverted-condition mutation: a warning that fires on the protected
      // request and not the unprotected one is worse than none, because it
      // points an operator at exactly the wrong sessions.
      mockUpdateStudy.mockResolvedValue({
        ok: true,
        claimed: false,
        ...storedStudy
      } as never);

      await request(listening(app))
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(
          JSON.stringify({
            title: 'Renamed',
            expected_updated_at: '2026-08-21T09:15:30.123Z'
          })
        )
        .expect(200);

      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Study updated with no concurrency precondition',
        expect.anything()
      );
    });

    it('does not claim an unprotected update for a request that updated nothing', async () => {
      // The placement, not just the presence. Logged on the way IN, this line
      // would fire for a 404 and a 403 too - noise in exactly the place an
      // operator is looking for signal.
      mockUpdateStudy.mockResolvedValue({ ok: false, reason: 'not_found' } as never);

      await request(listening(app))
        .put('/api/firsthand/studies/missing')
        .type('json')
        .send(JSON.stringify({ title: 'Renamed' }))
        .expect(404);

      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Study updated with no concurrency precondition',
        expect.anything()
      );
    });

    it('records a refused stale write, so it is not silent', async () => {
      // The row records WHO through updated_by_user_id and the response body
      // deliberately does not. This line is what keeps that answerable.
      mockUpdateStudy.mockResolvedValue({
        ok: false,
        reason: 'stale',
        current_updated_at: '2026-08-21T09:15:30.123Z'
      } as never);

      await request(listening(app))
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(
          JSON.stringify({
            title: 'Mine',
            expected_updated_at: '2026-08-21T09:15:29.123Z'
          })
        )
        .expect(409);

      expect(mockLogger.info).toHaveBeenCalledWith('Refused a stale study write', {
        studyId: 'study_abc',
        userId: 'admin-1'
      });
    });

    /**
     * The precondition runs BEFORE the vocabulary check, and this pins it.
     *
     * If the row moved under the caller, the validity of their payload against
     * it is moot - and a step-shape complaint about content they are about to
     * be told to re-derive is the less actionable of the two answers.
     */
    it('answers the conflict, not a payload complaint, when both are true', async () => {
      mockUpdateStudy.mockResolvedValue({
        ok: false,
        reason: 'stale',
        current_updated_at: '2026-08-21T09:15:30.123Z'
      } as never);

      const res = await request(listening(app))
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(
          JSON.stringify({
            title: 'Mine',
            expected_updated_at: '2026-08-21T09:15:29.123Z'
          })
        )
        .expect(409);

      expect(res.body.error).toBe('stale_study');
    });

    it('names no user in the 409 body', async () => {
      // The row records who wrote it and the server logs it; the BODY does not
      // carry it. GET /api/firsthand/studies is unfiltered by owner and
      // canWriteStudy fails open on an unowned legacy study, so the audience
      // for this sentence is every researcher_admin - a wider disclosure than
      // anything the product asked for.
      mockUpdateStudy.mockResolvedValue({
        ok: false,
        reason: 'stale',
        current_updated_at: '2026-08-21T09:15:30.123Z'
      } as never);

      const res = await request(listening(app))
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(
          JSON.stringify({
            title: 'Mine',
            expected_updated_at: '2026-08-21T09:15:29.123Z'
          })
        )
        .expect(409);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain('updated_by');
      expect(body).not.toContain('user-');
      expect(Object.keys(res.body).sort()).toEqual([
        'current_updated_at',
        'error',
        'message'
      ]);
    });

    it('refuses a malformed precondition at the schema rather than passing it down', async () => {
      mockUpdateStudy.mockResolvedValue({
        ok: true,
        claimed: false,
        ...storedStudy
      } as never);

      const res = await request(listening(app))
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(
          JSON.stringify({ title: 'Renamed', expected_updated_at: 'yesterday' })
        )
        .expect(400);

      expect(res.body.error).toBe('invalid_payload');
      expect(mockUpdateStudy).not.toHaveBeenCalled();
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
      await request(listening(app))
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
      await request(listening(app))
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
        { userId: 'admin-1', isSuperadmin: false },
        undefined
      );
    });

    it('marks a superadmin requester so the repository can bypass ownership', async () => {
      const superadminApp = buildApp({
        id: 'super-1', name: 'Super', email: 'super@test.com', role: 'superadmin',
      });
      (mockUpdateStudy as any).mockResolvedValue({ ok: true, claimed: false, ...storedStudy });
      await request(listening(superadminApp))
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(JSON.stringify({ title: 'Renamed' }))
        .expect(200);
      expect(mockUpdateStudy).toHaveBeenCalledWith(
        'study_abc',
        { title: 'Renamed' },
        { userId: 'super-1', isSuperadmin: true },
        undefined
      );
    });

    it('returns 404 for an unknown study', async () => {
      (mockUpdateStudy as any).mockResolvedValue({ ok: false, reason: 'not_found' });
      const res = await request(listening(app))
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
      const res = await request(listening(app))
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
      await request(listening(app))
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
      await request(listening(app))
        .put('/api/firsthand/studies/missing')
        .type('json')
        .send(JSON.stringify({ title: 'New' }))
        .expect(404);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('logs an ownership claim, which has no UI and no undo below superadmin', async () => {
      (mockUpdateStudy as any).mockResolvedValue({ ok: true, claimed: true, ...storedStudy });
      await request(listening(app))
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
      await request(listening(app))
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
      await request(listening(app))
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
      await request(listening(app))
        .put('/api/firsthand/studies/study_abc')
        .type('json')
        .send(JSON.stringify({ owner_user_id: 'user-rightful' }))
        .expect(200);

      expect(mockUpdateStudy).toHaveBeenCalledWith(
        'study_abc',
        { owner_user_id: 'user-rightful' },
        { userId: 'admin-1', isSuperadmin: false },
        undefined
      );
    });

    it('rejects invalid update payloads with 400 invalid_payload', async () => {
      const res = await request(listening(app))
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
      const res = await request(listening(app)).delete('/api/firsthand/studies/study_abc').expect(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockDeleteStudy).toHaveBeenCalledWith('study_abc', {
        userId: 'admin-1',
        isSuperadmin: false,
      });
    });

    it('returns 404 when the study does not exist', async () => {
      (mockDeleteStudy as any).mockResolvedValue({ ok: false, reason: 'not_found' });
      const res = await request(listening(app)).delete('/api/firsthand/studies/missing').expect(404);
      expect(res.body).toMatchObject({ error: 'not_found' });
    });

    // Deleting someone else's study is the other half of the attack: it breaks
    // the published opportunity that points at it.
    it('returns 403 when the repository refuses a non-owner delete', async () => {
      (mockDeleteStudy as any).mockResolvedValue({ ok: false, reason: 'forbidden' });
      const res = await request(listening(app))
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
      const res = await request(listening(superadminApp))
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
      const res = await request(listening(superadminApp))
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
      const res = await request(listening(app))
        .get('/api/firsthand/studies/study_abc/results')
        .expect(403);
      expect(res.body).toMatchObject({ error: 'Only a superadmin can view survey responses across every opportunity', code: 'FORBIDDEN' });
      expect(mockListResponsesForStudy).not.toHaveBeenCalled();
    });

    it('refuses the study owner the CSV as well, and serves no CSV body', async () => {
      studyOwnedBy('admin-1');
      const res = await request(listening(app))
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
      const res = await request(listening(app))
        .get('/api/firsthand/studies/study_abc/results')
        .expect(403);
      expect(res.body).toMatchObject({ error: 'Only a superadmin can view survey responses across every opportunity', code: 'FORBIDDEN' });
      // Refusing after loading the answers would still have read them.
      expect(mockListResponsesForStudy).not.toHaveBeenCalled();
    });

    it('refuses a non-owner admin the CSV, and serves no CSV body', async () => {
      studyOwnedBy('other-admin-9');
      const res = await request(listening(app))
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
      await request(listening(app))
        .get('/api/firsthand/studies/study_abc/results')
        .expect(403);
      expect(mockListResponsesForStudy).not.toHaveBeenCalled();
    });

    it('still lets a superadmin read an unowned study', async () => {
      studyOwnedBy(null);
      await request(listening(superadminApp))
        .get('/api/firsthand/studies/study_abc/results')
        .expect(200);
    });

    it('logs the refusal, so an attempt on participant answers is not silent', async () => {
      studyOwnedBy('other-admin-9');
      await request(listening(app))
        .get('/api/firsthand/studies/study_abc/results')
        .expect(403);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Refused a study results read below superadmin',
        expect.objectContaining({ studyId: 'study_abc', userId: 'admin-1' })
      );
    });

    it('answers 404 for a missing study before any access decision', async () => {
      mockGetStudyById.mockResolvedValue(null);
      const res = await request(listening(app))
        .get('/api/firsthand/studies/missing/results')
        .expect(404);
      expect(res.body).toMatchObject({ error: 'Survey not found', code: 'NOT_FOUND' });
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });


  /**
   * The ceiling this router had none of.
   *
   * `GET /studies/:studyId` takes TWO connections from the five-connection
   * FirstHand runtime pool that live participant sessions share, and the second
   * scans every answer row the study has collected. With `max: 5`,
   * `connectionTimeoutMillis: 10_000` and no statement timeout anywhere, a
   * caller looping this above five concurrent makes participants writing their
   * answers queue on `pool.connect()` and fail after ten seconds, mid-survey.
   */
  describe('per-user rate limits', () => {
    /** Fire one endpoint n times and return the status codes in order. */
    const hammer = async (n: number, call: () => request.Test): Promise<number[]> => {
      const codes: number[] = [];
      for (let i = 0; i < n; i += 1) {
        codes.push((await call()).status);
      }
      return codes;
    };

    beforeEach(() => {
      mockGetStudyById.mockResolvedValue(
        storedStudy as Awaited<ReturnType<typeof getStudyById>>
      );
      mockListStudies.mockResolvedValue([]);
    });

    it('refuses a 61st read in a minute, and not the 60th', async () => {
      const codes = await hammer(61, () =>
        request(listening(app)).get('/api/firsthand/studies/study_abc')
      );

      // Both halves. Asserting only the 429 would pass against a ceiling of
      // one, which would refuse an author who simply reopened a form.
      expect(codes.slice(0, 60).every((code) => code !== 429)).toBe(true);
      expect(codes[60]).toBe(429);
    });

    it('refuses a 31st write in a minute, and not the 30th', async () => {
      const codes = await hammer(31, () =>
        request(listening(app)).put('/api/firsthand/studies/study_abc').send(validStudyBody)
      );

      expect(codes.slice(0, 30).every((code) => code !== 429)).toBe(true);
      expect(codes[30]).toBe(429);
    });

    /**
     * The ENVELOPE, not just the status.
     *
     * Every 429 assertion in this repository checks `.status` and none reads
     * `.body`, so the shape the message travels in was pinned nowhere at all.
     * `perUserLimiter` sends `{ error: message }`; hand express-rate-limit a
     * bare string instead and it replies `text/html`, `data.error` is
     * undefined, and the frontend's `extractSaveError` falls through to
     * "Request failed with status code 429". The three carefully worded
     * sentences this router adds would be the one thing with no test.
     */
    it('refuses in the envelope the frontend reads, not just with a status', async () => {
      await hammer(30, () =>
        request(listening(app)).put('/api/firsthand/studies/study_abc').send(validStudyBody)
      );

      const refused = await request(listening(app))
        .put('/api/firsthand/studies/study_abc')
        .send(validStudyBody);

      expect(refused.status).toBe(429);
      expect(refused.body).toEqual({
        error: 'Too many changes in a short time. Wait a minute and try again.'
      });
    });

    it('keeps reads and writes on separate buckets', async () => {
      await hammer(30, () =>
        request(listening(app)).put('/api/firsthand/studies/study_abc').send(validStudyBody)
      );

      // The write budget is spent. Reading is a different surface with a
      // different cost, and an author who has just saved thirty times must
      // still be able to see what they saved.
      const read = await request(listening(app)).get('/api/firsthand/studies/study_abc');
      expect(read.status).not.toBe(429);
    });

    it('keys the bucket on the user, not the ingress', async () => {
      await hammer(61, () => request(listening(app)).get('/api/firsthand/studies/study_abc'));

      // Behind two proxy hops `trust proxy: 1` resolves req.ip to the INGRESS,
      // so an IP-keyed bucket would be shared by every admin in the estate and
      // one runaway loop would refuse all of them.
      const other = await request(listening(buildApp({ id: 'other-admin', name: 'B', email: 'b@test.com', role: 'researcher_admin' }))).get('/api/firsthand/studies/study_abc');

      expect(other.status).not.toBe(429);
    });

    /**
     * THE ORDERING, which is what `perUserLimiter`'s own docstring is about.
     *
     * Mounted BEFORE `requireAdmin` the limiter spends a bucket on requests
     * that never reach a handler, and every one of them keys to the same
     * `'unauthenticated'` fallback - so anyone who can reach the route
     * unauthenticated could exhaust one shared bucket and refuse every admin.
     * The 401s must cost nothing.
     */
    it('spends no budget on requests that never authenticated', async () => {
      const anonymous = buildApp(null);

      const refused = await hammer(70, () =>
        request(listening(anonymous)).get('/api/firsthand/studies/study_abc')
      );
      expect(refused.every((code) => code === 401)).toBe(true);

      // Seventy unauthenticated attempts later, an admin is unaffected.
      const admin = await request(listening(app)).get('/api/firsthand/studies/study_abc');
      expect(admin.status).toBe(200);
    });

/**
     * THE CLASS, not the instances.
     *
     * The behavioural tests below each name ONE route, so the first version of
     * them left four of the seven unguarded and every one of those mutations
     * survived the whole suite. A route added later with no ceiling would be
     * just as invisible, and its failure mode is not a red test - it is
     * participants queueing on a five-connection pool.
     *
     * Walks the router's own stack, so it covers whatever this file grows.
     */
    /**
     * THE CLASS, not the instances - and WHICH bucket, not merely that there is
     * one.
     *
     * The behavioural tests below each name ONE route, so the first version of
     * them left four of the seven unguarded and every one of those mutations
     * survived the whole suite. Walking the router's own stack fixed that. But
     * asking only "does this route carry one of the limiters" left a second
     * hole behind it: a new route with the 200,001-row cost of the results read
     * could be mounted on the 60-a-minute READ bucket and pass, because
     * structurally it is correct and only semantically wrong.
     *
     * So this is a TABLE. A route added later is absent from it and fails,
     * which forces whoever adds it to write the bucket down as a decision
     * rather than inherit whichever one their copy-paste source used.
     */
    const EXPECTED_LIMITER: Record<string, unknown> = {
      'GET /studies': studyReadLimiter,
      'POST /studies': studyWriteLimiter,
      'GET /studies/:studyId': studyReadLimiter,
      'PUT /studies/:studyId': studyWriteLimiter,
      'DELETE /studies/:studyId': studyWriteLimiter,
      'GET /studies/:studyId/results': studyResultsLimiter,
      'GET /studies/:studyId/results.csv': studyResultsLimiter,
    };

    /**
     * Router-level middleware this router is allowed to carry.
     *
     * An allow-list rather than a blanket "there must be none", because the
     * blanket version goes red for a GOOD change - `ensureStudiesPersistence`
     * repeats at the top of six handlers and the natural tidy-up is
     * `router.use`. Red for that reads as "the test is wrong" and gets fixed by
     * deleting the line that catches a route with no ceiling. Add to this list
     * deliberately; never add a route handler to it.
     */
    const ROUTER_LEVEL_MIDDLEWARE: unknown[] = [];

    it('mounts the RIGHT limiter on every route, after the auth gate', () => {
      const stack = (firsthandRouter as unknown as {
        stack: Array<{
          handle?: unknown;
          route?: {
            path: string;
            methods: Record<string, boolean>;
            stack: Array<{ handle: unknown; name: string }>;
          };
        }>;
      }).stack;

      // A handler registered with `router.use`, or a nested sub-router, has no
      // `.route` - so filtering those out silently and asserting only the
      // survivors would let one ship unguarded and green.
      for (const layer of stack.filter((entry) => !entry.route)) {
        expect(ROUTER_LEVEL_MIDDLEWARE).toContain(layer.handle);
      }

      const layers = stack.filter((entry) => entry.route);

      // If this ever reads zero the assertions below are vacuous and the whole
      // test passes while checking nothing.
      expect(layers.length).toBeGreaterThanOrEqual(7);

      const seen: string[] = [];

      for (const layer of layers) {
        const route = layer.route!;
        const method = Object.keys(route.methods)[0].toUpperCase();
        const key = `${method} ${route.path}`;
        seen.push(key);

        const handlers = route.stack.map((entry) => entry.handle);
        const authIndex = handlers.indexOf(requireAdmin as unknown);
        const limiterIndex = handlers.findIndex((handle) => handle === EXPECTED_LIMITER[key]);

        expect({ key, authed: authIndex >= 0 }).toEqual({ key, authed: true });
        // Absent from the table, or on a different bucket than the table says.
        expect({ key, onItsBucket: limiterIndex >= 0 }).toEqual({ key, onItsBucket: true });
        // AFTER the auth gate, never before. Mounted first the limiter spends a
        // bucket on requests that never reach a handler, and every one of them
        // keys to the same `'unauthenticated'` fallback - one shared bucket
        // anyone could exhaust to refuse every admin.
        expect({ key, ordered: limiterIndex > authIndex }).toEqual({ key, ordered: true });
      }

      // And the table has no entries for routes that no longer exist, which
      // would otherwise rot into a list nobody trusts.
      expect(seen.sort()).toEqual(Object.keys(EXPECTED_LIMITER).sort());
    });

    it('puts the study list on the same read bucket as a single study', async () => {
      await hammer(60, () => request(listening(app)).get('/api/firsthand/studies/study_abc'));

      expect((await request(listening(app)).get('/api/firsthand/studies')).status).toBe(429);
    });

    it.each([
      ['create', () => request(listening(app)).post('/api/firsthand/studies').send(validStudyBody)],
      ['delete', () => request(listening(app)).delete('/api/firsthand/studies/study_abc')]
    ])('puts %s on the same write bucket as an update', async (_label, call) => {
      await hammer(30, () =>
        request(listening(app)).put('/api/firsthand/studies/study_abc').send(validStudyBody)
      );

      expect((await call()).status).toBe(429);
    });

    it('puts the results CSV on the same bucket as the results read', async () => {
      const superApp = buildApp({
        id: 'super-2', name: 'Super', email: 'super2@test.com', role: 'superadmin'
      });
      mockListResponsesForStudy.mockResolvedValue([]);
      resetFirsthandStudyLimits('super-2');

      await hammer(10, () =>
        request(listening(superApp)).get('/api/firsthand/studies/study_abc/results')
      );

      expect(
        (await request(listening(superApp)).get('/api/firsthand/studies/study_abc/results.csv')).status
      ).toBe(429);
    });

    it('limits the study-wide results read far tighter than its per-opportunity twin', async () => {
      const superApp = buildApp({
        id: 'super-1', name: 'Super', email: 'super@test.com', role: 'superadmin'
      });
      mockListResponsesForStudy.mockResolvedValue([]);
      resetFirsthandStudyLimits('super-1');

      const codes = await hammer(11, () =>
        request(listening(superApp)).get('/api/firsthand/studies/study_abc/results')
      );

      // 10, not the 60 `surveyResultsLimiter` uses. This read spans every
      // opportunity that ever used the study, no frontend calls it at all, and
      // each in-flight request can materialise 200,001 rows in the heap before
      // it decides to answer 413 - so enough of them together is an OOM of the
      // pod, which drops every live participant session.
      expect(codes.slice(0, 10).every((code) => code !== 429)).toBe(true);
      expect(codes[10]).toBe(429);
    });
  });

});

/**
 * A pool refusal is not a bad request.
 *
 * The create and update handlers answer their own errors as 400 with the raw
 * repository message, deliberately - a duplicate step id is a mistake the
 * author can fix. The admission cap in firsthand/runtime-pool-admission.ts
 * throws through those same handlers, and flattened into a 400 it tells an
 * author their study was rejected and invites them to change something. The
 * only correct action is to send the same request again in a moment.
 */
describe('a refusal from the runtime admission cap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsStudiesPersistenceConfigured.mockReturnValue(true);
    mockIsDatabaseAvailable.mockResolvedValue(true);
  });

  it('keeps its 503 through the create handler', async () => {
    mockCreateStudy.mockRejectedValue(new RuntimeDatabaseAdmissionTimeoutError(10_000));

    const response = await request(listening(app))
      .post('/api/firsthand/studies')
      .send(validStudyBody);

    expect(response.status).toBe(503);
    expect(response.body.error).not.toBe('create_failed');
    expect(response.body.message ?? response.body.error).toMatch(
      /busy with other work/i
    );
  });

  it('keeps its 503 through the update handler', async () => {
    mockUpdateStudy.mockRejectedValue(new RuntimeDatabaseBusyError());

    const response = await request(listening(app))
      .put('/api/firsthand/studies/study_1')
      .send(validStudyBody);

    expect(response.status).toBe(503);
    expect(response.body.error).not.toBe('update_failed');
    expect(response.body.message ?? response.body.error).toMatch(
      /busy with other work/i
    );
  });

  it('still answers 400 for a mistake the author can actually fix', async () => {
    // The other direction. Rethrowing everything would lose the repository
    // message the authoring form surfaces, which is the reason that catch
    // block exists at all.
    mockUpdateStudy.mockRejectedValue(new Error('duplicate step id: step_001'));

    const response = await request(listening(app))
      .put('/api/firsthand/studies/study_1')
      .send(validStudyBody);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'update_failed',
      message: 'duplicate step id: step_001'
    });
  });
});
