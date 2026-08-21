import { Router, Request, Response } from 'express';

import { requireAdmin } from '../middleware/authenticate';
import { logger } from '../utils/logger';
import { asyncHandler, ForbiddenError, NotFoundError } from '../utils/errorHandler';
import {
  canWriteStudy,
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
import {
  answerCountsByStep,
  listResponsesForStudy
} from '../firsthand/survey-results-repository';
import { stepKeyOf } from '../../../shared/firsthand/step-identity';
import { aggregateSurveyResults } from '../firsthand/survey-results';
import { toCsvContentDisposition, toResponsesCsv } from '../firsthand/survey-csv';

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
 * The read boundary for participants' answers. Returns for a requester who may
 * see them, and throws ForbiddenError for one who may not - so the refusal goes
 * through the shared error handler, the same as every other refusal in the
 * opportunities routes. It used to write its own `{error:'forbidden'}` body,
 * which made one logical resource answer two different shapes depending which
 * route you asked.
 *
 * **Superadmin only, deliberately, and this is the END STATE - not an interim
 * position.** It used to be one; phase 4e resolved it, and resolved it by
 * building a different route rather than by loosening this one.
 *
 * requireAdmin is nowhere near sufficient: the study list and the single study
 * GET above stay open to every admin on purpose, because study copy is
 * authoring metadata and an opportunity is meant to reuse a study it did not
 * author. Responses are the opposite of that, so they need their own boundary.
 *
 * The obvious boundary - the study's owner - is wrong here, which is why this
 * is stricter than it looks like it should be. These routes aggregate every
 * response for a study, across **every opportunity that used it**, and a study
 * is reusable by an opportunity its author did not create. Granting the study's
 * owner would hand them answers from participants another researcher recruited,
 * under that researcher's consent wording. No narrowing of THIS route fixes
 * that, because the breadth is the route's whole purpose.
 *
 * What a researcher gets instead is
 * `GET /api/opportunities/:id/survey-results` (and `.csv`), gated on the
 * opportunity owner exactly like `/:id/session-events`, filtered to the
 * answers that opportunity collected. That is the surface to extend when a
 * researcher cannot see something they should. Leave this one alone.
 *
 * Sessions minted before 7.37.0 carry no `opportunity_id`, so they are
 * unattributable and reachable only from here - which is the other reason this
 * route still exists.
 *
 * Note this also refuses a study with no owner at all, where the write path
 * (canWriteStudy) fails OPEN so legacy rows stay editable by whoever wrote
 * them. A read cannot adopt the row the way a write does, and an unowned study
 * is precisely the case where nobody can be held accountable for the data.
 */
function requireSuperadminForStudyResults(req: Request): void {
  if (studyRequester(req).isSuperadmin) {
    return;
  }

  // Logged explicitly for the same reason sendStudyWriteFailure logs: an
  // attempt on participant answers should never be silent.
  logger.warn('Refused a study results read below superadmin', {
    studyId: req.params.studyId,
    userId: req.user?.id
  });

  throw new ForbiddenError(
    'Only a superadmin can view survey responses across every opportunity'
  );
}

// GET /api/firsthand/studies - list studies for the Cortex study picker
//
// Reads stay open to every admin, deliberately. The opportunity form's study
// picker (FirstHandStudyTab) lists every LAUNCHED study so an opportunity can
// reuse one it did not author - that is a designed feature, and filtering the
// list by owner would break it. Study copy is authoring metadata, not
// participant data; the boundary this MR draws is over WRITES.
//
// B3's copy-on-select reads from exactly this list - it is what the picker
// already showed - and copying grants no new read capability: the picker
// could always see (and select) any launched study, it just used to link to
// it rather than copy it.
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

  // Whether THIS reader may edit the study, decided by the same predicate the
  // write path uses rather than by a second copy of the rule in the client.
  //
  // Advisory, not a gate: it is read outside any transaction, so an owner
  // change between this read and a later save would make it stale. Every write
  // still re-checks under `FOR UPDATE` and answers 403. It exists so the
  // opportunity form can show an author their own study as an editable surface
  // and a colleague's as a read-only one, instead of guessing from an owner id
  // and getting the unowned-legacy case wrong.
  const can_edit = canWriteStudy(stored.study.owner_user_id, studyRequester(req));

  /**
   * How many answers each question has collected, so the authoring form can
   * tell an author what removing one would do to them.
   *
   * Keyed by STEP KEY, not by the stored step id. The key is the only half of
   * that id the form holds - a question card's `_clientId` IS its step key -
   * and keeping the `${studyId}_` namespacing on the server is the whole
   * arrangement step-identity.ts sets up: the client never mints or handles a
   * whole id, so it cannot produce one claiming to belong to another study.
   *
   * A count whose id falls outside this study's namespace is DROPPED rather
   * than passed through under its raw id. Nothing this product writes produces
   * one - the form is offered such a study read-only - but a raw id in this map
   * either matches no card, which is merely useless, or collides with a real
   * key, which would report another study's answers against this one's
   * question.
   *
   * `null` survives as `null`. It means the count could not be read, which is a
   * different fact from "no question has any answers", and flattening the two
   * would drop the warning exactly when the runtime database is under the
   * pressure that suggests there are participants answering right now.
   *
   * NOT READ AT ALL unless this caller could act on the answer, and that is a
   * disclosure boundary rather than an optimisation. `updateLinkedStudyContent`
   * moved its ownership check AHEAD of `studyHasResponses` for exactly this
   * reason: whether a study has collected answers, and how many, is a fact
   * about somebody else's research that a colleague was never granted.
   *
   * Three conditions, and each is load-bearing:
   *
   * `can_edit`, because these counts exist to warn an author BEFORE they remove
   * a question, and a reader shown the study read-only has no Remove control to
   * be warned about. Nothing is lost by withholding them.
   *
   * A KNOWN OWNER, which `can_edit` alone does not give. `canWriteStudy` fails
   * OPEN for `owner_user_id IS NULL` so legacy rows stay editable by whoever
   * wrote them - right for a write, which adopts the row, and wrong here.
   * `requireSuperadminForStudyResults` above already made this exact call for
   * the results read and wrote down why: a read cannot adopt the row the way a
   * write does, and an unowned study is precisely the case where nobody can be
   * held accountable for the data. This is a read, so it follows the read.
   * Every admin can list launched studies and the picker fetches any of them to
   * preview, so without this an unattributed legacy study would report its
   * per-question participation volume to anyone.
   *
   * And `kind === 'survey'`, because "Removed questions" is a section of the
   * survey results view. A recorded task list has no surface on which its
   * author could be shown a count, so reading one spends a runtime connection
   * and widens the response for a value nothing consumes.
   *
   * WITHHELD IS NOT THE SAME AS UNKNOWN, and the response says which.
   *
   * `answer_counts: null` means the count was attempted and could not be
   * established, and the form renders that as "could not be checked". OMITTING
   * the key means no count is being offered at all - the three conditions above
   * said no, or this is a backend older than the field. The form then says
   * nothing about answers, exactly as it did before any of this existed.
   *
   * Collapsing the two put the cautious wording on every card of every unowned
   * legacy survey, permanently - including a card the author had minted seconds
   * earlier and which provably cannot have been answered by anyone. That is the
   * dialog-fatigue the empty-card exemption exists to prevent, and it would
   * have disabled that exemption for exactly the studies nobody is accountable
   * for.
   */
  const mayReadCounts =
    can_edit && stored.study.owner_user_id !== null && stored.study.kind === 'survey';

  const storedCounts = mayReadCounts ? await answerCountsByStep(stored.study.id) : undefined;

  const answer_counts =
    storedCounts === undefined || storedCounts === null
      ? storedCounts
      : Object.fromEntries(
          Object.entries(storedCounts).flatMap(([stepId, count]) => {
            const key = stepKeyOf(stepId, stored.study.id);
            return key === null ? [] : [[key, count] as const];
          })
        );

  // `undefined` is dropped by JSON.stringify, so a withheld count leaves the
  // key off the response rather than sending a value the client has to
  // interpret.
  return res.json({ study: stored.study, steps: stored.steps, can_edit, answer_counts });
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

    // Split out of the payload rather than passed through with it. It is a
    // PRECONDITION, not a column: `UpdateStudyInput` is the set of things to
    // write, and leaving a non-column in it would invite the next field added
    // to the dynamic update builder to pick it up.
    const { expected_updated_at: expectedUpdatedAt, ...studyInput } = parsed.data;

    const updated = await updateStudy(
      req.params.studyId,
      studyInput,
      requester,
      expectedUpdatedAt
    );

    if (updated.ok === false && updated.reason === 'stale') {
      // The security event's quiet twin: a refused write nobody would otherwise
      // hear about. `updated_by_user_id` is logged HERE and not returned to the
      // caller - see below.
      logger.info('Refused a stale study write', {
        studyId: req.params.studyId,
        userId: requester.userId
      });

      return res.status(409).json({
        error: 'stale_study',
        // Names WHEN, not WHO, and that is a decision rather than an omission.
        //
        // The row records who wrote it (migration 0014) and the line above puts
        // it within reach of an operator. Putting a colleague's identity in this
        // BODY is a different act: `GET /api/firsthand/studies` is unfiltered by
        // owner and `canWriteStudy` fails open on an unowned legacy study, so
        // the audience for this sentence is every researcher_admin, not just the
        // study's owner. Telling all of them which colleague edited which study
        // is a disclosure the product has not asked for and this MR should not
        // decide by accident. Resolving the id to a name would also mean
        // reaching into the app schema's `users` table from this router, which
        // has never touched the other pool.
        message:
          'Somebody else saved changes to this task list after you opened it. Your edits have not been saved and are still here.',
        // The row as it stands now, so the client can offer a deliberate
        // re-save instead of leaving the author stuck re-sending a token that
        // can never match again.
        current_updated_at: updated.current_updated_at
      });
    }

    if (!updated.ok) {
      return sendStudyWriteFailure(res, updated, 'edit', req);
    }

    if (expectedUpdatedAt === undefined) {
      // Fail-open is deliberate (see updateStudy's docstring) but must not be
      // silent: a bundle that stopped sending the precondition would otherwise
      // lose the protection with nothing anywhere to say so.
      //
      // Logged HERE, after the write, rather than on the way in. A request that
      // 404s or 403s updated nothing, and a line claiming an unprotected update
      // for one would be noise in exactly the place an operator is looking for
      // signal.
      logger.warn('Study updated with no concurrency precondition', {
        studyId: req.params.studyId,
        userId: requester.userId
      });
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
    throw new NotFoundError('Survey');
  }

  requireSuperadminForStudyResults(req);

  const responses = await listResponsesForStudy(req.params.studyId);

  // The same envelope the per-opportunity reader returns. One logical resource
  // answered two ways is how the two mint routes started drifting.
  return res.json({
    title: stored.study.title,
    results: aggregateSurveyResults(stored.steps, responses)
  });
}));

// GET /api/firsthand/studies/:studyId/results.csv - raw answers for export
router.get('/studies/:studyId/results.csv', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  const stored = await getStudyById(req.params.studyId);
  if (!stored) {
    throw new NotFoundError('Survey');
  }

  // Gated before the download headers are set, not just before the send: a
  // refusal that had already set Content-Disposition would still offer a file.
  requireSuperadminForStudyResults(req);

  const responses = await listResponsesForStudy(req.params.studyId);

  // Both the header and the body are built before either header is set. A
  // throw after setHeader would be served as text/csv, so the browser would
  // download the error rather than show it.
  const disposition = toCsvContentDisposition(stored.study.title);
  const body = toResponsesCsv(stored.steps, responses);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', disposition);

  return res.send(body);
}));

// The HMAC callback receiver (POST /api/firsthand/callbacks) is gone: the merge
// deletes the cross-app hop. Internalised sessions write lifecycle events to
// opportunity_session_events in-process (see firsthand/completion-events.ts),
// so there is no second app to call back.

export default router;
