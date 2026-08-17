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
import { listResponsesForStudy } from '../firsthand/survey-results-repository';
import { aggregateSurveyResults } from '../firsthand/survey-results';
import { toResponsesCsv } from '../firsthand/survey-csv';

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

/**
 * The read boundary for participants' answers. Answers true when this requester
 * may see them; otherwise answers the response itself and returns false.
 *
 * requireAdmin is not sufficient on its own. The study list and the single
 * study GET above stay open to every admin on purpose - study copy is authoring
 * metadata, and an opportunity is meant to reuse a study it did not author -
 * but responses are participant data, and the reason those reads are open is
 * precisely that they are not. Without this, any researcher_admin could read,
 * and CSV-export, every other researcher's survey responses.
 *
 * Deliberately STRICTER than the repository's canWriteStudy, which fails OPEN
 * on a null owner so that legacy rows predating owners stay editable by the
 * people who authored them. That reasoning does not carry over:
 *
 * - A write adopts the row it touches, so the unowned population shrinks. A
 *   read must not claim ownership, so it has no equivalent way to close.
 * - Responses only exist for a study that reached a participant, a study only
 *   reaches a participant through an opportunity, and linking one claims
 *   ownership atomically (claimStudyIfUnowned). So an unowned study holding
 *   answers should not arise.
 *
 * If one does arise anyway, refusing is the recoverable direction: a superadmin
 * can assign an owner, whereas answers handed to the wrong researcher cannot be
 * recalled.
 */
function mayReadStudyResults(
  res: Response,
  study: { owner_user_id: string | null },
  req: Request
): boolean {
  const requester = studyRequester(req);

  if (requester.isSuperadmin || study.owner_user_id === requester.userId) {
    return true;
  }

  // Mirrors sendStudyWriteFailure's warning for the same reason: these handlers
  // answer directly rather than throwing, so nothing else logs the attempt.
  logger.warn('Refused a cross-owner study results read', {
    studyId: req.params.studyId,
    userId: req.user?.id
  });

  res.status(403).json({
    error: 'forbidden',
    message: 'Only the owner of this task list can view its responses'
  });

  return false;
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

// ─── Survey results ──────────────────────────────────────────────────────────
// Aggregated answers for a natively-run poll or survey. requireAdmin like every
// other route here: responses are participant data and must never be reachable
// without an admin session.

// GET /api/firsthand/studies/:studyId/results - aggregated answers
router.get('/studies/:studyId/results', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const stored = await getStudyById(req.params.studyId);
  if (!stored) {
    return res.status(404).json({ error: 'not_found' });
  }

  if (!mayReadStudyResults(res, stored.study, req)) return;

  const responses = await listResponsesForStudy(req.params.studyId);

  return res.json({
    study: { id: stored.study.id, title: stored.study.title },
    results: aggregateSurveyResults(stored.steps, responses)
  });
}));

// GET /api/firsthand/studies/:studyId/results.csv - raw answers for export
router.get('/studies/:studyId/results.csv', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const stored = await getStudyById(req.params.studyId);
  if (!stored) {
    return res.status(404).json({ error: 'not_found' });
  }

  // Gated before the download headers are set, not just before the send: a
  // refusal that had already set Content-Disposition would still offer a file.
  if (!mayReadStudyResults(res, stored.study, req)) return;

  const responses = await listResponsesForStudy(req.params.studyId);

  // The study title is admin-authored free text, and an unescaped quote or
  // newline in a Content-Disposition header splits it, so it is stripped
  // before being interpolated into the quoted filename.
  const safeTitle =
    stored.study.title.replace(/["\\\r\n]/g, '').slice(0, 80).trim() || 'survey';

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle} responses.csv"`);

  return res.send(toResponsesCsv(stored.steps, responses));
}));

// The HMAC callback receiver (POST /api/firsthand/callbacks) is gone: the merge
// deletes the cross-app hop. Internalised sessions write lifecycle events to
// opportunity_session_events in-process (see firsthand/completion-events.ts),
// so there is no second app to call back.

export default router;
