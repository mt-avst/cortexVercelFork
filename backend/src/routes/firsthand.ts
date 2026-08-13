import { Router, Request, Response } from 'express';

import { requireAdmin } from '../middleware/authenticate';
import { logger } from '../utils/logger';
import { asyncHandler } from '../utils/errorHandler';
import {
  createStudy,
  deleteStudy,
  getStudyById,
  isStudiesPersistenceConfigured,
  listStudies,
  updateStudy,
  type StudyRequester,
  type StudyWriteFailure
} from '../firsthand/studies-repository';
import {
  createStudyRequestSchema,
  updateStudyRequestSchema
} from '../../../shared/firsthand/study-input';

const router: Router = Router();

// ─── Studies CRUD (B3a) ──────────────────────────────────────────────────────
// In-process studies persistence, replacing the FirstHand HMAC proxy. Gated on
// Cortex requireAdmin (H4): FirstHand's reviewer OIDC (reviewer-auth-server /
// reviewer-auth / reviewer-oidc / requireStaffPageSession) is intentionally NOT
// ported — the Cortex backend is the single Okta owner and admins are the sole
// study authors.

// Mirrors FirstHand's requireStaff persistence guard: fail loud with 503 when
// no runtime database is configured so a misconfig never silently no-ops.
function ensureStudiesPersistence(res: Response): boolean {
  if (!isStudiesPersistenceConfigured()) {
    res.status(503).json({
      error: 'persistence_not_configured',
      message: 'Task lists require a configured PostgreSQL database.'
    });
    return false;
  }
  return true;
}

// requireAdmin already guarantees a session user and one of the two admin
// roles, so req.user is non-null on every handler below.
function studyRequester(req: Request): StudyRequester {
  return {
    userId: req.user!.id,
    isSuperadmin: req.user!.role === 'superadmin'
  };
}

// Shared by PUT and DELETE. The body shape follows this file's own local error
// responses (`not_found`, `invalid_payload`) rather than the ForbiddenError
// envelope the opportunities routes throw: these handlers answer directly
// instead of going through errorHandler. `message` is what the study editor
// surfaces (extractSaveError prefers it), so it has to name the actual reason.
function sendStudyWriteFailure(
  res: Response,
  failure: StudyWriteFailure,
  verb: string,
  req: Request
) {
  if (failure.reason === 'not_found') {
    return res.status(404).json({ error: 'not_found' });
  }

  // The security event this whole change exists to produce. These handlers
  // answer directly instead of throwing ForbiddenError, so they never reach
  // errorHandler, which is what logs the opportunities equivalent - without
  // this line a cross-owner attempt on a launched study is completely silent.
  logger.warn('Refused a cross-owner study write', {
    studyId: req.params.studyId,
    userId: req.user?.id,
    verb
  });

  return res.status(403).json({
    error: 'forbidden',
    message: `Only the owner of this task list can ${verb} it`
  });
}

// GET /api/firsthand/studies - list studies for the Cortex study picker
//
// Reads stay open to every admin, deliberately. The opportunity form's study
// picker (FirstHandStudyTab) lists every LAUNCHED study so an opportunity can
// reuse one it did not author - that is a designed feature, and filtering the
// list by owner would break it. Study copy is authoring metadata, not
// participant data; the boundary this MR draws is over WRITES.
router.get('/studies', requireAdmin, asyncHandler(async (_req: Request, res: Response) => {
  // listStudies() returns [] when persistence is unconfigured, matching the
  // FirstHand list endpoint's soft-empty behaviour.
  const studies = await listStudies();
  res.json({ studies });
}));

// POST /api/firsthand/studies - create a study
router.post('/studies', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const parsed = createStudyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  }

  try {
    // Owner taken from the session, never from the body: a client-supplied
    // owner would let an author plant a study under someone else's name.
    const stored = await createStudy({ ...parsed.data, owner_user_id: req.user!.id });
    return res.status(201).json({ study: stored.study, steps: stored.steps });
  } catch (error) {
    return res.status(400).json({
      error: 'create_failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

// GET /api/firsthand/studies/:studyId - fetch a single study with its steps
router.get('/studies/:studyId', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const stored = await getStudyById(req.params.studyId);
  if (!stored) {
    return res.status(404).json({ error: 'not_found' });
  }

  return res.json({ study: stored.study, steps: stored.steps });
}));

// PUT /api/firsthand/studies/:studyId - update a study
router.put('/studies/:studyId', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const parsed = updateStudyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  }

  try {
    const requester = studyRequester(req);
    const updated = await updateStudy(req.params.studyId, parsed.data, requester);
    if (!updated.ok) {
      return sendStudyWriteFailure(res, updated, 'edit', req);
    }

    if (updated.claimed) {
      // An ownership transfer with no UI and no undo below superadmin. If an
      // author reports losing access to a study, this line is the only record
      // of when it changed hands and to whom.
      logger.info('Unowned study claimed by its first editor', {
        studyId: req.params.studyId,
        newOwnerUserId: requester.userId
      });
    }

    return res.json({ study: updated.study, steps: updated.steps });
  } catch (error) {
    // Answered as 400 to preserve the raw repository message the authoring UI
    // relies on (a duplicate step id is a user-fixable mistake), but the cause
    // can equally be a dropped connection or a broken invariant - 500-class
    // failures that would otherwise be invisible, since answering here skips
    // errorHandler and its logging.
    logger.error('Study update failed', {
      studyId: req.params.studyId,
      userId: req.user?.id,
      error: error instanceof Error ? error.stack ?? error.message : String(error)
    });

    return res.status(400).json({
      error: 'update_failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

// DELETE /api/firsthand/studies/:studyId - delete a study
router.delete('/studies/:studyId', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const removed = await deleteStudy(req.params.studyId, studyRequester(req));
  if (!removed.ok) {
    return sendStudyWriteFailure(res, removed, 'delete', req);
  }

  return res.json({ ok: true });
}));

// The HMAC callback receiver (POST /api/firsthand/callbacks) is gone: the merge
// deletes the cross-app hop. Internalised sessions write lifecycle events to
// opportunity_session_events in-process (see firsthand/completion-events.ts),
// so there is no second app to call back.

export default router;
