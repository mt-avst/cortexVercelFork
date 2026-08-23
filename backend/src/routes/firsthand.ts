import { Router, Request, Response } from 'express';

import { requireAdmin } from '../middleware/authenticate';
import { perUserLimiter } from '../middleware/per-user-rate-limit';
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
  listResponsesForStudy,
  openSurveyCsvExport
} from '../firsthand/survey-results-repository';
import { writeSurveyCsv } from '../firsthand/survey-csv-response';
import { isRuntimePoolRefusal } from '../firsthand/runtime-pool-admission';
import { boundResultsRead } from '../middleware/results-read-concurrency';
import { stepKeyOf } from '../../../shared/firsthand/step-identity';
import { aggregateSurveyResults } from '../firsthand/survey-results';
import { toCsvContentDisposition } from '../firsthand/survey-csv';

const router: Router = Router();

/**
 * Reading a study is not free, and this router was the one runtime-pool
 * consumer with no ceiling on it at all.
 *
 * Exported, with its two siblings, so the test can assert WHICH bucket each
 * route is on rather than merely that it is on one. A tuple of "any of these"
 * was the first shape and it could not tell a cheap metadata read from a
 * 200,001-row export sharing its ceiling - see the table in firsthand.test.ts.
 *
 * `GET /studies/:studyId` takes TWO connections from the five-connection
 * FirstHand runtime pool that live participant sessions share - one for
 * `getStudyById`, a second for `answerCountsByStep` - and the second is a scan
 * over every answer row the study has collected. The pool has
 * `connectionTimeoutMillis: 10_000` and no statement timeout, so a caller
 * looping this at any concurrency above five makes participants writing their
 * answers queue on `pool.connect()` and fail after ten seconds, mid-survey.
 * Their own limiter does not protect them from that; it limits THEM.
 *
 * 60 a minute leaves the real workflow untouched. The opportunity form re-reads
 * the linked study on load and again after every successful save, and an author
 * moving between opportunities does several a minute legitimately.
 *
 * A backstop against a runaway loop, not a quota - the same status as every
 * other limiter here. The MemoryStore is per PROCESS, so with more than one
 * backend pod the effective ceiling is this times the pod count.
 *
 * AND IT BOUNDS ARRIVALS, NOT OCCUPANCY, which is the honest limit of this
 * control and is written here so nobody reads the finding it answers as closed.
 * Sixty permitted reads fired at once are sixty concurrent handlers taking two
 * pool checkouts each, and a participant's write then queues behind them and
 * fails at `connectionTimeoutMillis`. What this stops is SUSTAINED abuse; a
 * single burst inside the ceiling still competes with participants. Bounding
 * that needs a concurrency cap on admin-originated checkouts, which is a change
 * to `withRuntimeDatabaseClient` and its own piece of work.
 */
export const studyReadLimiter = perUserLimiter(
  60,
  'Too many requests for these questions. Wait a minute and try again.'
);

/**
 * Writing is heavier again: `updateStudy` rewrites the step rows for the whole
 * study, and `createStudy` inserts a study plus up to 51 steps, all on that same
 * five-connection pool.
 *
 * 30 a minute matches `opportunityWriteLimiter`, which guards the other door
 * into the same tables for the same reason. Two ceilings on one cost that
 * disagreed would be the drift `perUserLimiter`'s own docstring was written
 * about.
 */
export const studyWriteLimiter = perUserLimiter(
  30,
  'Too many changes in a short time. Wait a minute and try again.'
);

/**
 * The study-wide results reads, which are superadmin-only and unpaginated.
 *
 * 10 a minute, and NOT the 60 its per-opportunity twin uses. Matching
 * `surveyResultsLimiter` was the first instinct and it is the wrong axis on
 * both counts:
 *
 * `listResponsesForOpportunity` reads one opportunity's answers.
 * `listResponsesForStudy` reads every opportunity that ever used the study - a
 * strict superset, multiplied by the reuse the study picker actively
 * encourages. The same number prices two different orders of magnitude.
 *
 * And the justification behind the 60 does not carry: it exists because the
 * Responses tab refetches on every visit. NOTHING in the frontend calls either
 * of these two routes. They are a superadmin surface reached by hand, so a
 * tight ceiling costs no UX at all.
 *
 * The cost being bounded here is MEMORY as much as the pool.
 * `listResponsesWhere` materialises up to 200,001 rows in the heap BEFORE it
 * decides to answer 413, then the aggregator or the CSV writer builds a second
 * structure over them and the response body a third. The 413 protects the
 * caller from a truncated answer; it does nothing for the process. Enough of
 * these in flight together is an OOM of the pod, which drops every live
 * participant session and not just the caller's.
 *
 * Its own bucket rather than sharing `studyReadLimiter`: a superadmin reading
 * results and an author reloading a form are different surfaces, and spending
 * one budget should not refuse the other.
 */
export const studyResultsLimiter = perUserLimiter(
  10,
  'Too many requests for these responses. Wait a minute and try again.'
);

/**
 * Clears this router's limiters for one caller. A test seam, and only that.
 *
 * The counters live in an in-process MemoryStore that outlives an individual
 * test, so a suite exercising these routes hundreds of times as one admin
 * exhausts them and every later assertion fails as a 429 - which reads as a
 * route bug rather than as the limiter working. Same seam, same reasoning, as
 * `resetParticipantRouteLimits` in opportunities.ts.
 */
export function resetFirsthandStudyLimits(userId: string): void {
  studyReadLimiter.resetKey(userId);
  studyWriteLimiter.resetKey(userId);
  studyResultsLimiter.resetKey(userId);
}

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
/**
 * MUST BE CALLED BEFORE THE STUDY IS LOADED, and it reads nothing but the
 * role so that it can be. Called after, the 404 for a study that does not
 * exist is distinguishable from the 403 for one that does, which tells a
 * researcher_admin whether a study id they may not read exists.
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
// Unfiltered by owner, deliberately, and this is an instance of the model set
// out below rather than a decision of its own.
//
// THE TRUST MODEL THIS ROUTE IS AN INSTANCE OF (cto/AdaptaLabs#10, closed
// won't-fix). Recorded here because this is where a reader lands, and because
// review gates rediscovered it from several directions and wrote it up as a
// finding each time. It is a decision, not an oversight.
//
// THREE DISPOSITIONS, because two produced a false positive on the first public
// route a gate applied them to.
//
//   PUBLISHED - open to everyone by product decision. GET /api/stats/platform
//     (three integers, no identities) and the gamification leaderboards, which
//     do publish a participant's NAME and participation volume. Whether the
//     collection consent covers that is #17 and is NOT established from this
//     repository, so do not read this row as sign-off.
//     The public opportunity reads are NOT blanket-blessed: what is published
//     is the payload AFTER `toPublicOpportunity` / `toPublicSession` strips
//     owner identity and the joining link. THE STRIPPING IS THE BOUNDARY - and
//     the meet link is closer to a credential than to a detail. BOTH names
//     matter: /:id/sessions goes through the SECOND one, and that is the route
//     which leaked for the whole life of the first version of the fix. See
//     utils/publicOpportunity.ts.
//   METADATA - open to every admin on the authoring read routes. Study copy,
//     step content, titles, owners, launch state, the existence of an id.
//   PARTICIPANT DATA - answers, per-question answer COUNTS, transcripts,
//     recordings, session events, participant names and emails in a BOOKING
//     context, and a researcher's `admin_notes` about a named colleague.
//
// WHO MAY REACH PARTICIPANT DATA. Read the headings precisely; they differ.
//
//   † THE GATE IS HELD BY NO TEST. Deleting it passes the whole suite on both
//     runners with `tsc` clean - measured, not assumed, one row at a time.
//     NO ROW CARRIES ONE TODAY. The last four rows carrying it held FIVE gates
//     - approve and reject are one row and two handlers - and #21 closed all
//     five, each with a control arm proving the test can fail. All five are in
//     the mutation canary too, so coming unpinned again fails a named job
//     rather than going quiet. The marker stays defined because the next row
//     added here will need it before its test exists.
//   ‡ Compares owner to caller with a bare `===` or `!==`, which admits a
//     null-owner/null-caller pair. NO ROW CARRIES ONE TODAY: #12 replaced all
//     twenty-five comparisons IN THE ROUTE LAYER with `isOpportunityOwner`,
//     which refuses that pair and is unit-tested against it, and a source
//     scanner with its own control now fails by name if one comes back -
//     routes/__tests__/owner-comparisons-go-through-the-helper.test.ts.
//     THE SCANNER READS routes/*.ts AND NOTHING ELSE, which matters for one
//     row above: `answer_counts` reaches `canWriteStudy` in
//     firsthand/studies-repository.ts, and that still compares owner to
//     requester with a bare `===`. Deliberately - it FAILS OPEN on a null
//     owner so legacy studies stay editable, the opposite disposition, and
//     `mayReadCounts` re-adds the null check on the read side where a row
//     cannot be adopted. That separate term IS pinned by name.
//
//   WHAT AN UNMARKED ROW NOW MEANS, said precisely because every row is one:
//   a named test fails if that route stops CONSULTING ownership. It does not
//   mean the gate's every property is pinned, and it does not mean the row is
//   the right policy. It means the gate cannot be deleted in silence.
//
//   the OPPORTUNITY owner, or a superadmin
//     GET  /:id/survey-results and .csv     loadOpportunityResultsContext
//     GET  /:id/session-events              inline, opportunities.ts
//     GET  /:id/analytics                   inline, opportunities.ts
//     GET  /:id/sessions/:sid/outputs
//     GET    .../assets/:aid/media          assertOpportunityOwnership,
//                                             routes/session-outputs.ts
//                                           - one GATE, which both of these
//                                             routes share
//     GET  /api/bookings/pending-approvals  owner-scoped in SQL, bookings.ts
//     POST /api/bookings/:bookingId/approve|reject  a WRITE, listed here
//                                             because it authors admin_notes
//                                             about a named participant
//     GET  /api/admin/dashboard             recent_bookings, admin.ts
//     GET  /api/admin/export/bookings       admin.ts
//   the OPPORTUNITY owner AND NOBODY ELSE, not even a superadmin
//     GET  /api/bookings/opportunities/:id/bookings   bookings.ts
//     The odd one out, and not obviously intended. Named so a reader trained
//     on the headings above is not surprised by a 403 - and now pinned in
//     both directions, so resolving it either way is a decision somebody
//     makes on purpose rather than a line that quietly goes missing.
//   the STUDY owner, or a superadmin, and only for a COUNT
//     GET  /studies/:studyId -> answer_counts       `mayReadCounts`, below
//   a SUPERADMIN AND NOBODY ELSE, not even the study's own owner
//     GET  /studies/:studyId/results and .csv  requireSuperadminForStudyResults
//   the PARTICIPANT, bound to their own session token
//     every route on the firsthand-session router   bindParticipantSession
//     Structurally enforced: an unguarded route added there fails by name.
//
//   STILL NOT AN INVENTORY, in BOTH directions - see the third reopen trigger.
//   A row's absence means nobody tabulated it, never that it is safe; a row's
//   presence means the gate exists today, and only an unmarked row means
//   anything checks that it still does.
//
// WHY METADATA IS OPEN: `researcher_admin` is held by the handful of people who
// run the research, and the opportunity form's picker (FirstHandStudyTab)
// exists to show them each other's work - it lists every study, since
// `listStudies()` carries no WHERE clause and the launched-only presentation is
// the CLIENT's, so an opportunity can reuse a study it did not author.
// Filtering by owner would break a designed feature. B3's copy-on-select reads
// this same list and grants no new read capability; the picker could always see
// and select any study, it just used to link rather than copy. Hence also #10
// closing the remaining 404-vs-403 inconsistency across the opportunity
// siblings as churn rather than as a leak.
//
// TWO SITTING ON THE LINE, both measured, neither decided: `clicks_total` on
// /api/opportunities (#19), and GET /api/feedback and /export, which are
// requireAdmin only while DELETE on the same resource is superadmin (#15).
//
// A WARNING ABOUT admin.ts, because a draft of this block got it wrong and the
// wrong version would have caused the leak. It said the dashboard's owner
// scoping was "for relevance, not secrecy". ONE `filterOwnerId` there governed
// FIVE queries and the fifth returns participant names and emails, so widening
// it because the COUNTS look presentational passed the whole suite on both
// runners and disclosed another owner's participants. AND THERE WERE TWO OF
// THEM - one per handler, separate declarations, each unpinned, each carrying
// names and emails, so fixing "the" one audited half the file. #16.
//
// BOTH ARE FIXED, and the fix is a shape rather than a test: the dashboard now
// declares `countsOwnerId` and `participantIdentityOwnerId` separately, so the
// argument that persuaded a reader about the counts cannot reach the identity
// read in the same edit. All three constants are pinned by name, and two are
// in the mutation canary. THE UNDERLYING HAZARD IS NOT CLOSED - it is that
// counts and identities can share a scope at all - so read this before adding
// a sixth query to that handler.
//
// REOPEN IT IF ANY OF THESE BECOMES TRUE. The first two are the environment
// changing; the third is one an ordinary afternoon's work can trip:
//
//  - `researcher_admin` becomes a broadly granted role rather than one held by
//    the research team. The model rests entirely on that population being small
//    and mutually accountable;
//  - Cortex serves more than one organisation. Metadata open within one research
//    team is a cross-tenant leak the moment there are two, and every read above
//    would need a tenant predicate rather than a role check;
//  - A ROUTE OR A HANDLER BEGINS RETURNING PARTICIPANT DATA FROM OUTSIDE THE
//    ENUMERATED SET. Not "a route is added" - GET /api/calendar/events already
//    exists and is one stubbed service away from it (#18). There is no
//    exhaustive authorisation inventory: the router-walking tables cover only
//    the opportunities, firsthand and firsthand-session routers, so
//    session-outputs.ts, admin.ts, bookings.ts, calendar.ts, feedback.ts and
//    api.ts are in none. An ungated route returning a session's answers, added
//    to session-outputs.ts, fails NOTHING; added to THIS file it fails two
//    named tests. Measured both ways - #13.
//
// TRIAGING A FUTURE FINDING. "An admin can see another admin's study, or that
// an opportunity id exists" is describing this decision; do not spend a gate
// round on it. "An admin can see another admin's PARTICIPANT DATA" is a defect
// unless the table above accounts for it. Where it is not obvious, the question
// is not "is this metadata?" but "could a participant have expected this to
// stay with the researcher who recruited them?".
router.get('/studies', requireAdmin, studyReadLimiter, asyncHandler(async (_req: Request, res: Response) => {
  // listStudies() returns [] when persistence is unconfigured, matching the
  // FirstHand list endpoint's soft-empty behaviour.
  const studies = await listStudies();
  res.json({ studies });
}));

// POST /api/firsthand/studies - create a study
router.post('/studies', requireAdmin, studyWriteLimiter, asyncHandler(async (req: Request, res: Response) => {
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
    // A busy runtime pool is not an invalid payload. Rethrown so errorHandler
    // answers the 503 the error already carries: 400 tells the author their
    // study was rejected and invites them to change it, when the only correct
    // action is to send the same request again in a moment.
    if (isRuntimePoolRefusal(error)) throw error;

    return res.status(400).json({
      error: 'create_failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

// GET /api/firsthand/studies/:studyId - fetch a single study with its steps
router.get('/studies/:studyId', requireAdmin, studyReadLimiter, asyncHandler(async (req: Request, res: Response) => {
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
router.put('/studies/:studyId', requireAdmin, studyWriteLimiter, asyncHandler(async (req: Request, res: Response) => {
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
    // See the create route: a refusal from the admission cap keeps its own
    // 503 rather than being flattened into "your edit was rejected".
    if (isRuntimePoolRefusal(error)) throw error;

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
router.delete('/studies/:studyId', requireAdmin, studyWriteLimiter, asyncHandler(async (req: Request, res: Response) => {
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
router.get('/studies/:studyId/results', requireAdmin, studyResultsLimiter, boundResultsRead, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  // AUTHORISATION BEFORE EXISTENCE, and the order is the whole point. Loading
  // first meant a non-superadmin got 404 for a study id that does not exist
  // and 403 for one that does - an existence oracle over study ids, handed to
  // a caller entitled to neither answer.
  //
  // Free here, because this gate reads nothing but the caller's role: it does
  // not need the study to decide. That is not true of the opportunity results
  // routes, where ownership cannot be known without the row, so there is no
  // order that answers before it knows. They close the same oracle by
  // COLLAPSING instead - answering the same 403 to any non-superadmin, found
  // or not - which lands on the same status as this side by design rather
  // than by coincidence.
  requireSuperadminForStudyResults(req);

  const stored = await getStudyById(req.params.studyId);
  if (!stored) {
    throw new NotFoundError('Survey');
  }

  const responses = await listResponsesForStudy(req.params.studyId);

  // The same envelope the per-opportunity reader returns. One logical resource
  // answered two ways is how the two mint routes started drifting.
  return res.json({
    title: stored.study.title,
    results: aggregateSurveyResults(stored.steps, responses)
  });
}));

// GET /api/firsthand/studies/:studyId/results.csv - raw answers for export
router.get('/studies/:studyId/results.csv', requireAdmin, studyResultsLimiter, boundResultsRead, asyncHandler(async (req: Request, res: Response) => {
  if (!ensureStudiesPersistence(res)) return;

  // BEFORE THE LOAD, not just before the headers. Two separate properties,
  // both of them load-bearing:
  //
  //  - before the download headers are set, or a refusal that had already set
  //    Content-Disposition would still offer a file;
  //  - before the study is READ, or the 404 for a study that does not exist
  //    and the 403 for one that does tell a caller entitled to neither which
  //    it was.
  requireSuperadminForStudyResults(req);

  const stored = await getStudyById(req.params.studyId);
  if (!stored) {
    throw new NotFoundError('Survey');
  }

  // STREAMED, a participant at a time. Building the whole export first put up
  // to 200,001 rows in the heap, then an object graph from them, then the body
  // - a few hundred megabytes for one request on a single-replica 2Gi pod.
  //
  // Every refusal still happens BEFORE a byte is written. `openSurveyCsvExport`
  // does both preflight reads in an ordinary awaited call precisely so its 413
  // cannot arrive with the response already committed - a generator body would
  // not have run until the first pull, by which point the status is fixed. Same
  // reason the disposition is built here rather than inside the writer: a throw
  // after setHeader is served as text/csv and downloaded rather than shown.
  const disposition = toCsvContentDisposition(stored.study.title);
  const csvExport = await openSurveyCsvExport({
    kind: 'study',
    studyId: req.params.studyId
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', disposition);

  // The FACTORY, uncalled. `writeSurveyCsv` owns the export's wall-clock
  // deadline and calls this with the signal that carries it, so the bound
  // reaches the batch reads and not only the writes to the socket.
  return writeSurveyCsv(res, stored.steps, csvExport.removedQuestions, csvExport.participants, {
    studyId: req.params.studyId
  });
}));

// The HMAC callback receiver (POST /api/firsthand/callbacks) is gone: the merge
// deletes the cross-app hop. Internalised sessions write lifecycle events to
// opportunity_session_events in-process (see firsthand/completion-events.ts),
// so there is no second app to call back.

export default router;
