import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

import { pool } from '../config';
import {
  requireAdmin,
  requireAuth,
  optionalAuth,
  withLiveRoleIfPresent
} from '../middleware/authenticate';
import { getMockOpportunities, getMockOpportunity, addMockOpportunity, updateMockOpportunity, deleteMockOpportunity, addMockSessions, getMockSessions } from '../../../demo/mock-data';
import { logger } from '../utils/logger';
import { isDatabaseAvailable } from '../utils/database';
import { 
  CreateOpportunitySchema, 
  UpdateOpportunitySchema, 
  CreateSessionsSchema,
  MAX_TIME_SLOTS_PER_REQUEST,
  validateRequest,
  validateNewSessionData
} from '../validation/schemas';
import { AppError, ValidationError, NotFoundError, ForbiddenError, asyncHandler } from '../utils/errorHandler';
import { toPublicOpportunity, toPublicSession } from '../utils/publicOpportunity';
import { createSession } from '../firsthand/session-create';
import {
  findParticipantCompletionsForOpportunities,
  findParticipantSessionForOpportunity
} from '../firsthand/runtime-repository';
import { isAnsweredRuntimeStatus } from '../firsthand/state-model';
import {
  listResponsesForOpportunity,
  openSurveyCsvExport,
  studyHasResponses
} from '../firsthand/survey-results-repository';
import { writeSurveyCsv } from '../firsthand/survey-csv-response';
import { aggregateSurveyResults } from '../firsthand/survey-results';
import { toCsvContentDisposition } from '../firsthand/survey-csv';
import {
  canWriteStudy,
  claimStudyIfUnowned,
  countStudyTasks,
  createStudy,
  getStudyById,
  deleteStudyUnchecked,
  isStudiesPersistenceConfigured,
  updateStudy,
  type StudyRequester
} from '../firsthand/studies-repository';
import type { RecordedStudyBrief } from '../../../shared/types';
import type { StudyStep } from '../../../shared/firsthand/contract';
import { toStudySteps, type InlineStudy } from '../../../shared/firsthand/inline-study';
import { stepKeysAreComplete } from '../../../shared/firsthand/step-identity';
import {
  QUESTION_CARRYING_TYPES,
  runsNativeSurvey
} from '../../../shared/firsthand/delivery';
import {
  TOO_MANY_QUESTIONS_MESSAGE,
  countAskedQuestions,
  maxQuestionsFor,
  toSurveySteps,
  type InlineSurvey
} from '../../../shared/firsthand/survey-authoring';
import type { StudyKind } from '../../../shared/firsthand/study-input';
import {
  PUBLISH_PROBLEM_MESSAGES,
  findPublishProblem
} from '../../../shared/firsthand/publish-readiness';
import {
  resolveConsentTemplate,
  MODERATED_CONSENT_TYPES
} from '../../../shared/firsthand/consent-templates';
import { isPublishableExternalLink } from '../../../shared/firsthand/url-safety';
import type { DeliveryMode } from '../validation/schemas';
import { autoCloseOpportunityIfNeeded } from '../utils/opportunityLifecycle';
import { perUserLimiter } from '../middleware/per-user-rate-limit';
import {
  participantRuntimeWork,
  publicRuntimeWork
} from '../middleware/runtime-work-class';
import {
  boundResultsRead,
  releaseResultsReadPermit
} from '../middleware/results-read-concurrency';
import { ANALYTICS_TIME_ZONE, toAnalyticsDateString, weekOverWeekChange } from '../utils/analytics-dates';
import { resolveStudyDuration } from '../firsthand/study-duration';
import { isOpportunityOwner } from '../utils/opportunityOwnership';

import { Opportunity, CreateOpportunityRequest, UpdateOpportunityRequest, Session, CreateSessionRequest, isAdminRole } from '../types';

/**
 * The refusal a NON-ADMIN gets for an opportunity that exists but is not
 * published, keyed on why it is not viewable rather than flattened to a bare
 * 404. `GET /:id` used to answer 404 for missing, closed and draft alike, and
 * the participant page could only say "not found, maybe deleted, maybe no
 * permission" with a Retry that reloaded into the same 404.
 *
 *  - `closed` -> 410 Gone. The study WAS public (a participant may hold a real
 *    link to it), so telling them it has closed discloses nothing new and is
 *    the honest state. 410 is the exact HTTP semantics: the resource existed
 *    and is deliberately no longer available.
 *  - anything else (`draft`, and any not-yet-published state) -> 404 with a
 *    distinct code, so the participant sees "not open yet" rather than "not
 *    found". This does let a holder of the (UUID) id tell a draft apart from a
 *    genuinely-missing id, which is a deliberate, minimal disclosure: opportunity
 *    ids are unguessable and their existence is not a guarded secret here
 *    (cto/AdaptaLabs#10 settled that for the admin id-space; this is the weaker
 *    participant case). No title or details are echoed for either state - only
 *    the reason - so a draft's contents stay private.
 *
 * The frontend reads `code`, not the status, to choose the message and to drop
 * the dead Retry button on these two terminal states.
 */
function unavailableOpportunityError(status: string): AppError {
  if (status === 'closed') {
    return new AppError(
      'This study has closed and is no longer accepting participants.',
      410,
      'OPPORTUNITY_CLOSED'
    );
  }
  return new AppError(
    "This study isn't open yet. Check back once the researcher publishes it.",
    404,
    'OPPORTUNITY_NOT_OPEN'
  );
}

const router: Router = Router();

/**
 * The only columns `PATCH /api/opportunities/:id` may write.
 *
 * THIS IS THE SAME DEFECT `PATCH /api/sessions/:id` HAD, one route over. The
 * update builder below interpolates the request body's KEYS into the SET
 * clause - `updateFields.push(`${key} = $${paramCount}`)` - and parameterises
 * only the values. So a key is SQL.
 *
 * It never became exploitable here for exactly one reason: `validateRequest`
 * does `req.body = schema.parse(req.body)` and `UpdateOpportunitySchema` is a
 * bare `z.object`, which STRIPS unknown keys. That is a side effect of zod's
 * default mode, not a control anyone chose. A security gate measured what it
 * is worth: changing that one schema to `.passthrough()` passed 958 of 958
 * tests AND reopened the injection, driving the real handler and capturing
 *
 *   UPDATE opportunities
 *   SET title = (SELECT email FROM users ORDER BY created_at LIMIT 1), ...
 *
 * back out through the handler's own `RETURNING *`.
 *
 * Relying on a parser's default mode is the same shape of mistake as relying
 * on the `const data: UpdateSessionRequest = req.body` TYPE ANNOTATION that
 * hid the sessions hole - both read exactly like validation and neither
 * refuses anything.
 * `validation/__tests__/update-opportunity-schema-strips.test.ts` makes the word
 * `.passthrough()` fail by name; this set is what makes the failure survivable.
 *
 * Adding a column here widens what a request body can reach into the SET
 * clause. `owner_user_id`, `id` and `created_at` are all columns on this table
 * and none of them belongs to a caller.
 *
 * EXPORTED as a test seam, and only that. Nothing else imports it. It is
 * exported because a test that restates the policy cannot detect the policy
 * changing: an earlier draft of the pin below listed the fifteen names in the
 * test file itself and a mutation that widened this set passed all 22 of them.
 */
export const UPDATABLE_OPPORTUNITY_COLUMNS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'purpose_one_liner',
  'description_optional',
  'product_optional',
  'meeting_location_optional',
  'default_duration_minutes',
  'external_link_optional',
  'delivery_mode',
  'firsthand_study_id',
  'participant_type_required',
  'participant_type_specific_details',
  // Moderated consent (#79): live sessions and interviews only. Allow-listed
  // here - which both enforcement sites read - and additionally type-gated by
  // resolveModeratedConsentWrite, because membership in this Set says a column
  // MAY be written, not by whom or on what type.
  'consent_text',
  'consent_template_id',
  'consent_template_version',
  'status',
  'start_date',
  'end_date',
]);

/**
 * Keys `UpdateOpportunitySchema` declares that are NOT columns on
 * `opportunities`.
 *
 * The handler consumes all three and destructures them out of `data` before
 * the field loop (see the PATCH handler), so they must be permitted by the
 * allow-list without joining it - putting `expected_study_updated_at` in
 * `UPDATABLE_OPPORTUNITY_COLUMNS` would be declaring a column that does not
 * exist, and the loop only avoids emitting it because of that destructure.
 *
 * Two sets rather than one because they fail differently: a name in the first
 * set that is not a column answers 500 on every save that sends it, and a name
 * missing from either set answers 400 on a body the editor legitimately sends.
 */
export const NON_COLUMN_OPPORTUNITY_BODY_KEYS: ReadonlySet<string> = new Set([
  'inline_study',
  'inline_survey',
  'expected_study_updated_at',
]);

/**
 * Minting is idempotent per participant per opportunity as of 4d - an
 * unfinished session resumes and a finished one is refused - so the ceiling is
 * not what stops vote stuffing. It stops the cost: 60 sessions were minted in
 * under a second from one cookie when this was measured, and each mint writes
 * a row on the 5-connection FirstHand runtime pool that live participant
 * sessions share.
 *
 * 20 a minute is far above anything a person does. Starting a study is one
 * click, and the honest worst case is a participant retrying a flaky network a
 * few times across a few opportunities.
 */
const participantSessionMintLimiter = perUserLimiter(
  20,
  'Too many attempts to start a study. Wait a minute and try again.'
);

/**
 * The results reads are the researcher's own surface, so this is a backstop
 * against a runaway loop rather than against a person: the projection has no
 * LIMIT and returns every answer the opportunity collected, again on the
 * 5-connection runtime pool.
 *
 * 60 a minute leaves the real workflow untouched. The Responses tab refetches
 * on every visit deliberately - a stale tally is the one thing that view must
 * not show - so switching tabs repeatedly while reading is normal and must not
 * trip it.
 */
const surveyResultsLimiter = perUserLimiter(
  60,
  'Too many requests for these responses. Wait a minute and try again.'
);

/**
 * Writing an opportunity is not free. Each `inline_survey` write inserts a
 * study plus up to 51 step rows on the 5-connection FirstHand runtime pool that
 * live participant sessions share, and create, duplicate and delete all touch
 * the main pool as well.
 *
 * 30 a minute is far above authoring: a researcher fills a form and saves, and
 * even an autosave-shaped worst case is a few saves a minute.
 */
const opportunityWriteLimiter = perUserLimiter(
  30,
  'Too many changes in a short time. Wait a minute and try again.'
);

/**
 * Clears both limiters for one caller. A test seam, and only that.
 *
 * The counters live in an in-process MemoryStore that outlives an individual
 * test, so a suite exercising these routes hundreds of times as one user
 * exhausts them and every later assertion fails as a 429 - which reads as a
 * route bug rather than as the limiter doing its job. Resetting per test is
 * the honest fix; lifting the ceilings or skipping the limiter under
 * NODE_ENV=test would leave the control untested in the only place it can be
 * tested at all.
 *
 * Worth knowing rather than fixing: that store is per PROCESS, so with more
 * than one backend pod the effective ceiling is the limit times the pod count,
 * and a caller can be balanced onto a fresh bucket. These are backstops
 * against runaway loops, not quotas, so that is acceptable - but it is not
 * what the numbers literally say.
 */
export function resetParticipantRouteLimits(userId: string): void {
  participantSessionMintLimiter.resetKey(userId);
  surveyResultsLimiter.resetKey(userId);
  opportunityWriteLimiter.resetKey(userId);
}

/**
 * Re-exported from `shared/firsthand/publish-readiness`, which is where both
 * publish-refusal messages now live and what the Review step reads.
 *
 * This one is kept because `__tests__/opportunities.test.ts` imports it by
 * name, and that import is the assertion that stops this wording drifting away
 * from the client's preview of it. Its unmoderated twin was NOT kept: nothing
 * imported it, and once the guards below stopped naming it directly a local
 * alias for a value used nowhere is just a second name to keep in step.
 */
export const NATIVE_SURVEY_STUDY_REQUIRED =
  PUBLISH_PROBLEM_MESSAGES.native_survey_study_required;

/**
 * Which study vocabulary an opportunity of this shape can run.
 *
 * An `unmoderated` opportunity runs the recorded runner, which draws no widget
 * for a rating or a multi-choice and stores nothing for them. A native poll,
 * survey or one-question opportunity runs SurveyRunner, which has no recording,
 * no task window and nothing to do with a step carrying a page to open. Linking
 * the wrong one produces a participant-facing screen that looks authored and
 * collects nothing.
 *
 * Checked at the API boundary rather than only in the picker, because the
 * picker is not the boundary: create and update both accept
 * `firsthand_study_id` from the body, so a hand-crafted call bypasses any
 * amount of UI filtering.
 */
const requiredStudyKindFor = (
  type: string,
  deliveryMode: string
): StudyKind | null => {
  if (type === 'unmoderated') return 'recorded';
  if (runsNativeSurvey(type, deliveryMode)) {
    return 'survey';
  }
  // Every other shape links no study at all.
  return null;
};

/**
 * Exported so a test can assert on the exact message rather than on a word.
 * Both refusals originally named BOTH vocabularies, so a matcher for "survey"
 * or "task list" matched either one - swapping the two record values left every
 * refusal stating the opposite of what happened and all seven tests still
 * green. Keyed by the kind that was REQUIRED, which is what the reader needs.
 */
export const STUDY_KIND_MISMATCH: Record<StudyKind, string> = {
  recorded:
    'This study needs a recorded task list, and that is a set of survey questions',
  survey:
    'This study needs a set of survey questions, and that is a recorded task list'
};

/**
 * The two refusals that guard `inline_survey`, named once because create and
 * PATCH both make them.
 *
 * They were two literal sentences written out twice, and #78 had to widen the
 * type half of both - which is the moment a pair of copies becomes a pair that
 * disagrees. Both name the shapes rather than restating a hardcoded list, so
 * adding a fourth question-carrying type does not leave a sentence naming
 * three.
 */
export const ONLY_QUESTION_TYPES_CARRY_QUESTIONS =
  'Only polls, surveys and one-question studies can carry questions';
export const QUESTIONS_NEED_NATIVE_DELIVERY =
  'Questions are only used when the study runs in Cortex; set delivery_mode to native';

/**
 * Moderated consent (#79) is for the two moderated types and nothing else.
 * The set itself lives in shared/firsthand/consent-templates (the booking path
 * needs the same rule); re-exported here so this module's callers and tests
 * keep importing it from where it has always been.
 */
export { MODERATED_CONSENT_TYPES };
export const CONSENT_FIELDS_WRONG_TYPE =
  'Consent fields apply only to live sessions and interviews';
export const CONSENT_CLAIM_WITHOUT_TEXT =
  'A consent template claim travels with consent_text, never alone';

/**
 * What the consent columns should be written as, or null when the request
 * carries none of them.
 *
 * The template pair in the body is a CLAIM about which approved wording
 * `consent_text` is, resolved server-side exactly as the studies path resolves
 * its own (see resolveConsentTemplate): a caller can understate its approval
 * and can never overstate it. The stored pair comes from resolution, never from
 * the request.
 *
 * Clearing (`consent_text: null`, PATCH only) nulls the pair with the text -
 * the shape constraint `opportunities_consent_template_shape` would refuse a
 * row claiming a template for wording it no longer holds, and refusing it here
 * gives the caller a sentence instead of a constraint violation.
 */
export function resolveModeratedConsentWrite(
  body: {
    consent_text?: string | null;
    consent_template_id?: string | null;
    consent_template_version?: number | null;
  },
  effectiveType: string
): { consent_text: string | null; consent_template_id: string | null; consent_template_version: number | null } | null {
  const textPresent = body.consent_text !== undefined;
  const claimPresent =
    body.consent_template_id !== undefined || body.consent_template_version !== undefined;

  if (!textPresent && !claimPresent) {
    return null;
  }

  if (!MODERATED_CONSENT_TYPES.has(effectiveType)) {
    // The sentence IS the message: errorHandler serialises `error.message` and
    // drops the details array, so a sentence placed there never reaches the
    // wire - the allow-list docblock above records the same fact.
    throw new ValidationError(CONSENT_FIELDS_WRONG_TYPE);
  }

  if (!textPresent || body.consent_text == null) {
    // A claim travelling without text is refused whatever its values - explicit
    // nulls included. A lone `consent_template_id: null` used to fall through
    // this branch as "nothing to write" while the raw nulls stayed in the body
    // and reached the column loop directly: half the pair nulled, the shape
    // constraint violated mid-request, and the resolver's whole promise (a
    // sentence instead of a constraint violation) broken. The only legal
    // null-shape is the clear: `consent_text: null`, with the pair either
    // absent or also null.
    if (
      claimPresent &&
      (!textPresent ||
        body.consent_template_id != null ||
        body.consent_template_version != null)
    ) {
      throw new ValidationError(CONSENT_CLAIM_WITHOUT_TEXT);
    }
    return textPresent
      ? { consent_text: null, consent_template_id: null, consent_template_version: null }
      : null;
  }

  const consentText = body.consent_text;
  const resolved = resolveConsentTemplate({
    kind: 'moderated',
    consentText,
    claimedTemplateId: body.consent_template_id,
    claimedTemplateVersion: body.consent_template_version
  });

  return {
    consent_text: consentText.trim(),
    consent_template_id: resolved.id,
    consent_template_version: resolved.version
  };
}

/**
 * Wording for the link-time ownership refusal below, keyed by the kind that
 * was required - matching STUDY_KIND_MISMATCH's convention. B3 replaced
 * reuse-by-link with copy-on-select in the UI, but `firsthand_study_id` is
 * still a writable field on both request schemas, so without this a
 * hand-crafted PATCH could still create the shared-link state B3 exists to
 * remove: link a colleague's study, no UI involved. Points at the remedy that
 * is actually still available - a copy - rather than just saying no.
 */
export const STUDY_OWNERSHIP_REFUSAL: Record<StudyKind, string> = {
  recorded: 'This task list belongs to another researcher; take a copy of it instead',
  survey: 'These questions belong to another researcher; take a copy of them instead'
};

/**
 * Refuses a linked study whose vocabulary does not match the opportunity, or
 * whose owner refuses this caller a write - when `checkOwnership` says the
 * caller is asking for a NEW link rather than resending one already stored.
 *
 * Silent only when persistence is unconfigured - a deployment without the
 * runtime database, which is not this check's business. A study id that
 * resolves to NOTHING is refused, for the reason stated at the check itself:
 * skipping it made the whole rule optional. (This docblock said the opposite
 * until the missing-study case was tightened; corrected here rather than left
 * to mislead the next reader.)
 *
 * The ownership half is gated by the caller rather than unconditional, because
 * this function also runs on a save that changes nothing about the link: the
 * opportunity form legitimately resends the SAME `firsthand_study_id` on
 * every save while its author edits a title, even when the linked study
 * belongs to someone else. Refusing that would break the one save path B3's
 * design depends on - see each call site for how "new" is decided there.
 */
async function assertLinkedStudyKindMatches(
  studyId: string,
  type: string,
  deliveryMode: string,
  requester: StudyRequester,
  checkOwnership: boolean
): Promise<void> {
  const required = requiredStudyKindFor(type, deliveryMode);

  if (!required || !isStudiesPersistenceConfigured()) {
    return;
  }

  const stored = await getStudyById(studyId);

  // An id resolving to nothing is refused, not skipped. Skipping made the whole
  // check optional: link an id that does not exist yet, then create a study at
  // that exact id with whichever vocabulary you like - POST /api/firsthand/
  // studies takes a client-supplied id. Two calls, demonstrated end to end.
  // There is no legitimate case for linking a study that is not there: it fails
  // at participant start time instead, which is a worse place to find out.
  if (!stored) {
    throw new ValidationError('That task list could not be found');
  }

  if (stored.study.kind !== required) {
    throw new ValidationError(STUDY_KIND_MISMATCH[required]);
  }

  if (checkOwnership && !canWriteStudy(stored.study.owner_user_id, requester)) {
    throw new ForbiddenError(STUDY_OWNERSHIP_REFUSAL[required]);
  }

  // The one-question cap on the LINKING path, not only on the authoring one.
  //
  // Capping the authored payload alone would make the promise decorative: the
  // same body accepts `firsthand_study_id`, so a set of twelve questions
  // authored as a survey could be pointed at a `question` opportunity in one
  // call, and the participant would meet twelve questions under a badge reading
  // "One question". The kind check above exists for exactly this class of
  // mismatch; this is the same check on the other axis.
  //
  // BELOW the ownership check, unlike that kind check, and the asymmetry is
  // deliberate. How many questions a study holds is a fact about its CONTENT,
  // so answering it to a caller who may not write the study would disclose
  // something the ownership refusal is there to withhold. `kind` is disclosed
  // above because a caller who picked the study from the unfiltered list
  // already knows which vocabulary it speaks.
  //
  // It still runs when `checkOwnership` is false - the form resending an id it
  // is not changing - because that path can still be the one establishing the
  // over-long state.
  if (countAskedQuestions(stored.steps) > maxQuestionsFor(type)) {
    throw new ValidationError(TOO_MANY_QUESTIONS_MESSAGE);
  }
}

/**
 * Rewrite the content of the study an opportunity is ALREADY linked to.
 *
 * Without this there is no in-place update path anywhere on the opportunity
 * route: `inline_study`/`inline_survey` only ever CREATE. That was fine while
 * authored content was write-once, and it is what made a PATCH carrying
 * authored content against an already-linked opportunity a flat refusal -
 * "edit its tasks in the Task Lists area". So a researcher could write a task
 * list on the opportunity form exactly once, and every correction after that
 * had to be made somewhere else.
 *
 * The refusal was not paranoia, and this does not simply remove it. An
 * opportunity may be linked to a study it does not own - reusing a colleague's
 * study is a designed feature, and `GET /api/firsthand/studies` is deliberately
 * unfiltered by owner - so an unconditional in-place write would let one
 * researcher rewrite another's asset, including its consent copy and its task
 * target_url, through a route whose ownership check only ever covered the
 * OPPORTUNITY. That is the same attack migration 0007 and `claimStudyIfUnowned`
 * were added to close, reached through a different door.
 *
 * The BINDING authorisation decision is taken by `updateStudy`, inside its own
 * transaction and behind its `FOR UPDATE` row lock, because a check made here
 * ahead of it could race. This function also takes the same decision early -
 * ahead of `stepSequenceIsUnchanged` and `studyHasResponses` - purely to keep
 * those two probes from running, and so from disclosing whether a study this
 * caller cannot write has collected responses, before write access is even
 * established. See that early check's own comment for the disclosure it
 * closes. The three outcomes below are all meaningful:
 *
 * - `updated`  - the caller may write it and it now holds the authored content
 * - `forbidden`- the study belongs to someone else; the caller is refused and
 *                NOTHING is written, in particular no replacement study that
 *                would quietly repoint the opportunity away from a colleague's
 * - `missing`  - the link is dangling. Nothing exists to protect or to orphan,
 *                so the caller falls back to minting, which repairs the link
 *
 * An UNOWNED study is writable here, and `updateStudy`'s adopt-on-write claims
 * it for the editor. That is deliberate and matches what linking already does
 * one branch below (`claimStudyIfUnowned`): a legacy row with no owner is
 * claimed by the first admin to make a real edit to it, so the fail-open in
 * `canWriteStudy` can only ever shrink. Refusing here instead would leave a
 * legacy study editable through StudyEditor but not through the form that
 * authored it, which is a rule nobody could discover.
 *
 * Deliberately does NOT touch `title`, `intro_text` or `status`. Create copies
 * the first two from the opportunity, but they are not authored on the
 * opportunity form and the form never displays them, so rewriting them on
 * every save would silently discard a title a researcher had set by hand in
 * StudyEditor. The existing title drift after an opportunity rename is a known
 * deferral and stays exactly as it is rather than being half-fixed here.
 */
type InPlaceStudyUpdate = 'updated' | 'forbidden' | 'missing' | 'stale';

/**
 * The optimistic-concurrency refusal, carrying what the caller needs to recover.
 *
 * `stale` is returned as an outcome rather than thrown from inside the helper so
 * that both call sites below are forced to handle it - and in particular so that
 * neither can fall through to the "mint a replacement study" branch, which is
 * what `missing` does. Minting on a conflict would repoint the opportunity at a
 * fresh study and abandon the one the colleague just saved: precisely the data
 * loss this whole step exists to prevent, reached from the other direction.
 */
/**
 * The 409 both in-place branches answer, as a thrown `ConflictError` rather than
 * a direct `res.status(409)`, matching how the sibling `forbidden` case throws
 * `ForbiddenError` - this route's refusals all go through `errorHandler` and its
 * `{ error, code, timestamp, requestId }` envelope.
 *
 * The message names WHEN nothing more. The row records who wrote it (migration
 * 0014) and the log line below puts that within reach of an operator; putting a
 * colleague's identity in the response body is a different act, and the reasons
 * are set out at the twin 409 in routes/firsthand.ts.
 *
 * `subject` is the whole noun phrase the caller already sees for this thing -
 * "this task list", "these questions" - because a sentence that says "study" to
 * somebody looking at a screen that never uses the word is not a legible
 * refusal, and because the two differ in number as well as in wording.
 */
function logStaleStudyWrite(studyId: string, userId: string) {
  logger.info('Refused a stale study write', {
    studyId,
    userId,
    via: 'opportunity-form'
  });
}

function sendStaleStudyConflict(
  res: Response,
  studyId: string,
  userId: string,
  subject: string,
  currentUpdatedAt: string
) {
  logStaleStudyWrite(studyId, userId);

  // Answered DIRECTLY, in the same body shape as the twin 409 in
  // routes/firsthand.ts, rather than thrown as a ConflictError. Two reasons,
  // and the first one is a real defect rather than tidiness.
  //
  // `ConflictError` stamps `code: 'CONFLICT'` on every 409 this route can
  // produce - including the two `mapDatabaseError` raises, for a unique
  // constraint violation and for lock-not-available, both plausible transients
  // on a busy opportunity row. A client with no better discriminator than the
  // status would show "somebody else saved this, save again to replace their
  // version" for a lock timeout, which is false; and it would then advance its
  // precondition to whatever is stored, so the NEXT click would overwrite a
  // colleague who had genuinely saved in the meantime, with no conflict raised
  // at all. That is this step's own failure mode, reached through its own
  // recovery path.
  //
  // And the envelope `errorHandler` builds for an AppError has no slot for
  // `current_updated_at`. Without it the client can only re-read the study to
  // learn what to save against - a second request that can itself fail, leaving
  // an author refused in a loop with no control anywhere that would let them
  // keep their work. The study route already returns it; this returns the same
  // thing, so one logical refusal has one shape.
  return res.status(409).json({
    error: 'stale_study',
    message: `Somebody else saved changes to ${subject} after you opened this study. Nothing has been saved, and your edits are still here - save again to replace their version, or open the study in a new tab to compare first.`,
    current_updated_at: currentUpdatedAt
  });
}

type InPlaceStudyOutcome =
  | { outcome: Exclude<InPlaceStudyUpdate, 'stale' | 'updated'> }
  /**
   * The revision the write LANDED ON, carried out of here rather than left for
   * the caller to fetch again.
   *
   * A successful save moves `updated_at`, so the precondition the client is
   * holding goes stale the instant its own save commits. A form that saves
   * once and then reloads never notices - `loadOpportunity` refreshes the
   * value on the way back in. An autosave cannot reload: rebuilding the form
   * from the server would discard whatever the author typed while the request
   * was in flight, which is the one thing autosave exists to prevent.
   *
   * So without this the SECOND autosave is refused as stale against the FIRST
   * one's own write, and so is every save after it, forever - a conflict
   * banner accusing a colleague who does not exist. Returning the value costs
   * nothing: `updateStudy` already read it under the row lock it took to do
   * the write.
   */
  | { outcome: 'updated'; updatedAt: string }
  | { outcome: 'stale'; currentUpdatedAt: string };

/**
 * Whether the steps about to be written are the same sequence already stored.
 *
 * ONLY consulted for a request that could not express identity of its own - see
 * `identityIsAuthored` on `updateLinkedStudyContent`. It is what it is BECAUSE
 * such a request still gets positional ids: `step_id` falls back to
 * `${studyId}_step_${index + 1}` when a step carries no `step_key`
 * (shared/firsthand/inline-study.ts, shared/firsthand/survey-authoring.ts), so
 * an id survives a rewrite while the question it names does not.
 *
 * Two of the three things that made that dangerous are gone as of F2:
 * `updateStudy` now diffs rather than deleting and re-inserting every step, and
 * `participant_responses.step_id` has a real foreign key (migration 0015). What
 * remains is that a key-less payload's ids mean nothing, and this is what
 * refuses to act on them.
 *
 * Type and config are compared as well as the prompt, because the results
 * projection interprets each stored answer using the CURRENT step's type: a
 * free-text answer landing on a step that is now a rating goes through the
 * scale tally and contributes to a mean.
 *
 * Identical sequence means no id changes meaning, so the rewrite is safe even
 * with answers stored. Anything else - a reorder, an insert, a delete, a type
 * change - moves at least one question onto an id another question's answers
 * were written against.
 */
function stepSequenceIsUnchanged(stored: StudyStep[], incoming: StudyStep[]) {
  // Normalised on BOTH sides, because the payload normalises and the stored
  // row does not. The form trims every prompt and drops blank option rows, so
  // comparing a trimmed incoming value against an untrimmed stored one made a
  // study whose prompts happened to carry trailing whitespace read as
  // "sequence changed" on a save that changed nothing - and once it had
  // answers, every save was then refused, naming an edit the author had not
  // made. The comparison has to ask the same question at both ends.
  const shape = (step: StudyStep) =>
    JSON.stringify([
      step.step_id,
      step.type,
      step.prompt?.trim() ?? null,
      (step.options ?? []).map((option) => option.trim()).filter(Boolean),
      step.config ?? null
    ]);

  // The `end` marker is excluded from the comparison entirely.
  //
  // It is a completion marker, never authored, and `isAnswerable` excludes it -
  // so no answer can ever be attached to it and no re-attribution involving it
  // is possible. Comparing it can therefore only produce FALSE refusals, and it
  // did: `toStudySteps` appends the canonical END_STEP_PROMPT, so any study
  // whose stored marker says something else - one created through the studies
  // API with its own wording - read as a changed sequence on every save. Once
  // that study had answers, it could not be edited, retitled or unpublished
  // from the opportunity form at all, and the refusal named questions the
  // author had not touched.
  const authored = (steps: StudyStep[]) => steps.filter((step) => step.type !== 'end');
  const storedAuthored = authored(stored);
  const incomingAuthored = authored(incoming);

  return (
    storedAuthored.length === incomingAuthored.length &&
    storedAuthored.every((step, index) => shape(step) === shape(incomingAuthored[index]))
  );
}

async function updateLinkedStudyContent(
  studyId: string,
  requiredKind: StudyKind,
  content: {
    consent_text: string;
    /**
     * The classification the form believed the wording carried when it loaded
     * it. Passed straight through to `updateStudy`, which verifies it against
     * the text rather than trusting it. Carried at all so that a study written
     * against version 1 of a template stays attributed to version 1 after a
     * version 2 ships, instead of silently reclassifying as custom.
     */
    consent_template_id?: string | null;
    consent_template_version?: number | null;
    estimated_duration_minutes?: number | null;
    steps: StudyStep[];
  },
  requester: StudyRequester,
  /**
   * The `updated_at` the opportunity form was served for this study when it
   * loaded. See `updateStudy` for why absence means "no claim" rather than
   * "overwrite whatever is there".
   */
  expectedUpdatedAt: string | undefined,
  /**
   * Whether the ids in `content.steps` came from identity the AUTHOR minted,
   * rather than from array position.
   *
   * True when every authored item in the request carried a `step_key`
   * (`stepKeysAreComplete`), which is what the current form always sends. It
   * turns off both mitigations below, and it has to be decided by the caller
   * because only the caller can see the request before `toStudySteps` /
   * `toSurveySteps` has flattened it into ids that no longer say where they
   * came from.
   */
  identityIsAuthored: boolean
): Promise<InPlaceStudyOutcome> {
  const stored = await getStudyById(studyId);

  if (!stored) {
    return { outcome: 'missing' };
  }

  // Checked before the write, not left to updateStudy's own vocabulary guard:
  // that one throws a raw Error naming a step id, which this route answers as
  // a 500. The caller deserves the same sentence the picker path gives.
  //
  // Read outside the row lock, unlike the ownership decision below. `kind` is
  // fixed at create - it has no counterpart on UpdateStudyInput - so the only
  // way this can go stale is deleting the study and recreating one at the same
  // id, which already requires the right to delete it. The outcome of losing
  // that race is a refusal, never a wrong write.
  if (stored.study.kind !== requiredKind) {
    throw new ValidationError(STUDY_KIND_MISMATCH[requiredKind]);
  }

  // Read here, ahead of the two probes below, rather than left solely to
  // updateStudy's own FOR UPDATE check further down. That check is still the
  // authoritative one - the owner can change between this read and the write
  // - but reaching it used to require first computing stepSequenceIsUnchanged
  // and, when that was false, awaiting studyHasResponses: a 400 naming
  // "already collected answers" versus updateStudy's 403 disclosed whether a
  // study this caller cannot write had collected any responses, to a caller
  // who was never granted read access to that fact. Checked advisedly here so
  // neither probe below runs at all for a study this caller cannot write; the
  // narrow race where ownership changes in the gap fails closed rather than
  // disclosing anything.
  if (!canWriteStudy(stored.study.owner_user_id, requester)) {
    return { outcome: 'forbidden' };
  }

  // Keep the identity the stored steps already have - ONLY for a request that
  // could not express identity of its own.
  //
  // F2 made that the exception rather than the rule. When `identityIsAuthored`
  // is true, every incoming id was derived from a key the author's client
  // minted when the question was created and has carried unchanged ever since,
  // so the payload's ids ARE the identity and rewriting them positionally is
  // the very corruption this block was written to avoid. A reorder then moves
  // `step_order` and nothing else, and answers stay with their questions.
  //
  // What follows describes the remaining case: a script, or an SPA bundle older
  // than the backend serving it, neither of which sends keys.
  //
  // The incoming ids are derived from array position by toStudySteps and
  // toSurveySteps, in an UNPADDED form (`_step_1`). A study built by hand in
  // the Task Lists area numbers its own steps zero-padded (`_step_001`,
  // StudyEditor.stepIdFor). Taking the payload's ids therefore rewrote the id
  // of every step of every hand-built study, which did two bad things at once:
  //
  //  - `stepSequenceIsUnchanged` compares `step_id`, so a save that changed
  //    NOTHING about the questions read as a changed sequence. On a study with
  //    answers that meant the refusal below fired on, say, a title edit, and
  //    named a change the author had not made. The opportunity could then not
  //    be edited, unpublished or repaired from the form at all
  //  - with no answers yet, the renumber went through silently. Any answer
  //    collected afterwards against `_step_001` would then reference a row
  //    that no longer exists - orphaning, where the guard exists to prevent
  //    mis-attribution
  //
  // Positional and only when the counts match: a different length means the
  // author added or removed a step, so position no longer identifies the same
  // question and the guard below is the right thing to answer. F2 replaces
  // positional identity outright; this keeps the route from destroying the
  // identity that already exists in the meantime.
  const incomingSteps =
    !identityIsAuthored && content.steps.length === stored.steps.length
      ? content.steps.map((step, index) => ({
          ...step,
          step_id: stored.steps[index].step_id
        }))
      : content.steps;

  // The refusal that stops this route corrupting research data.
  //
  // Because ids are positional, rewriting the steps of a study that has
  // already collected answers silently re-attributes them: question 3's
  // answers are reported under question 1's prompt, interpreted with question
  // 1's type. Nothing surfaces it - the ids regenerate identically, so there
  // is no dangling reference to detect - and the delete is irreversible.
  //
  // This route is where that becomes reachable. `PUT /api/firsthand/studies/
  // :studyId` does not have the problem: StudyEditor sends the stored
  // `step_id` for every step and says so at its own delete-and-re-add warning,
  // so an edit there preserves identity. Sending the author to the Task Lists
  // area is therefore a real remedy and not a brush-off.
  //
  // Only reached when the sequence actually changed, which also keeps the
  // common save - consent or duration edited, questions untouched - down to
  // the reads it already does.
  //
  // The proper fix is stable persisted ids, and F2 is it - which is why this
  // refusal is now conditional. A request whose identity the author minted
  // cannot MOVE an answer: an id that does not appear in the payload is a
  // question the author DELETED, and 0015's foreign key detaches its answers
  // rather than moving them onto somebody else's question.
  //
  // It stays for the key-less case, unchanged and still fail-closed:
  // studyHasResponses answers true when it cannot check. A client that cannot
  // say which question is which must not be allowed to rewrite the questions of
  // a study that has answers, and the Task Lists area remains a real remedy
  // because StudyEditor sends stored ids explicitly.
  if (
    !identityIsAuthored &&
    !stepSequenceIsUnchanged(stored.steps, incomingSteps) &&
    (await studyHasResponses(studyId))
  ) {
    throw new ValidationError(
      'This study has already collected answers, so its questions cannot be changed here - editing them would re-attribute those answers to the wrong questions. Edit it in the Task Lists area, which preserves each question\'s identity'
    );
  }

  // And the half stable identity does NOT solve, found by both review gates
  // independently and very nearly shipped.
  //
  // The refusal above was never only about ordering. `stepSequenceIsUnchanged`
  // compared type and config as well, and turning it off wholesale left a
  // question free to CHANGE ITS MEANING while keeping the id its answers are
  // attached to. Every result path interprets a stored answer with the step's
  // CURRENT type: 300 ratings of 1 to 5 on a question retyped to `nps` are all
  // `<= 6`, so the study reports an NPS of -100 over 300 respondents, and a
  // `scale_max` lowered from 10 to 5 silently drops every answer above 5 out of
  // the mean. Reordering is safe now; re-meaning never was.
  //
  // Matched BY ID rather than by position - that is the whole point of the ids
  // now being stable - and only for steps that already exist, so adding and
  // deleting questions stay allowed.
  //
  // `prompt` is deliberately NOT in this comparison. Fixing a typo on a live
  // survey is one of the things F2 exists to make possible, and the answer is
  // still an answer to the same question. What makes that safe rather than
  // silent is that the wording each participant actually saw is recorded beside
  // their answer and reported back - see `asked_as` in survey-results.ts. And
  // `options` is not here either: an answer naming an option the question no
  // longer offers is already surfaced as `retired_options` rather than
  // disappearing into a denominator.
  const storedById = new Map(stored.steps.map((step) => [step.step_id, step]));
  const reMeaned = incomingSteps.find((step) => {
    // The completion marker is excluded for the same reason
    // stepSequenceIsUnchanged excludes it: nothing can answer it, so no
    // comparison involving it can produce anything but a false refusal.
    if (step.type === 'end') {
      return false;
    }

    const priorStep = storedById.get(step.step_id);

    return (
      priorStep !== undefined &&
      (priorStep.type !== step.type ||
        JSON.stringify(priorStep.config ?? null) !== JSON.stringify(step.config ?? null))
    );
  });

  if (identityIsAuthored && reMeaned && (await studyHasResponses(studyId))) {
    throw new ValidationError(
      'This question has already been answered, so its type and scale cannot be changed - the answers people gave would be read as if they had answered the new question. Reword it, or add a new question and remove this one, which keeps the answers already given under the question that was actually asked'
    );
  }

  const result = await updateStudy(
    studyId,
    { ...content, steps: incomingSteps },
    requester,
    expectedUpdatedAt
  );

  if (!result.ok) {
    if (result.reason === 'stale') {
      return { outcome: 'stale', currentUpdatedAt: result.current_updated_at };
    }

    // A study deleted between the read above and the row lock inside
    // updateStudy. Same answer as never having existed.
    return { outcome: result.reason === 'not_found' ? 'missing' : 'forbidden' };
  }

  if (expectedUpdatedAt === undefined) {
    // Fail-open is deliberate (see updateStudy's docstring) but must not be
    // silent: a bundle that stopped sending the precondition would otherwise
    // lose the protection with nothing anywhere to say so.
    //
    // Logged AFTER the write, past every branch that returns without one -
    // `not_found`, `forbidden`, and the raw throw from the vocabulary guard.
    // A line reading "study updated with no precondition" for a request that
    // updated nothing is noise in exactly the place an operator is looking for
    // signal. Same placement as the twin in routes/firsthand.ts.
    logger.warn('Study updated with no concurrency precondition', {
      studyId,
      userId: requester.userId,
      via: 'opportunity-form'
    });
  }

  if (result.claimed) {
    // An ownership transfer with no UI and no undo below superadmin, exactly
    // as PUT /api/firsthand/studies/:studyId logs it. If an author reports
    // losing access to a study, this line is the only record of when it
    // changed hands and to whom.
    logger.info('Unowned study claimed by the opportunity form editing it', {
      studyId,
      newOwnerUserId: requester.userId
    });
  }

  return { outcome: 'updated', updatedAt: result.study.updated_at };
}

/**
 * Body of POST /api/opportunities.
 *
 * `inline_study` is validated by CreateOpportunitySchema but is not part of the
 * shared CreateOpportunityRequest interface: shared/types/index.ts is flattened
 * into a single file when it is copied to the frontend, so a cross-tree import
 * there would not resolve in the copy.
 */
type CreateOpportunityBody = CreateOpportunityRequest & {
  inline_study?: InlineStudy;
  inline_survey?: InlineSurvey;
  // Accepted by the validation schema but not on the shared request interfaces
  // yet, for the same flattening reason as inline_study above: the authoring
  // toggle that sets it lands with the form, and declaring a writable field
  // before anything can write it invites a client to send one nothing reads.
  delivery_mode?: DeliveryMode;
};

type UpdateOpportunityBody = UpdateOpportunityRequest & {
  inline_study?: InlineStudy;
  inline_survey?: InlineSurvey;
  delivery_mode?: DeliveryMode;
  /**
   * The optimistic-concurrency precondition for the LINKED STUDY, not for the
   * opportunity. Declared top-level rather than inside `inline_study` /
   * `inline_survey` on purpose: both branches feed the same in-place update, a
   * concurrency token is not authored content, and the two inline schemas
   * disagree about unknown keys - `inlineSurveySchema` is `.strict()` and
   * refuses them, `inlineStudySchema` is not and drops them in silence. One
   * declared field has one failure mode instead of two.
   */
  expected_study_updated_at?: string;
};

// `validateUrl` used to live here. Its body moved to
// `shared/firsthand/publish-readiness` as `isPublishableExternalLink`, so the
// Review step's publish preview answers "is this link publishable" with the
// same function this route does. A local alias was left behind at first, on the
// assumption that several call sites read better for the shorter name - lint
// then showed there were none: the two publish guards were its only readers,
// and both now ask the shared predicate directly.

/**
 * THE MOST OPPORTUNITIES ONE LISTING WILL RETURN, and it REFUSES above it.
 *
 * cto/AdaptaLabs#22. This route had no `LIMIT` clause of any kind. Not an
 * unclamped caller-supplied number - there is no caller-supplied number here at
 * all, which is exactly why the `LIMIT`-shaped sweep that closed !225 could not
 * see it. The bound was MISSING rather than loose, and it grew with the table:
 * `SELECT o.* ... ORDER BY o.created_at DESC` behind `optionalAuth`, then a
 * fan-out that serialises every session of every row returned.
 *
 * REFUSES RATHER THAN TRUNCATES, and 413 rather than a short array, on the same
 * line `MAX_CSV_PARTICIPANTS` and `pointsHistoryLimit` are drawn on. This route
 * has NO offset, NO cursor and NO `has_more` - it answers with a bare JSON
 * array - so a clamped response is indistinguishable from the end of the
 * catalogue. A participant would simply never see the study that fell off the
 * end, and nothing anywhere would say so.
 *
 * WHY THE LEADERBOARD'S CLAMP DOES NOT FIT. `leaderboardLimit` clamps because
 * the caller explicitly asked for more rows than the route publishes, so the
 * ceiling IS the answer to their question. Nobody asks this route for a number:
 * the question is "every published opportunity", and the honest answers are all
 * of them or none of them.
 *
 * THE ONE THING A 413 COSTS is that there is no smaller request to retry with -
 * unlike `/points-history`, the caller has no recourse but to wait for
 * pagination. That is the argument FOR it, not against: a board that has
 * outgrown this route fails loudly and gets a cursor, where a silently short
 * board is never noticed at all.
 *
 * 1000, and it is a policy number rather than a measurement. An opportunity is
 * hand-authored by an admin, so a real catalogue is dozens; a deployment at
 * four figures is already serialising megabytes of JSON with every session
 * attached, and the answer there is pagination rather than a larger constant.
 * Admins see every status including drafts and closed, so the admin view is the
 * one that grows.
 *
 * Written as a NUMBER HERE and asserted as the same number in the test rather
 * than derived from this constant. A test that reads `MAX_OPPORTUNITIES_RETURNED`
 * to build its expectation cannot see `MAX_OPPORTUNITIES_RETURNED` change.
 *
 * ponytail: a flat ceiling, not pagination
 *   -> cto/AdaptaLabs#22, upgrade to a keyset cursor on (created_at, id) when a
 *      deployment genuinely holds more than 1000 opportunities
 */
export const MAX_OPPORTUNITIES_RETURNED = 1000;

/**
 * THE OTHER HALF OF THE SAME BOUND, and the listing had only one of them.
 *
 * cto/AdaptaLabs#41, found by the refute gate on !253. The ceiling above bounds
 * the number of OPPORTUNITIES. The listing then fans out over the ids it
 * returned with `WHERE s.opportunity_id = ANY($1::uuid[])` and NO `LIMIT`, so
 * the worst case was 1000 opportunities multiplied by however many sessions each
 * one holds, materialised into a single result set in one round trip. A bound on
 * the row count of the outer query cannot see an unbounded read hanging off it -
 * which is #22's own lesson, one level in.
 *
 * The clicks fan-out beside it never had the shape: it is a `GROUP BY` over the
 * same id list, so it returns at most one row per opportunity.
 *
 * REFUSES RATHER THAN TRUNCATING, which is the disposition this route already
 * chose and the reason it is the cheap answer here. A `LIMIT` on the fan-out
 * would silently drop sessions from SOME opportunities and hand back the rest as
 * if they were complete - a lie with no marker on it at all, and worse than the
 * outer truncation #22 refused, because the caller cannot even see which
 * opportunity was shortened. The alternatives were considered and are heavier:
 * bounding sessions per opportunity at WRITE time needs a migration and a
 * decision about existing rows, and dropping the embedded sessions altogether is
 * a wire-contract change that `frontend/src/pages/Admin.tsx:771` consumes today
 * (it sums `capacity` and `booked_count` across `opportunity.sessions`).
 *
 * WHO IT TAKES DOWN WHEN IT FIRES, said plainly because the refusal is the
 * decision and its cost belongs beside it. This is not an admin-only route:
 * `frontend/src/pages/Home.tsx:42` calls it with no filters, so the ANONYMOUS
 * PARTICIPANT HOME PAGE is the same request. Above the ceiling every visitor
 * gets a 413 with no `?limit` to lower, no cursor and no retry that would
 * succeed. That is the same "no smaller request to retry with" cost the outer
 * ceiling accepted, and it is accepted here for the same reason - a catalogue
 * that has outgrown this route should fail loudly and get pagination - but it
 * is a whole-product outage rather than a degraded admin view, and it is pinned
 * by a named arm in opportunities.list-bound.test.ts rather than left here as
 * prose.
 *
 * 5000, and it is a policy number rather than a measurement, chosen the same way
 * 1000 was. An opportunity is hand-authored and a real catalogue is dozens with a
 * handful of sessions each - call it 250, which is roughly 20x below this ceiling
 * rather than the "two orders of magnitude" an earlier draft of this comment
 * claimed. Measured against the OUTER ceiling instead, 5000 is an average of five
 * sessions per opportunity at 1000 opportunities, which is the tighter and more
 * honest way to read it. A deployment that reaches 5000 embedded sessions is
 * already serialising megabytes per catalogue load, and the answer there is
 * pagination rather than a larger constant - the same conclusion #22 reached.
 *
 * THE COUNT NO LONGER GROWS MONOTONICALLY ON EITHER BRANCH. Session creation is
 * capped per REQUEST at `MAX_TIME_SLOTS_PER_REQUEST` and not cumulatively, and
 * nothing reclaims a past session, so an UNFILTERED fan-out was dated rather
 * than merely latent. The participant branch reads only sessions that can still
 * be acted on (`UPCOMING_SESSIONS_ONLY`, below), tracking the live schedule
 * (cto/AdaptaLabs#62); the admin branch reads the live schedule plus a bounded
 * recent tail (`ADMIN_RECENT_SESSIONS_ONLY`, cto/AdaptaLabs#103). Both bounds
 * track the schedule rather than the archive, so this ceiling is a safety limit
 * again rather than a date on the calendar.
 *
 * Written as a NUMBER HERE and asserted as the same number in the test rather
 * than derived from this constant.
 *
 * The ponytail for what is LEFT of that growth sits on `UPCOMING_SESSIONS_ONLY`
 * below, beside the filter that closed half of it.
 */
export const MAX_SESSIONS_RETURNED = 5000;

/**
 * THE FAN-OUT'S TIME FILTER, applied to the PARTICIPANT branch and not the
 * admin one (cto/AdaptaLabs#62).
 *
 * `s.end_time > NOW()` is not "future sessions": it is the set a participant
 * can still ACT on, and it is written to match `backend/src/routes/bookings.ts`
 * exactly, which refuses a booking when `new Date(session.end_time) <= new
 * Date()`. A session that started ten minutes ago and runs for another twenty
 * is bookable, so it belongs in the catalogue; the same predicate on
 * `start_time` would drop it while the product still offers it.
 *
 * WHY THE PARTICIPANT BRANCH ONLY. The ceiling above is a DATE rather than a
 * risk: nothing reclaims a past session, so an unfiltered count grows over the
 * platform's lifetime until every reader of this route gets a 413 with no
 * smaller request to retry. `frontend/src/pages/Home.tsx:42` is one of those
 * readers, which made the arrival of that date a whole-product outage rather
 * than a degraded admin view. Filtering here bounds that path by the LIVE
 * SCHEDULE, which does not grow monotonically.
 *
 * The admin branch is filtered too, but to a RECENT WINDOW rather than to the
 * participant's strict `> NOW()` - see `ADMIN_RECENT_SESSIONS_ONLY` below and
 * cto/AdaptaLabs#103, which is what settled the product question this comment
 * used to leave open.
 *
 * NO PARTICIPANT-FACING READER CONSUMES THESE ROWS TODAY, and the sweep's
 * scope is stated so its narrowness is visible: every file under `frontend/src`,
 * `e2e` and `shared` that mentions `getOpportunities`, case-insensitively, then
 * each of those read for `sessions`. The consumers of `opportunity.sessions`
 * from THIS route are all in `frontend/src/utils/adminDashboard.ts` (getRecruitment,
 * getSessionsThisWeek, getNextSession, getClosingTime) rendered by `Admin.tsx`.
 * `Home.tsx` and the `OpportunityRow` it renders never touch them, and
 * `OpportunityDetail.tsx` gets its sessions from `GET /api/opportunities/:id` -
 * a different query, unchanged here. They do still go OUT on the participant
 * wire (`toPublicOpportunity` strips the joining link and keeps the rows), so
 * this is a payload change with no reader, not a no-op. Re-run that sweep
 * before widening the filter.
 */
const UPCOMING_SESSIONS_ONLY = ` AND s.end_time > NOW()`;

/**
 * THE ADMIN FAN-OUT'S TIME FILTER (cto/AdaptaLabs#103).
 *
 * #62 filtered the PARTICIPANT branch to the live schedule and deliberately left
 * the ADMIN branch unfiltered, because the admin dashboard sums these rows and
 * whether its totals should count completed sessions was a PRODUCT question -
 * one this route must not answer silently. #103 is that question, and Nick's
 * answer: an admin study card means the LIVE SCHEDULE PLUS A RECENT TAIL, not
 * the whole archive.
 *
 * A recent window rather than a strict `> NOW()`, because a re-run of the sweep
 * above found a consumer the original comment predated:
 * `adminDashboard.getSessionsThisWeek` counts THIS WEEK's already-COMPLETED
 * sessions (rendered as "N completed" on the dashboard), so a strict future-only
 * filter would zero that count. Fourteen days is deliberately generous - it
 * comfortably covers the admin's local, Monday-anchored "this week" from any
 * timezone (the backend clock is UTC; the frontend week is local) with room to
 * spare, while bounding the past contribution so the fan-out no longer grows
 * monotonically over the platform's lifetime. That unbounded growth - a 5000
 * ceiling that was a DATE rather than a risk - was the whole of #103.
 *
 * `getRecruitment` (booked/capacity) now sums the live schedule plus this tail
 * rather than all time; that is the intended meaning of the decision, and it is
 * an improvement on a lifetime-cumulative ratio that never reclaimed a past
 * session. Written as a LITERAL and pinned as the same literal in
 * `opportunities.list-bound.test.ts`; the behavioural bound (a session past the
 * window is absent, a recent one present) is pinned against real Postgres in
 * `opportunities.list-upcoming-sessions-postgres.test.ts`.
 */
export const ADMIN_RECENT_SESSIONS_ONLY = ` AND s.end_time > NOW() - INTERVAL '14 days'`;

/**
 * THE LONGEST `?q=` THIS ROUTE WILL SEARCH FOR, and it REFUSES above it.
 *
 * `q` is correctly parameterised - it has never been an injection - but it
 * becomes `%q%`, a LEADING-wildcard `ILIKE` that no index can serve, evaluated
 * twice per row against `title` and `purpose_one_liner`, on an unauthenticated
 * route. An unbounded search term is unbounded work per request.
 *
 * REFUSES rather than truncating for a reason that is not the ceiling argument
 * above: silently shortening a search term returns a SUPERSET of what was
 * asked for and calls it the answer. And unlike the row ceiling, the caller has
 * an obvious recourse - type a shorter query - so a 400 is actionable.
 *
 * 200 characters. The field behind it is a search box over a title and a
 * one-line purpose; the longest of either is itself far below this.
 */
export const MAX_OPPORTUNITY_SEARCH_LENGTH = 200;

/**
 * THE FILTERS THIS LISTING READS, refused if any arrives more than once.
 *
 * A REPEATED QUERY PARAMETER IS AN ARRAY. `?q=a&q=b` reaches express as
 * `['a', 'b']`, and the three reads below are all written `as string`, which is
 * a lie the compiler cannot check. Found by the refute gate on !253, in this
 * fix's OWN new code:
 *
 *   `q`      the length bound was guarded by `typeof q === 'string'`, so an
 *            array SKIPPED it entirely and comma-joined itself into the ILIKE
 *            pattern. Two 300-character values produced a 603-character
 *            pattern; fifty 190-character values produced 9551. Against a
 *            ceiling of 200, on an unauthenticated route, where the pattern is
 *            a leading-wildcard ILIKE evaluated twice per row.
 *   `type`,  not bounds, but pushed straight into a `pool.query` parameter
 *   `status` array, so a repeat sent Postgres an array where it expected text
 *            and answered an unauthenticated 500.
 *
 * REFUSED RATHER THAN COERCED, and this repository has already settled the same
 * question once. `parseLimit` in routes/gamification.ts found `?limit=5&limit=9999`
 * answering with 5 "by a coincidence of comma-joining rather than by any rule",
 * and refused it rather than documenting it. The alternatives here are worse
 * than untidy: taking the first value or joining them answers a question the
 * caller did not ask, and treating the parameter as absent silently WIDENS the
 * result set. A repeat is a malformed request with an obvious recourse.
 *
 * ONE GUARD RATHER THAN A CHECK PER PARAMETER because the defect is the shape,
 * not the parameter. A per-parameter check cannot fail for the parameter nobody
 * wrote one for, which is exactly how `q` was missed while its own bound was
 * being written - and how `from` on `GET /:id/sessions` was still missed after
 * that, until a sweep went looking for the shape rather than the instance.
 *
 * `opportunities.query-params-are-single-valued.test.ts` reads this file and
 * fails if a `req.query.x as string` read appears that no list below covers, so
 * a FOURTH one cannot repeat this a third time. That scan is the enforcement;
 * this comment is not.
 */
const SINGLE_VALUE_FILTERS = ['type', 'q', 'status'] as const;

/**
 * The same guard for `GET /:id/sessions`. `from` is pushed straight into a
 * `pool.query` parameter array against a `timestamp` column, so a repeat sent
 * Postgres the array literal `{"a","b"}` and answered an unauthenticated 500 -
 * while the mock branch beside it turned the same input into `Invalid Date` and
 * carried on. Two backends, two different wrong answers, neither of them a
 * refusal.
 */
const SINGLE_VALUE_SESSION_FILTERS = ['from', 'include_past'] as const;

/**
 * Refuses a repeated parameter, or reports that there was nothing to refuse.
 *
 * Returns a boolean rather than throwing because both callers sit inside a
 * `try` that turns anything thrown into a 500 - which is the status this guard
 * exists to stop the route producing.
 */
const refusedRepeatedParameters = (
  req: Request,
  res: Response,
  names: readonly string[]
): boolean => {
  const repeated = names.filter(
    (name) => req.query[name] !== undefined && typeof req.query[name] !== 'string'
  );
  if (repeated.length === 0) return false;

  res.status(400).json({ error: `${repeated.join(', ')} must be given at most once` });
  return true;
};

// GET /api/opportunities - List opportunities
//
// `withLiveRoleIfPresent` (#45): `isAdmin` below decides drafts, unredacted
// owner identity and `clicks_total`, and it read the role stamped into the
// session at login. The chain re-reads it from `users` first - but only for a
// session that already claims an admin role, so the anonymous and participant
// loads of this catalogue issue exactly the queries they always did.
/**
 * The participant's own completion trace for a set of native survey/poll/one
 * question opportunities, keyed by opportunity id. Present so the detail page
 * and the home row can say "you completed this" instead of offering a Start
 * button that only 409s (audit row 10).
 *
 * Attached for ANY signed-in user, not only participants: during the beta the
 * all-admin switch lifts every employee to `researcher_admin`, yet those same
 * people take surveys, so gating on role would hide the trace from everyone.
 *
 * `completed` is derived through `isAnsweredRuntimeStatus`, the same predicate
 * the mint gate uses, so the trace and the 409 can never disagree about what
 * counts as answered. A read failure degrades to no trace rather than a 500:
 * the Start button reappears and the mint gate still refuses a second answer.
 */
async function participantCompletionMap(
  participantId: string,
  opportunityIds: string[]
): Promise<Map<string, { completed: boolean; completedAt: string | null }>> {
  const map = new Map<string, { completed: boolean; completedAt: string | null }>();
  if (opportunityIds.length === 0) {
    return map;
  }

  try {
    const rows = await findParticipantCompletionsForOpportunities({
      participantId,
      opportunityIds
    });
    for (const row of rows) {
      const completed = isAnsweredRuntimeStatus(row.sessionStatus);
      map.set(row.opportunityId, {
        completed,
        completedAt: completed ? row.completedAt : null
      });
    }
  } catch (error) {
    logger.error('Failed to load participant completion trace', { error });
  }

  return map;
}

router.get('/', optionalAuth, withLiveRoleIfPresent, asyncHandler(async (req: Request, res: Response) => {
  try {
    // FIRST, above every other read: the casts below are only true once this
    // has run, and the mock/database split is further down still. The bound is
    // on what the caller sent, so it must not depend on which backend answers -
    // an array used to reach the mock path as a 500.
    if (refusedRepeatedParameters(req, res, SINGLE_VALUE_FILTERS)) return;

    const type = req.query.type as string | undefined;
    const q = req.query.q as string | undefined;
    const status = req.query.status as string | undefined;
    const isAdmin = isAdminRole(req.user?.role);

    if (q !== undefined && q.length > MAX_OPPORTUNITY_SEARCH_LENGTH) {
      return res.status(400).json({
        error: `q must not exceed ${MAX_OPPORTUNITY_SEARCH_LENGTH} characters`
      });
    }

    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    
    if (!dbAvailable) {
      // Use mock data
      interface OpportunityFilters {
        type?: string;
        q?: string;
        status?: string;
      }
      const filters: OpportunityFilters = {};
      if (type) filters.type = type as string;
      if (q) filters.q = q as string;
      if (status) filters.status = status as string;
      else if (!isAdmin) filters.status = 'published'; // Default to published for non-admin
      
      const opportunities = getMockOpportunities(filters);
      res.json(isAdmin ? opportunities : opportunities.map(toPublicOpportunity));
      return;
    }
    
    // Use database - LEFT JOIN so opportunities show even when owner not in users (e.g. demo/session-only)
    let query = `
      SELECT o.*, u.name as owner_name, u.email as owner_email
      FROM opportunities o
      LEFT JOIN users u ON o.owner_user_id = u.id
    `;
    const params: (string | number)[] = [];
    const conditions: string[] = [];
    
    // Add filters
    if (type) {
      conditions.push(`o.type = $${params.length + 1}`);
      params.push(type);
    }
    
    if (q) {
      conditions.push(`(o.title ILIKE $${params.length + 1} OR o.purpose_one_liner ILIKE $${params.length + 1})`);
      params.push(`%${q}%`);
    }
    
    // Admins can filter by status; non-admins always get only published
    if (isAdmin && status) {
      conditions.push(`o.status = $${params.length + 1}`);
      params.push(status);
    } else if (!isAdmin) {
      // Non-admins may only ever see published studies, regardless of any status query param
      conditions.push(`o.status = 'published'`);
    }
    
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    // ONE MORE THAN WILL EVER BE RETURNED, so "there are more" is a fact the
    // row count states rather than something inferred from a full page. Without
    // the `+ 1` the `>` below is unsatisfiable, the 413 becomes unreachable, and
    // the refusal silently becomes the truncation it exists to prevent. Same
    // shape, and the same reason, as `MAX_CSV_PARTICIPANTS + 1`.
    query += ` ORDER BY o.created_at DESC LIMIT ${MAX_OPPORTUNITIES_RETURNED + 1}`;

    const result = await pool.query(query, params);

    // Decided BEFORE any of the fan-out below, which is the only place it can
    // be decided cheaply: the batch session read that follows is `ANY($1::uuid[])`
    // over every id returned.
    if (result.rows.length > MAX_OPPORTUNITIES_RETURNED) {
      return res.status(413).json({
        error: `Too many studies to list; this route returns at most ${MAX_OPPORTUNITIES_RETURNED}`,
        maximumOpportunities: MAX_OPPORTUNITIES_RETURNED
      });
    }

    // Performance optimization: Batch load all sessions and click counts in single queries
    // instead of N+1 queries per opportunity
    const opportunityIds = result.rows.map(opp => opp.id);
    
    // Get all sessions for all opportunities in one query
    const allSessionsMap: Map<string, any[]> = new Map();
    try {
      const sessionsResult = await pool.query(
        // ONE MORE THAN WILL EVER BE RETURNED, for the same reason the listing
        // query above asks for `MAX_OPPORTUNITIES_RETURNED + 1`: without the
        // `+ 1` the `>` below is unsatisfiable, the 413 is unreachable, and the
        // refusal silently becomes the truncation it exists to prevent.
        `SELECT s.*,
                COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)::int as actual_booked_count,
                s.opportunity_id
         FROM sessions s
         LEFT JOIN bookings b ON s.id = b.session_id
         WHERE s.opportunity_id = ANY($1::uuid[])${isAdmin ? ADMIN_RECENT_SESSIONS_ONLY : UPCOMING_SESSIONS_ONLY}
         GROUP BY s.id, s.opportunity_id, s.start_time, s.end_time, s.capacity,
                  s.location_or_meet_link_optional, s.created_at, s.updated_at, s.booked_count
         ORDER BY s.opportunity_id, s.start_time ASC
         LIMIT ${MAX_SESSIONS_RETURNED + 1}`,
        [opportunityIds]
      );
      // DECIDED BEFORE THE ROWS ARE MAPPED, and it RETURNS rather than throwing.
      // The catch below turns a failed session read into an empty sessions array
      // and carries on, which is right for a transient database error and would
      // be catastrophic for a refusal - a thrown 413 would be swallowed into a
      // 200 carrying no sessions at all, which is the silent truncation this
      // ceiling exists to prevent (cto/AdaptaLabs#41). `res.json` does not throw,
      // so the return leaves the handler here.
      if (sessionsResult.rows.length > MAX_SESSIONS_RETURNED) {
        return res.status(413).json({
          error: `Too many sessions to list; this route returns at most ${MAX_SESSIONS_RETURNED}`,
          maximumSessions: MAX_SESSIONS_RETURNED
        });
      }

      // Group sessions by opportunity_id
      for (const session of sessionsResult.rows) {
        const oppId = session.opportunity_id;
        if (!allSessionsMap.has(oppId)) {
          allSessionsMap.set(oppId, []);
        }
        allSessionsMap.get(oppId)!.push({
          ...session,
          booked_count: session.actual_booked_count, // Use calculated value
          remaining: session.capacity - (session.actual_booked_count || 0), // Calculate from actual bookings
          start_time: session.start_time.toISOString(),
          end_time: session.end_time.toISOString(),
          created_at: session.created_at.toISOString(),
          updated_at: session.updated_at.toISOString(),
        });
      }
    } catch (sessionError: any) {
      logger.error('Error loading sessions batch:', { error: sessionError });
      // Continue with empty sessions map - opportunities will have empty sessions array
    }

    // Get all click counts for poll/survey opportunities in one query (only if admin)
    const clicksMap: Map<string, number> = new Map();
    if (isAdmin) {
      try {
        const pollSurveyOppIds = result.rows
          .filter(opp => opp.type === 'poll' || opp.type === 'survey' || opp.type === 'unmoderated')
          .map(opp => opp.id);
        
        if (pollSurveyOppIds.length > 0) {
          const clicksResult = await pool.query(
            `SELECT opportunity_id, COUNT(*)::int as count 
             FROM opportunity_clicks 
             WHERE opportunity_id = ANY($1::uuid[])
             GROUP BY opportunity_id`,
            [pollSurveyOppIds]
          );
          
          // Map click counts by opportunity_id
          for (const row of clicksResult.rows) {
            clicksMap.set(row.opportunity_id, parseInt(row.count || '0', 10));
          }
        }
      } catch (clickError: any) {
        logger.error('Error loading click counts batch:', { error: clickError });
        // Continue with empty clicks map
      }
    }

    // The signed-in participant's completion trace for the native survey/poll/
    // one-question rows on this page, in one batched read (audit row 10). Only
    // those types carry a trace; a bookable study leaves its trace in bookings.
    const completionById = req.user
      ? await participantCompletionMap(
          req.user.id,
          result.rows
            .filter(opp => runsNativeSurvey(opp.type, opp.delivery_mode))
            .map(opp => String(opp.id))
        )
      : new Map<string, { completed: boolean; completedAt: string | null }>();

    // Combine results
    const opportunities = result.rows.map(opportunity => {
      const sessions = allSessionsMap.get(opportunity.id) || [];

      const completion = runsNativeSurvey(opportunity.type, opportunity.delivery_mode)
        ? (completionById.get(String(opportunity.id)) ?? { completed: false, completedAt: null })
        : undefined;

      // Kept last before the return, immediately followed by it: a mutation-canary
      // entry pins `clicks_total ... : undefined;` directly against that `return {`
      // (clicks-total-is-withheld-not-zeroed). Insert nothing between the two.
      const clicks_total = ((opportunity.type === 'poll' || opportunity.type === 'survey' || opportunity.type === 'unmoderated') && isAdmin)
        ? (clicksMap.get(opportunity.id) ?? 0)
        : undefined;

      return {
        ...opportunity,
        owner_name: opportunity.owner_name || 'Unknown',
        owner_email: opportunity.owner_email || 'unknown@example.com',
        created_at: opportunity.created_at.toISOString(),
        updated_at: opportunity.updated_at.toISOString(),
        start_date: opportunity.start_date ? opportunity.start_date.toISOString() : null,
        end_date: opportunity.end_date ? opportunity.end_date.toISOString() : null,
        sessions,
        clicks_total,
        ...(completion ? { completion } : {}),
      };
    });

    res.json(isAdmin ? opportunities : opportunities.map(toPublicOpportunity));
  } catch (error) {
    // Operational errors (e.g. the 503 isDatabaseAvailable throws during an
    // outage) carry their own status and code - let errorHandler serialise
    // them instead of flattening to a generic 500.
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error in opportunities route', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
}));

// GET /api/opportunities/:id - Get opportunity detail
// `withLiveRoleIfPresent` (#45): `isAdmin` below decides whether an UNPUBLISHED
// opportunity is served at all, on the live role rather than the login one.
router.get('/:id', optionalAuth, withLiveRoleIfPresent, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const isAdmin = isAdminRole(req.user?.role);
  
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  
  if (!dbAvailable) {
    // Use mock data
    const opportunity = getMockOpportunity(id);
    if (!opportunity) {
      throw new NotFoundError('Study');
    }

    // Non-admin users can only see published opportunities
    if (!isAdmin && opportunity.status !== 'published') {
      throw unavailableOpportunityError(opportunity.status);
    }

    res.json(isAdmin ? opportunity : toPublicOpportunity(opportunity));
    return;
  }

  // Use database - LEFT JOIN so opportunities show even when owner not in users (e.g. demo/session-only)
  //
  // The status filter is NOT in the SQL any more, deliberately. Filtering
  // `AND o.status = 'published'` in the query collapsed three distinct answers
  // - missing, closed, and not-yet-open - into the same empty result, and the
  // participant page could only render one of them: "not found, maybe deleted,
  // maybe no permission" plus a Retry that reloads into the identical 404. A
  // participant landing on a study that has since CLOSED, or on a draft link
  // shared before launch, was told the study did not exist. Load the row first,
  // then decide, so closed and not-open become their own honest states.
  const query = `
    SELECT o.*, u.name as owner_name, u.email as owner_email
    FROM opportunities o
    LEFT JOIN users u ON o.owner_user_id = u.id
    WHERE o.id = $1
  `;
  const params = [id];

  const result = await pool.query(query, params);

  if (result.rows.length === 0) {
    throw new NotFoundError('Study');
  }

  // Non-admin users can only VIEW published opportunities, but a non-published
  // row that exists is a different fact from one that does not. Decide before
  // the sessions query so an unavailable study never pays for a second read.
  if (!isAdmin && result.rows[0].status !== 'published') {
    throw unavailableOpportunityError(result.rows[0].status);
  }

  // Get sessions for this opportunity with dynamic booked_count calculation
  const sessionsResult = await pool.query(`
    SELECT s.*,
           COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)::int as actual_booked_count
    FROM sessions s
    LEFT JOIN bookings b ON s.id = b.session_id
    WHERE s.opportunity_id = $1
    GROUP BY s.id, s.opportunity_id, s.start_time, s.end_time, s.capacity,
             s.location_or_meet_link_optional, s.created_at, s.updated_at, s.booked_count
    ORDER BY s.start_time ASC
  `, [id]);

  const row = result.rows[0];
  const opportunity = {
    ...row,
    owner_name: row.owner_name || 'Unknown',
    owner_email: row.owner_email || 'unknown@example.com',
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    start_date: row.start_date ? row.start_date.toISOString() : null,
    end_date: row.end_date ? row.end_date.toISOString() : null,
    sessions: sessionsResult.rows.map(session => ({
      ...session,
      booked_count: session.actual_booked_count, // Use calculated value
      remaining: session.capacity - (session.actual_booked_count || 0), // Calculate from actual bookings
      start_time: session.start_time.toISOString(),
      end_time: session.end_time.toISOString(),
      created_at: session.created_at.toISOString(),
      updated_at: session.updated_at.toISOString(),
    }))
  };

  // The participant's own completion trace for a native survey/poll/one
  // question, so the page can say "you completed this" and drop the Start
  // button instead of offering a retake the mint gate would only 409 (audit
  // row 10). Attached for any signed-in user - see participantCompletionMap on
  // why role is not the gate during the beta.
  const withCompletion =
    req.user && runsNativeSurvey(row.type, row.delivery_mode)
      ? {
          ...opportunity,
          completion:
            (await participantCompletionMap(req.user.id, [String(row.id)])).get(
              String(row.id)
            ) ?? { completed: false, completedAt: null }
        }
      : opportunity;

  res.json(isAdmin ? withCompletion : toPublicOpportunity(withCompletion));
}));

// POST /api/opportunities - Create opportunity
router.post('/', requireAdmin, opportunityWriteLimiter, validateRequest(CreateOpportunitySchema), asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    // Note: Data is already validated by validateRequest(CreateOpportunitySchema) middleware
    const data: CreateOpportunityRequest = req.body;
    
    // Create mock opportunity
    const mockOpportunity = {
      id: `mock-${Date.now()}`,
      type: data.type,
      title: data.title.trim(),
      purpose_one_liner: data.purpose_one_liner.trim(),
      description_optional: data.description_optional?.trim() || null,
      product_optional: data.product_optional?.trim() || null,
      default_duration_minutes: data.default_duration_minutes || 30,
      status: data.status || 'draft',
      owner_user_id: req.user!.id,
      // Moderated consent (#79): the same type gate and template resolution the
      // database path runs, so the two branches cannot disagree about what a
      // save stored. Computed inline: this branch has no earlier seam.
      ...(() => {
        const consent = resolveModeratedConsentWrite(data, data.type);
        return {
          consent_text: consent?.consent_text ?? null,
          consent_template_id: consent?.consent_template_id ?? null,
          consent_template_version: consent?.consent_template_version ?? null
        };
      })(),
      external_link_optional: data.external_link_optional?.trim() || null,
      participant_type_required: data.participant_type_required || 'any',
      participant_type_specific_details: data.participant_type_specific_details?.trim() || null,
      start_date: data.start_date || null,
      end_date: data.end_date || null,
      created_at: new Date(),
      updated_at: new Date(),
      owner_name: req.user!.name,
      owner_email: req.user!.email,
      sessions: []
    };
    
    // Add to dynamic mock data
    addMockOpportunity(mockOpportunity);
    
    return res.status(201).json(mockOpportunity);
  }
  
  const data: CreateOpportunityBody = req.body;
  // Note: Data is already validated by validateRequest(CreateOpportunitySchema) middleware

  // Unmoderated studies run with logged-in Cortex users, so an external
  // participant type is not representable.
  if (data.type === 'unmoderated' && data.participant_type_required === 'external') {
    throw new ValidationError('Unmoderated studies cannot use an external participant type; participants must be logged-in Cortex users');
  }

  // Normalised once and used everywhere below. Three separate truthiness rules
  // on this field previously disagreed: an all-whitespace id passed
  // z.string().min(1), was falsy where the inline study was resolved but truthy
  // in the publish guard, and then stored as NULL - landing a published
  // unmoderated opportunity with no study, exactly what the guard prevents.
  const linkedStudyId = data.firsthand_study_id?.trim() || undefined;

  // An inline study is only meaningful for unmoderated. Both of these are
  // rejections rather than silent drops, and PATCH enforces the same two: a
  // request that quietly discards the tasks someone just wrote is the failure
  // mode this whole feature exists to remove.
  if (data.inline_study && data.type !== 'unmoderated') {
    throw new ValidationError('Only unmoderated studies can carry a task list');
  }

  // The survey counterpart, with the mirror-image restriction. A recorded study
  // cannot carry questions and a question-carrying type cannot carry a task
  // list: the two vocabularies are not interchangeable, which is the whole
  // reason `kind` exists.
  if (data.inline_survey && !QUESTION_CARRYING_TYPES.has(data.type)) {
    throw new ValidationError(ONLY_QUESTION_TYPES_CARRY_QUESTIONS);
  }

  if (data.inline_survey && (data.delivery_mode ?? 'external') !== 'native') {
    throw new ValidationError(QUESTIONS_NEED_NATIVE_DELIVERY);
  }

  if (
    data.inline_survey &&
    countAskedQuestions(data.inline_survey.steps) > maxQuestionsFor(data.type)
  ) {
    throw new ValidationError(TOO_MANY_QUESTIONS_MESSAGE);
  }

  if (linkedStudyId && data.inline_study) {
    throw new ValidationError(
      'Send either firsthand_study_id or inline_study, not both'
    );
  }

  if (linkedStudyId && data.inline_survey) {
    throw new ValidationError(
      'Send either firsthand_study_id or inline_survey, not both'
    );
  }

  const inlineStudy = data.inline_study;
  const inlineSurvey = data.inline_survey;

  // Every existing poll and survey is external, and the column defaults to it,
  // so an absent value means external here too.
  const deliveryMode = data.delivery_mode ?? 'external';

  // Additional validation for published opportunities. The rule itself lives in
  // `shared/firsthand/publish-readiness`, so the Review step can preview this
  // refusal by asking the same function rather than restating it. `linkedStudyId`
  // is already trimmed above, which is why the boolean is safe to pass straight in.
  const createPublishProblem = findPublishProblem({
    willBePublished: data.status === 'published',
    type: data.type,
    deliveryMode,
    hasLinkedStudy: Boolean(linkedStudyId),
    hasInlineStudy: Boolean(inlineStudy),
    hasInlineSurvey: Boolean(inlineSurvey),
    externalLink: data.external_link_optional,
    // A create writes NO sessions - they are a separate `POST /api/sessions`
    // against the returned id - so a fresh row has zero bookable slots by
    // construction. For `test`/`interview` that makes `false` the honest and
    // only correct value, and it closes the direct-API hole (#118): a bookable
    // study cannot be published in one create call. The wizard reaches a
    // published live session by creating as draft, adding slots, then updating
    // to published (see OpportunityForm `handleSubmit`), which is the update
    // guard's job below, not this one.
    hasBookableSlot: false
    // No `removingLinkedStudy`: nothing is being removed from an opportunity
    // that does not exist yet.
  });
  if (createPublishProblem) {
    throw new ValidationError(PUBLISH_PROBLEM_MESSAGES[createPublishProblem.code]);
  }

  // Checked whatever the status, not only on publish: a draft carrying a
  // mismatched study is a draft that cannot be published, and saying so now is
  // better than saying it later.
  //
  // Ownership is checked unconditionally here (`true`), unlike the PATCH call
  // site: create has no prior link to compare against, so any linkedStudyId
  // on this request is by definition a new one.
  if (linkedStudyId) {
    await assertLinkedStudyKindMatches(
      linkedStudyId,
      data.type,
      deliveryMode,
      { userId: req.user!.id, isSuperadmin: req.user!.role === 'superadmin' },
      true
    );
  }

  // Ensure session user exists in DB (demo/session-only users may not be persisted)
  await pool.query(
    `INSERT INTO users (id, name, email, business_unit, role_title, role)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
       business_unit = EXCLUDED.business_unit, role_title = EXCLUDED.role_title, role = EXCLUDED.role`,
    [
      req.user!.id,
      req.user!.name,
      req.user!.email,
      req.user!.business_unit || null,
      req.user!.role_title || null,
      req.user!.role,
    ]
  );

  const query = `
    INSERT INTO opportunities (
      type, title, purpose_one_liner, description_optional,
      product_optional, meeting_location_optional, default_duration_minutes, status,
      owner_user_id, external_link_optional, firsthand_study_id, participant_type_required,
      participant_type_specific_details, start_date, end_date, delivery_mode,
      consent_text, consent_template_id, consent_template_version
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
    RETURNING *
  `;

  // Moderated consent (#79): refused for every non-moderated type, resolved to
  // its template BEFORE the row exists so the claim-is-input rule holds from
  // the first write.
  const consentColumns = resolveModeratedConsentWrite(data, data.type);

  // The study has to exist before the opportunity row that references it.
  //
  // Studies live on the FirstHand runtime pool and opportunities on the app
  // pool, so a single SQL transaction cannot span both even though they are the
  // same database. The compensating delete below is what keeps a failed insert
  // from leaving behind a launched study nobody asked for.
  let createdStudyId: string | null = null;
  /**
   * The minted study's `updated_at`, for the caller's FIRST concurrency
   * precondition.
   *
   * The create response is the only place a client that authored content here
   * can learn it without a second round trip, and an autosave needs it
   * immediately: its very next save is a PATCH carrying `inline_*`, which
   * without a precondition writes under the fail-open. See the PATCH
   * handler's twin for why absence rather than null is the honest signal for
   * "this request wrote no study".
   */
  let linkedStudyUpdatedAt: string | null = null;

  if (inlineStudy) {
    if (!isStudiesPersistenceConfigured()) {
      // Matches the 503 the direct studies route answers with, rather than
      // letting createStudy throw a bare Error that the handler cannot map.
      throw new AppError('Task lists require a configured PostgreSQL database.', 503);
    }

    // Generated here rather than left to createStudy so the step ids can be
    // namespaced with it - see toStudySteps on why that is load-bearing.
    const studyId = `study_${crypto.randomUUID()}`;

    const stored = await createStudy({
      id: studyId,
      title: data.title.trim(),
      intro_text: data.purpose_one_liner.trim(),
      consent_text: inlineStudy.consent_text.trim(),
      consent_template_id: inlineStudy.consent_template_id ?? null,
      consent_template_version: inlineStudy.consent_template_version ?? null,
      // NOT `?? data.default_duration_minutes`. That column is NOT NULL with a
      // DEFAULT of 30, so falling back to it gave every recorded study a
      // duration nobody chose - and put it above a consent button. Null means
      // the researcher did not say, and every surface already handles null by
      // saying nothing.
      estimated_duration_minutes: resolveStudyDuration(inlineStudy.estimated_duration_minutes),
      // Launched rather than draft: only launched studies are selectable, and a
      // study authored as part of an opportunity has no separate review step to
      // wait for. Leaving it draft would publish an opportunity pointing at a
      // study the picker refuses to show.
      status: 'launched',
      // Same owner as the opportunity this study is being authored for, so the
      // two sides of the same authoring action agree on who may edit them.
      owner_user_id: req.user!.id,
      // Provenance only, from the picker's copy-on-select. Explicit `?? null`
      // rather than leaving it to createStudy's own default so the intent
      // reads here: absence means this study was authored from blank.
      copied_from_study_id: inlineStudy.copied_from_study_id ?? null,
      steps: toStudySteps(inlineStudy.steps, studyId, inlineStudy.target_url)
    });
    createdStudyId = stored.study.id;
    linkedStudyUpdatedAt = stored.study.updated_at;
  } else if (inlineSurvey) {
    if (!isStudiesPersistenceConfigured()) {
      throw new AppError('Questions require a configured PostgreSQL database.', 503);
    }

    const studyId = `study_${crypto.randomUUID()}`;

    const stored = await createStudy({
      id: studyId,
      title: data.title.trim(),
      intro_text: data.purpose_one_liner.trim(),
      consent_text: inlineSurvey.consent_text.trim(),
      consent_template_id: inlineSurvey.consent_template_id ?? null,
      consent_template_version: inlineSurvey.consent_template_version ?? null,
      estimated_duration_minutes: resolveStudyDuration(
        inlineSurvey.estimated_duration_minutes
      ),
      status: 'launched',
      owner_user_id: req.user!.id,
      // The one line that makes this a survey rather than a task list. Without
      // it the study is stored as `recorded` - the repository's default - and
      // the linkage check would then refuse the very opportunity that authored
      // it, which is a confusing way to find out.
      kind: 'survey',
      // Provenance only, from the picker's copy-on-select. See the task-list
      // branch above for why this is explicit rather than left to the default.
      copied_from_study_id: inlineSurvey.copied_from_study_id ?? null,
      steps: toSurveySteps(inlineSurvey.steps, studyId)
    });
    createdStudyId = stored.study.id;
    linkedStudyUpdatedAt = stored.study.updated_at;
  } else if (linkedStudyId && isStudiesPersistenceConfigured()) {
    // Reusing an existing study. If it is one of the legacy rows migration
    // 0007 could not attribute, claim it now: publishing an opportunity is the
    // moment an unowned study starts being served to participants, and until
    // it has an owner any admin can rewrite its consent copy and target URLs.
    // Before the opportunity row is written, so a failure here fails the whole
    // request rather than leaving a published opportunity behind an unowned
    // study. Claiming a study whose insert then fails is harmless - it gives
    // an ownerless row an owner, which is the direction this is going anyway.
    if (await claimStudyIfUnowned(linkedStudyId, req.user!.id)) {
      logger.info('Unowned study claimed by the opportunity linking it', {
        studyId: linkedStudyId,
        newOwnerUserId: req.user!.id
      });
    }
  }

  const values = [
    data.type,
    data.title.trim(),
    data.purpose_one_liner.trim(),
    data.description_optional?.trim() || null,
    data.product_optional?.trim() || null,
    data.meeting_location_optional?.trim() || null,
    data.default_duration_minutes || 30,
    data.status || 'draft',
    req.user!.id,
    data.external_link_optional?.trim() || null,
    createdStudyId ?? linkedStudyId ?? null,
    data.participant_type_required || 'any',
    data.participant_type_specific_details?.trim() || null,
    data.start_date || null,
    data.end_date || null,
    // Stored for every type, not only poll and survey. The column is NOT NULL
    // and the other types ignore it, so writing the resolved value keeps the
    // row honest rather than relying on the DDL default for some paths and the
    // request for others.
    deliveryMode,
    consentColumns?.consent_text ?? null,
    consentColumns?.consent_template_id ?? null,
    consentColumns?.consent_template_version ?? null
  ];

  let result;
  try {
    result = await pool.query(query, values);
  } catch (error) {
    if (createdStudyId) {
      try {
        await deleteStudyUnchecked(createdStudyId);
      } catch (cleanupError) {
        // Swallowed deliberately: the caller needs the original insert failure,
        // not this one. Logged with the id so an orphan can be found by hand.
        logger.error('Failed to remove inline study after opportunity insert failed', {
          studyId: createdStudyId,
          error: String(cleanupError)
        });
      }
    }
    throw error;
  }
  const opportunity = {
    ...result.rows[0],
    created_at: result.rows[0].created_at.toISOString(),
    updated_at: result.rows[0].updated_at.toISOString(),
    start_date: result.rows[0].start_date ? result.rows[0].start_date.toISOString() : null,
    end_date: result.rows[0].end_date ? result.rows[0].end_date.toISOString() : null,
    sessions: [],
    // Same contract as the PATCH response: present only when this request
    // actually wrote a study, so absence means "nothing to say" rather than
    // "there is no study".
    ...(linkedStudyUpdatedAt ? { linked_study_updated_at: linkedStudyUpdatedAt } : {})
  };
  
  res.status(201).json(opportunity);
}));

// PATCH /api/opportunities/:id - Update opportunity
router.patch('/:id', requireAdmin, opportunityWriteLimiter, validateRequest(UpdateOpportunitySchema), asyncHandler(async (req: Request, res: Response) => {
  // THE ALLOW-LIST IS THE INJECTION FIX. See UPDATABLE_OPPORTUNITY_COLUMNS for
  // why the builder further down is unsafe on its own.
  //
  // WHY IT IS HERE AND NOT BESIDE THE BUILDER. Both branches need it. The
  // security gate on the sessions fix proved that by making that allow-list
  // database-only, which survived all 958 tests - the `!dbAvailable` branch
  // spreads the body into the stored object, so an unknown key there is
  // unrestricted mass assignment with no SQL involved.
  //
  // WHY IT READS `req.body` RATHER THAN `data`. `data` does not exist yet on
  // either branch, and the destructure that produces it on the database path
  // is ~600 lines below. Reading the parsed body here is the same key set.
  //
  // WHY IT REFUSES RATHER THAN DROPS. Silently ignoring a field tells the
  // caller their save succeeded when part of it did not happen.
  //
  // The message names the PERMITTED fields and never echoes what was sent: the
  // offending key is attacker-chosen text, and reflecting it into a response
  // body puts it one careless render away from being a second vulnerability.
  // Only the first argument to ValidationError reaches the wire - errorHandler
  // serialises `{ error: error.message, ... }` and drops the details array - so
  // the keys go in the `logger.warn` explicitly, bounded, where an operator
  // watching an attempt can see what was tried.
  const unknownFields = Object.keys(req.body ?? {}).filter(
    (key) => !UPDATABLE_OPPORTUNITY_COLUMNS.has(key) && !NON_COLUMN_OPPORTUNITY_BODY_KEYS.has(key)
  );
  if (unknownFields.length > 0) {
    logger.warn('Refused an opportunity update naming a column outside the allow-list', {
      opportunityId: req.params.id,
      userId: req.user?.id,
      count: unknownFields.length,
      // Bounded on BOTH axes. The count cap was here from the start; the
      // length cap was not, and `express.json()` is mounted with no `limit`,
      // so one key can be 100kb of attacker-chosen text. A log line is the
      // right place for these - it is not the response - but not at any size.
      fields: unknownFields.slice(0, 10).map((field) => field.slice(0, 64))
    });
    throw new ValidationError('Validation failed', [
      `Only ${[...UPDATABLE_OPPORTUNITY_COLUMNS].join(', ')} may be updated`
    ]);
  }

  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    // Note: Data is already validated by validateRequest(UpdateOpportunitySchema) middleware
    const { id } = req.params;
    const data: UpdateOpportunityRequest = req.body;
    
    // Check if opportunity exists
    const existingOpportunity = getMockOpportunity(id);
    if (!existingOpportunity) {
      throw new NotFoundError('Study');
    }
    
    // Check ownership (superadmins can edit any)
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && !isOpportunityOwner(existingOpportunity, req.user)) {
      throw new ForbiddenError('Only the owner can edit this study');
    }

    // Moderated consent (#79): same gate and resolution as the database branch,
    // against the EFFECTIVE type - the body's when it changes type, the stored
    // one otherwise.
    const mockConsent = resolveModeratedConsentWrite(
      data,
      data.type || existingOpportunity.type
    );

    // Same rule as the database branch: leaving the moderated pair strips
    // consent, or the wording strands on a type that can never clear it.
    const consentStrippedByTypeChange =
      data.type !== undefined && !MODERATED_CONSENT_TYPES.has(data.type)
        ? { consent_text: null, consent_template_id: null, consent_template_version: null }
        : {};

    // Update the opportunity
    const updatedOpportunity = updateMockOpportunity(id, {
      ...data,
      ...(mockConsent ?? {}),
      ...consentStrippedByTypeChange,
      updated_at: new Date()
    });
    
    if (!updatedOpportunity) {
      throw new NotFoundError('Study');
    }
    
    return res.json(updatedOpportunity);
  }
  
  const { id } = req.params;
  // inline_study is consumed to build a study and must NOT survive into the
  // generic field loop below, which maps every remaining key straight to a
  // column name - it is not a column on opportunities.
  //
  // `expected_study_updated_at` is destructured out for the same reason and it
  // is not optional housekeeping: leaving it in `data` would emit
  // `SET expected_study_updated_at = $n` against a column that does not exist,
  // and answer 500 on every save the moment the client starts sending it.
  const {
    inline_study: inlineStudyInput,
    inline_survey: inlineSurveyInput,
    expected_study_updated_at: expectedStudyUpdatedAt,
    ...data
  }: UpdateOpportunityBody = req.body;
  // Note: Data is already validated by validateRequest(UpdateOpportunitySchema) middleware
  
  // Check ownership (only owner or global admin can edit)
  const ownershipCheck = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [id]
  );
  
  if (ownershipCheck.rows.length === 0) {
    throw new NotFoundError('Study');
  }
  
  // Check ownership (superadmins can edit any)
  const isOwner = isOpportunityOwner(ownershipCheck.rows[0], req.user);
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOwner) {
    throw new ForbiddenError('Only the owner can edit this study');
  }
  
  // Get existing opportunity to check type when status is being changed
  const existingOpp = await pool.query(
    // title and purpose_one_liner are read so an inline study created on this
    // path can inherit them when the request does not also change them.
    'SELECT type, title, purpose_one_liner, status, external_link_optional, firsthand_study_id, participant_type_required, delivery_mode FROM opportunities WHERE id = $1',
    [id]
  );
  // Same delete-mid-request race the UPDATE below now handles: without this the
  // row access throws a TypeError and answers 500 instead of 404.
  if (existingOpp.rows.length === 0) {
    throw new NotFoundError('Study');
  }

  const existingType = data.type || existingOpp.rows[0].type;

  // Moderated consent (#79): refuse on the wrong effective type, resolve the
  // template claim, and OVERWRITE what flows into the generic column loop -
  // the stored pair must come from resolution, never from the request. When
  // the body carries no consent fields, nothing is touched.
  const consentWrite = resolveModeratedConsentWrite(data, existingType);
  if (consentWrite) {
    data.consent_text = consentWrite.consent_text;
    data.consent_template_id = consentWrite.consent_template_id;
    data.consent_template_version = consentWrite.consent_template_version;
  }

  // A type change out of the moderated pair strips consent in the same UPDATE.
  // Without this, the wording stays on the row - and public, via
  // toPublicOpportunity - on a type whose every consent PATCH the gate above
  // refuses, so nobody could clear it without flipping the type back. Runs
  // after the resolver on purpose: a body carrying BOTH a type change and
  // consent fields was already refused by CONSENT_FIELDS_WRONG_TYPE, and
  // seeding the nulls before the resolver would make it refuse this stripping
  // as a wrong-type consent write.
  if (data.type !== undefined && !MODERATED_CONSENT_TYPES.has(data.type)) {
    data.consent_text = null;
    data.consent_template_id = null;
    data.consent_template_version = null;
  }

  const existingLink = existingOpp.rows[0].external_link_optional;
  const existingFirstHandStudyId = existingOpp.rows[0].firsthand_study_id;
  const newLink = data.external_link_optional !== undefined ? data.external_link_optional : existingLink;
  const newFirstHandStudyId = data.firsthand_study_id !== undefined ? data.firsthand_study_id : existingFirstHandStudyId;
  const newParticipantType = data.participant_type_required !== undefined
    ? data.participant_type_required
    : existingOpp.rows[0].participant_type_required;
  // The mode this request leaves behind, for the same reason the publish guard
  // below reads the resulting state rather than only what the request sets.
  const newDeliveryMode =
    data.delivery_mode !== undefined
      ? data.delivery_mode
      : existingOpp.rows[0].delivery_mode ?? 'external';

  // Unmoderated studies run with logged-in Cortex users, so an external
  // participant type is not representable. Only enforce when this request
  // actually sets the type or participant type, so an unrelated edit to a
  // legacy unmoderated+external row is not blocked (the bad value can still be
  // corrected by PATCHing participant_type_required to a non-external value).
  if (
    (data.type !== undefined || data.participant_type_required !== undefined) &&
    existingType === 'unmoderated' &&
    newParticipantType === 'external'
  ) {
    throw new ValidationError('Unmoderated studies cannot use an external participant type; participants must be logged-in Cortex users');
  }

  if (inlineSurveyInput && newDeliveryMode !== 'native') {
    throw new ValidationError(QUESTIONS_NEED_NATIVE_DELIVERY);
  }

  // An inline study can only fill a gap, never replace a link. Rejected rather
  // than resolved by precedence, matching create.
  if (inlineStudyInput && existingType !== 'unmoderated') {
    throw new ValidationError('Only unmoderated studies can carry a task list');
  }

  if (inlineSurveyInput && !QUESTION_CARRYING_TYPES.has(existingType)) {
    throw new ValidationError(ONLY_QUESTION_TYPES_CARRY_QUESTIONS);
  }

  // `existingType` is the RESULTING type, merged over the stored row by the
  // block above - so a PATCH that turns a survey into a `question` is capped by
  // the cap it is moving to, not the one it is leaving.
  if (
    inlineSurveyInput &&
    countAskedQuestions(inlineSurveyInput.steps) > maxQuestionsFor(existingType)
  ) {
    throw new ValidationError(TOO_MANY_QUESTIONS_MESSAGE);
  }

  // Authored content against an opportunity that ALREADY has a study used to be
  // refused outright here - "edit its tasks in the Task Lists area" - because
  // `inline_*` only ever creates, so honouring the request would have minted a
  // second study and repointed the row at it. That refusal is gone: the study
  // build below now rewrites the linked study in place when the caller may
  // write it. See updateLinkedStudyContent for why that is conditional and
  // what each of its three outcomes means.
  //
  // What has NOT changed is the refusal to accept an explicit link alongside
  // authored content. Both are still rejected rather than resolved by
  // precedence, which is what create does for the identical body.
  //
  // `!== undefined` rather than a truthiness check, and that distinction is
  // load-bearing: `firsthand_study_id: null` is permitted by the update schema,
  // and `null?.trim()` is undefined, so a truthiness check let
  // `PATCH { inline_study, firsthand_study_id: null }` through - clearing the
  // link in the same breath as authoring content into the study it pointed at,
  // leaving that study rewritten AND unreferenced. The old blanket refusal on
  // the stored link was what covered this; nothing else did.
  if (inlineStudyInput && data.firsthand_study_id !== undefined) {
    throw new ValidationError(
      'Send either firsthand_study_id or inline_study, not both'
    );
  }

  // The survey twin, and it is not optional for the same reasons.
  if (inlineSurveyInput && data.firsthand_study_id !== undefined) {
    throw new ValidationError(
      'Send either firsthand_study_id or inline_survey, not both'
    );
  }

  // Additional validation for published opportunities.
  //
  // Evaluated against the state this request LEAVES BEHIND, not only against a
  // status it sets. Gating on `data.status === 'published'` alone meant that
  // clearing the study on an already-published opportunity sailed through:
  // PATCH { firsthand_study_id: null } left a live unmoderated opportunity with
  // no study, the exact state this guard exists to prevent.
  const willBePublished =
    data.status !== undefined
      ? data.status === 'published'
      : existingOpp.rows[0].status === 'published';

  // ...but only for requests that could CREATE the bad state: ones that
  // publish, change the type, or change what the opportunity points at. An
  // unrelated edit to a row ALREADY in that state stays allowed, or a legacy
  // published row with no study could never have its other fields corrected -
  // which is precisely the remediation the participant-type comment above
  // promises, and reset-demo-data.ts seeds exactly such a row.
  const changesPublishShape =
    data.status !== undefined ||
    data.type !== undefined ||
    data.firsthand_study_id !== undefined ||
    inlineStudyInput !== undefined ||
    inlineSurveyInput !== undefined ||
    data.external_link_optional !== undefined ||
    // Switching delivery mode changes WHICH of the two things is required, so
    // it changes the publish shape as surely as clearing the link does. Without
    // this, `PATCH { delivery_mode: 'native' }` on a published external survey
    // produced a live native survey with no questions - the same hole the type
    // flip above opened, through a different door.
    data.delivery_mode !== undefined;

  const publishGuardApplies = willBePublished && changesPublishShape;

  // Same rule as create, asked of the RESULTING state rather than of the request
  // - gating on the request's own status let `PATCH { type: 'poll' }` against a
  // published opportunity produce a published poll with no link. Every value
  // below is already merged over the stored row above.
  //
  // `publishGuardApplies` stays outside the predicate deliberately. It is not
  // part of "is this publishable"; it is this endpoint's separate decision to
  // leave an unrelated edit to a row ALREADY in the bad state alone.
  if (publishGuardApplies) {
    // Whether this opportunity has a slot a participant could still book, for
    // the moderated-type gate (#118). Counted ONLY for `test`/`interview`, so an
    // ordinary poll/survey publish pays no extra query, and against the
    // participant-actionable predicate `end_time > NOW()` - the same set as
    // `UPCOMING_SESSIONS_ONLY` and the `bookings.ts` booking refusal, NOT a bare
    // `COUNT(*)`. A study whose only slots are in the past is as unbookable as
    // one with none, and publishing it would re-open exactly the a21 defect.
    //
    // `undefined` for every other type: `findPublishProblem` only consults this
    // for moderated types, and passing a signal it will not read would be noise.
    // The wizard persists its temporary slots BEFORE this publishing update
    // (OpportunityForm `handleSubmit`), so by the time control reaches here the
    // author's slots are already rows this query can see.
    let hasBookableSlot: boolean | undefined;
    if (MODERATED_CONSENT_TYPES.has(existingType)) {
      const slotCount = await pool.query(
        'SELECT 1 FROM sessions WHERE opportunity_id = $1 AND end_time > NOW() LIMIT 1',
        [id]
      );
      hasBookableSlot = slotCount.rowCount ? slotCount.rowCount > 0 : false;
    }

    const updatePublishProblem = findPublishProblem({
      willBePublished: true,
      type: existingType,
      deliveryMode: newDeliveryMode,
      hasBookableSlot,
      // Trimmed for the same reason as the create guard: an all-whitespace id
      // would otherwise satisfy this and store NULL.
      hasLinkedStudy: Boolean(newFirstHandStudyId?.trim()),
      hasInlineStudy: Boolean(inlineStudyInput),
      hasInlineSurvey: Boolean(inlineSurveyInput),
      externalLink: newLink,
      // A caller REMOVING the study from a published opportunity is not trying
      // to publish, so telling them to add a prompt "before publishing"
      // describes an action they are not taking.
      removingLinkedStudy: Boolean(
        data.firsthand_study_id !== undefined && existingFirstHandStudyId?.trim()
      )
    });
    if (updatePublishProblem) {
      throw new ValidationError(PUBLISH_PROBLEM_MESSAGES[updatePublishProblem.code]);
    }
  }

  // Same boundary check as create, against the resulting state, so switching a
  // published external survey to native cannot adopt a recorded task list on
  // the way through.
  //
  // Gated on the request actually changing the link or what the link has to be,
  // for the reason the publish guard above states for itself: an unrelated edit
  // to a row already in a bad state must stay allowed, or the row can never be
  // repaired. Unconditionally, this refused `PATCH { title }`, refused
  // `PATCH { status: 'draft' }` - so the misleading page could not even be
  // taken down - and answered every one of them with a message about question
  // types the caller had not touched. DELETE was the only way out.
  const changesLinkage =
    data.firsthand_study_id !== undefined ||
    data.delivery_mode !== undefined ||
    data.type !== undefined;

  // FIX 5: skipped entirely when this request is authoring inline content.
  //
  // The guards above ("Send either firsthand_study_id or inline_study, not
  // both", and the inline_survey twin) already refuse `data.firsthand_study_id
  // !== undefined` alongside `inlineStudyInput`/`inlineSurveyInput` - INCLUDING
  // an explicit null, which is why they test `!== undefined` rather than
  // truthiness. So by the time control reaches here with inline content
  // present, `data.firsthand_study_id` is guaranteed undefined, and
  // `newFirstHandStudyId` therefore falls back to whatever is ALREADY stored -
  // which this request is not touching.
  //
  // `changesLinkage` does not know that: the form sends `type` on every save,
  // so `changesLinkage` reads true on a request that authors content into an
  // opportunity whose STORED link is dangling (the study behind it was
  // deleted), and this pre-check then resolves that stale id, gets null, and
  // refuses the save with "That task list could not be found" - before
  // `updateLinkedStudyContent` below ever gets to answer 'missing' and mint a
  // repair. That is the one designed repair path for a dangling link
  // (A0/B3's "author a replacement on the form"), and until this guard it was
  // unreachable.
  //
  // Nothing here is lost by skipping: `updateLinkedStudyContent` (recorded
  // task list) and its survey counterpart re-check the vocabulary against the
  // STORED kind themselves, and the early ownership check added just above
  // them (the FIX 1 second finding) still runs there too. Both are the real
  // authorisation and vocabulary boundary for content going into an existing
  // link; this pre-check only exists to catch a NEW `firsthand_study_id` on
  // the request body, which inline content can never carry.
  const authoringInlineContent = Boolean(inlineStudyInput || inlineSurveyInput);

  if (changesLinkage && newFirstHandStudyId?.trim() && !authoringInlineContent) {
    await assertLinkedStudyKindMatches(
      newFirstHandStudyId.trim(),
      existingType,
      newDeliveryMode,
      { userId: req.user!.id, isSuperadmin },
      // Ownership is checked only when THIS request is actually changing what
      // the opportunity points at - not merely on the trigger above, which
      // also fires for `delivery_mode`/`type` changes that leave the id
      // untouched. Without this gate, the read-only save path - resending the
      // SAME not-yours id on every save while editing an unrelated field -
      // would be refused, which is the regression FIX 1 must not cause.
      data.firsthand_study_id !== undefined &&
        data.firsthand_study_id?.trim() !== existingFirstHandStudyId?.trim()
    );
  }
  
  // Build the study before the update, for the same reason as create: the row
  // has to reference an id that already exists. See the create handler for why
  // this cannot share a transaction with the opportunity write.
  //
  // The in-place branch keeps that ordering even though its id already exists,
  // and it is worth being honest about what that costs. An in-place update is
  // NOT compensable - there is no history to restore - so if the opportunity
  // write below fails, the study holds the newly authored content while the
  // opportunity's own fields do not. It leaves no orphan and no dangling
  // reference, which is the failure the compensating `deleteStudyUnchecked`
  // exists to prevent on the mint path, and reversing the order would only
  // move the seam: a study write that failed after the opportunity write is
  // the same partial save wearing the other hat.
  //
  // In the ordinary case the author simply saves again. In ONE case they
  // cannot, and it is worth naming rather than glossing: if the opportunity
  // was deleted between the ownership check and the write, the response is a
  // 404 and there is nothing left to retry against, while the study has
  // already been rewritten. Nothing in the 404 hints that a write landed, so
  // the seam is logged where it happens.
  let createdStudyId: string | null = null;
  // Set when the linked study was rewritten and no column on `opportunities`
  // changed. Read once, below, where an otherwise-empty update would answer
  // "No fields to update" for a request that in fact saved everything it
  // carried.
  let updatedStudyInPlace = false;
  /**
   * The linked study's `updated_at` as it stands AFTER this request, returned
   * to the caller so a client saving repeatedly can advance its own
   * concurrency precondition without re-reading the study.
   *
   * Set on both paths that leave a study written: an in-place rewrite, and a
   * fresh mint. Null when this request wrote no study at all, which is the
   * honest answer for a save that carried no authored content - the caller
   * must keep whatever precondition it already held rather than treating
   * silence as "no study".
   */
  let linkedStudyUpdatedAt: string | null = null;

  const linkedStudyId = existingFirstHandStudyId?.trim() || null;
  const studyRequesterForThisWrite: StudyRequester = {
    userId: req.user!.id,
    isSuperadmin: req.user!.role === 'superadmin'
  };

  /**
   * An in-place write reaches EVERY opportunity linked to the study, not just
   * this one.
   *
   * `firsthand_study_id` is a bare TEXT column with no unique constraint, and
   * many opportunities to one study is a designed feature - see the repoint
   * comment further down. So the owner of a shared study, editing it here,
   * would change what a colleague's live opportunity serves to its
   * participants: their consent copy, and the target_url of every task, under
   * recording. Their opportunity row is untouched and they are not told.
   *
   * Ownership is not the question. The author may well own the study, and
   * `PUT /api/firsthand/studies/:studyId` already lets them edit it. The
   * question is what this SURFACE implies: an author editing an opportunity
   * reasonably believes the change is scoped to that opportunity, and here it
   * is not. So the refusal is about the affordance, and it points at the
   * editor where the sharing is visible.
   *
   * Only the fan-out is refused, never a study this opportunity alone uses.
   *
   * B3 replaces the reuse picker with copy-on-select, so the picker itself can
   * no longer CREATE a new sharing relationship - a copy is a new, unshared
   * study from the moment it is minted. This guard is deliberately RETAINED
   * anyway, as defence in depth: it costs one query, it is the last check
   * standing between an in-place rewrite and another opportunity's content for
   * any row a future code path or a hand-edited link manages to share again,
   * and an unreachable guard is a much cheaper mistake than a missing one.
   * Migration 0012 converts every row that already shared a study at deploy
   * time, so in steady state this branch is not expected to fire - but it
   * stays live rather than becoming wrong.
   */
  const studyIsSharedWithAnotherOpportunity = async (studyId: string) => {
    const others = await pool.query(
      'SELECT 1 FROM opportunities WHERE firsthand_study_id = $1 AND id <> $2 LIMIT 1',
      [studyId, id]
    );

    return (others.rowCount ?? 0) > 0;
  };

  if (inlineStudyInput) {
    if (!isStudiesPersistenceConfigured()) {
      throw new AppError('Task lists require a configured PostgreSQL database.', 503);
    }

    if (linkedStudyId && (await studyIsSharedWithAnotherOpportunity(linkedStudyId))) {
      throw new ValidationError(
        'This task list is also used by another study, so editing it here would change what that study serves its participants. Edit it in the Task Lists area, where everything using it is visible'
      );
    }

    if (linkedStudyId) {
      const outcome = await updateLinkedStudyContent(
        linkedStudyId,
        'recorded',
        {
          consent_text: inlineStudyInput.consent_text.trim(),
          consent_template_id: inlineStudyInput.consent_template_id ?? null,
          consent_template_version: inlineStudyInput.consent_template_version ?? null,
          // Omitted rather than resolved when the request did not carry one.
          // resolveStudyDuration(undefined) is null, and updateStudy skips a
          // key that is absent - so without this, a save that says nothing
          // about duration erases an estimate set by hand in StudyEditor. The
          // same reason title and intro_text are not written here at all.
          ...(inlineStudyInput.estimated_duration_minutes !== undefined
            ? {
                estimated_duration_minutes: resolveStudyDuration(
                  inlineStudyInput.estimated_duration_minutes
                )
              }
            : {}),
          steps: toStudySteps(
            inlineStudyInput.steps,
            linkedStudyId,
            inlineStudyInput.target_url
          )
        },
        studyRequesterForThisWrite,
        expectedStudyUpdatedAt,
        stepKeysAreComplete(inlineStudyInput.steps)
      );

      if (outcome.outcome === 'forbidden') {
        // The security event, logged here for the same reason the study route
        // logs its own: a ForbiddenError reaches errorHandler, which records
        // the URL and the user but NOT the study id, and cannot be told apart
        // from any other 403 on this route. Without this line, an admin
        // probing which colleagues' studies are linked to opportunities they
        // own generates no distinguishable signal.
        logger.warn('Refused a cross-owner study write', {
          studyId: linkedStudyId,
          userId: req.user!.id,
          via: 'opportunity-form'
        });

        throw new ForbiddenError(
          'This task list belongs to another researcher; only its owner or a superadmin can edit it'
        );
      }

      if (outcome.outcome === 'stale') {
        return sendStaleStudyConflict(
          res,
          linkedStudyId,
          req.user!.id,
          'this task list',
          outcome.currentUpdatedAt
        );
      }

      if (outcome.outcome === 'updated') {
        updatedStudyInPlace = true;
        linkedStudyUpdatedAt = outcome.updatedAt;
      }
      if (outcome.outcome === 'missing') {
        // Falls through to the mint below, which repoints the dangling link at
        // a study that exists. Logged for the same reason as an explicit
        // repoint: the dangling id is the only clue to which study went
        // missing, and it is gone the moment the UPDATE lands.
        logger.warn('Opportunity linked a study that no longer exists; authoring a replacement', {
          opportunityId: id,
          missingStudyId: linkedStudyId,
          userId: req.user!.id
        });
      }
    }

    if (!updatedStudyInPlace) {
      const studyId = `study_${crypto.randomUUID()}`;
      const stored = await createStudy({
        id: studyId,
        // `||` rather than `??`: a row stored before the schema trimmed these
        // fields can hold '', which `??` would happily propagate into a study
        // whose session payload then fails to assemble.
        title: (data.title || existingOpp.rows[0].title || 'Untitled study').trim(),
        intro_text: (
          data.purpose_one_liner || existingOpp.rows[0].purpose_one_liner || 'Recorded session'
        ).trim(),
        consent_text: inlineStudyInput.consent_text.trim(),
        consent_template_id: inlineStudyInput.consent_template_id ?? null,
        consent_template_version: inlineStudyInput.consent_template_version ?? null,
        estimated_duration_minutes: resolveStudyDuration(inlineStudyInput.estimated_duration_minutes),
        status: 'launched',
        // The editing user, not the opportunity's owner: a superadmin editing
        // someone else's opportunity is the author of the study they just wrote,
        // and the opportunity owner never saw its consent copy.
        owner_user_id: req.user!.id,
        // Provenance only, from the picker's copy-on-select. See the create
        // route's inline_study branch for why this is explicit.
        copied_from_study_id: inlineStudyInput.copied_from_study_id ?? null,
        steps: toStudySteps(inlineStudyInput.steps, studyId, inlineStudyInput.target_url)
      });
      createdStudyId = stored.study.id;
      linkedStudyUpdatedAt = stored.study.updated_at;
      // Routed through the same field loop as everything else so the id lands in
      // the UPDATE without a second code path.
      data.firsthand_study_id = createdStudyId;
    }
  } else if (inlineSurveyInput) {
    if (!isStudiesPersistenceConfigured()) {
      throw new AppError('Questions require a configured PostgreSQL database.', 503);
    }

    if (linkedStudyId && (await studyIsSharedWithAnotherOpportunity(linkedStudyId))) {
      throw new ValidationError(
        'These questions are also used by another study, so editing them here would change what that study asks its participants. Edit them in the Task Lists area, where everything using them is visible'
      );
    }

    if (linkedStudyId) {
      const outcome = await updateLinkedStudyContent(
        linkedStudyId,
        'survey',
        {
          consent_text: inlineSurveyInput.consent_text.trim(),
          consent_template_id: inlineSurveyInput.consent_template_id ?? null,
          consent_template_version: inlineSurveyInput.consent_template_version ?? null,
          // Omitted rather than resolved when the request did not carry one.
          // resolveStudyDuration(undefined) is null, and updateStudy skips a
          // key that is absent - so without this, a save that says nothing
          // about duration erases an estimate set by hand in StudyEditor. The
          // same reason title and intro_text are not written here at all.
          ...(inlineSurveyInput.estimated_duration_minutes !== undefined
            ? {
                estimated_duration_minutes: resolveStudyDuration(
                  inlineSurveyInput.estimated_duration_minutes
                )
              }
            : {}),
          steps: toSurveySteps(inlineSurveyInput.steps, linkedStudyId)
        },
        studyRequesterForThisWrite,
        expectedStudyUpdatedAt,
        stepKeysAreComplete(inlineSurveyInput.steps)
      );

      if (outcome.outcome === 'forbidden') {
        // The security event, logged here for the same reason the study route
        // logs its own: a ForbiddenError reaches errorHandler, which records
        // the URL and the user but NOT the study id, and cannot be told apart
        // from any other 403 on this route. Without this line, an admin
        // probing which colleagues' studies are linked to opportunities they
        // own generates no distinguishable signal.
        logger.warn('Refused a cross-owner study write', {
          studyId: linkedStudyId,
          userId: req.user!.id,
          via: 'opportunity-form'
        });

        throw new ForbiddenError(
          'These questions belong to another researcher; only their owner or a superadmin can edit them'
        );
      }

      if (outcome.outcome === 'stale') {
        return sendStaleStudyConflict(
          res,
          linkedStudyId,
          req.user!.id,
          'these questions',
          outcome.currentUpdatedAt
        );
      }

      if (outcome.outcome === 'updated') {
        updatedStudyInPlace = true;
        linkedStudyUpdatedAt = outcome.updatedAt;
      }
    }

    if (!updatedStudyInPlace) {
      const studyId = `study_${crypto.randomUUID()}`;
      const stored = await createStudy({
        // Same `||` reasoning as the task-list branch above: a legacy row can
        // hold '', which `??` would carry into a study whose session payload then
        // fails to assemble.
        id: studyId,
        title: (data.title || existingOpp.rows[0].title || 'Untitled survey').trim(),
        intro_text: (
          data.purpose_one_liner || existingOpp.rows[0].purpose_one_liner || 'Survey'
        ).trim(),
        consent_text: inlineSurveyInput.consent_text.trim(),
        consent_template_id: inlineSurveyInput.consent_template_id ?? null,
        consent_template_version: inlineSurveyInput.consent_template_version ?? null,
        estimated_duration_minutes: resolveStudyDuration(
          inlineSurveyInput.estimated_duration_minutes
        ),
        status: 'launched',
        owner_user_id: req.user!.id,
        kind: 'survey',
        // Provenance only, from the picker's copy-on-select. See the create
        // route's inline_survey branch for why this is explicit.
        copied_from_study_id: inlineSurveyInput.copied_from_study_id ?? null,
        steps: toSurveySteps(inlineSurveyInput.steps, studyId)
      });
      createdStudyId = stored.study.id;
      linkedStudyUpdatedAt = stored.study.updated_at;
      data.firsthand_study_id = createdStudyId;
    }
  }

  // Reached only when this request carries no authored content at all: both
  // guards above refuse an explicit link alongside `inline_*`, so the two are
  // mutually exclusive by the time control gets here.
  if (!inlineStudyInput && !inlineSurveyInput && data.firsthand_study_id !== undefined) {
    // Normalise before the loop, which stores `value.trim()` verbatim and would
    // otherwise write '' where create writes NULL for the same input. Two
    // representations of "no study" is a trap for any later IS NOT NULL query.
    data.firsthand_study_id = data.firsthand_study_id?.trim() || null;

    // Repointing an opportunity leaves the study it used to reference behind.
    // That study is NOT deleted: unlike the mint path's compensating delete,
    // which removes a study nothing ever referenced, this one was deliberately
    // chosen by somebody, may be referenced by other opportunities
    // (`firsthand_study_id` is a bare TEXT column - many opportunities to one
    // study is a designed feature, not an accident), and remains visible and
    // owned in the Task Lists area where its owner can delete it. What it must
    // not be is INVISIBLE, so the previous id is recorded here: without this
    // line the only trace of the link that existed is gone the moment the
    // UPDATE lands.
    if (
      linkedStudyId &&
      data.firsthand_study_id !== linkedStudyId
    ) {
      logger.info('Opportunity repointed away from its previous study', {
        opportunityId: id,
        previousStudyId: linkedStudyId,
        newStudyId: data.firsthand_study_id,
        userId: req.user!.id
      });
    }

    // Same claim-on-link as the create handler, for the same reason: attaching
    // an unowned legacy study to an opportunity is the point at which it
    // starts being served, so it must not still be writable by every admin.
    if (data.firsthand_study_id && isStudiesPersistenceConfigured()) {
      const claimedStudyId = data.firsthand_study_id;
      if (await claimStudyIfUnowned(claimedStudyId, req.user!.id)) {
        logger.info('Unowned study claimed by the opportunity linking it', {
          studyId: claimedStudyId,
          newOwnerUserId: req.user!.id
        });
      }
    }
  }

  // Build dynamic update query
  const updateFields: string[] = [];
  const values: (string | number | Date | null)[] = [];
  let paramCount = 0;

  Object.entries(data).forEach(([key, value]) => {
    if (value !== undefined) {
      // THE SECOND HALF OF THE ALLOW-LIST, AND IT IS NOT BELT-AND-BRACES.
      //
      // The check at the top of this handler vets the REQUEST BODY. This one
      // vets what actually reaches the SET clause, ~660 lines later, and the
      // two are not the same set: this handler MUTATES `data` in between -
      // `data.firsthand_study_id = createdStudyId` at three sites above. Those
      // three are allow-listed, so the entry check was sound today, but only
      // today, and held by nothing except the distance between the two points.
      //
      // A security gate measured that. Adding one line above this loop that
      // writes an injected key into `data` for an ORDINARY body - no hostile
      // input anywhere in the request - survived all 987 tests and rebuilt the
      // entire original vulnerability:
      //
      //   UPDATE opportunities SET title = $1,
      //     purpose_one_liner = (SELECT email FROM users LIMIT 1), ... RETURNING *
      //
      // answering 200 with the address in the response body. A guard at the
      // boundary cannot protect a statement built six hundred lines inside it.
      //
      // The review gate found the same gap from the other side: with only the
      // entry check, narrowing it to `unknownFields.length === Object.keys(body).length`
      // - the shape a well-meaning "do not 400 a mostly-valid save" refactor
      // produces - also survived 987 tests and let a MIXED body through.
      //
      // `data` has the three non-column keys destructured out by this point, so
      // this set is the whole rule here. Raised as the same ValidationError as
      // the entry check so the two cannot answer differently for one cause.
      if (!UPDATABLE_OPPORTUNITY_COLUMNS.has(key)) {
        logger.error('Refused a column outside the allow-list at the update builder', {
          opportunityId: id,
          userId: req.user?.id,
          field: key.slice(0, 64)
        });
        throw new ValidationError('Validation failed', [
          `Only ${[...UPDATABLE_OPPORTUNITY_COLUMNS].join(', ')} may be updated`
        ]);
      }
      paramCount++;
      updateFields.push(`${key} = $${paramCount}`);
      values.push(typeof value === 'string' ? value.trim() : value);
    }
  });
  
  // An in-place study update changes no column on `opportunities`, so a request
  // whose entire content was the authored task list or question set leaves this
  // empty. Refusing it here would answer "No fields to update" for a save that
  // wrote everything it carried - and that is exactly the shape an autosave
  // sends, so it is not a hypothetical body.
  if (updateFields.length === 0 && !updatedStudyInPlace) {
    throw new ValidationError('No fields to update');
  }
  
  paramCount++;
  values.push(id);
  
  // Reading the row back rather than writing it keeps `updated_at` honest: the
  // BEFORE UPDATE trigger would otherwise stamp an opportunity that did not
  // change. Same returned shape either way, so the response below needs no
  // second path.
  const query = updateFields.length > 0
    ? `
    UPDATE opportunities 
    SET ${updateFields.join(', ')}
    WHERE id = $${paramCount}
    RETURNING *
  `
    : `SELECT * FROM opportunities WHERE id = $${paramCount}`;
  
  let result;
  try {
    result = await pool.query(query, values);

    // Zero rows means the opportunity was deleted between the ownership check
    // and this write. Raised inside the try so it takes the compensating
    // delete: otherwise the row access below threw outside it, leaving the
    // study behind.
    if (result.rowCount === 0) {
      throw new NotFoundError('Study');
    }
  } catch (error) {
    if (updatedStudyInPlace) {
      // Not recoverable - see the ordering note above. Logged because the
      // caller's 404 or 500 says nothing about the study write that did land,
      // and this line is the only record that the two halves disagree.
      logger.error('Opportunity write failed after its study was rewritten in place', {
        opportunityId: id,
        studyId: linkedStudyId,
        userId: req.user!.id,
        error: String(error)
      });
    }

    if (createdStudyId) {
      try {
        await deleteStudyUnchecked(createdStudyId);
      } catch (cleanupError) {
        logger.error('Failed to remove inline study after opportunity update failed', {
          studyId: createdStudyId,
          error: String(cleanupError)
        });
      }
    }
    throw error;
  }

  const opportunity = {
    ...result.rows[0],
    created_at: result.rows[0].created_at.toISOString(),
    updated_at: result.rows[0].updated_at.toISOString(),
    start_date: result.rows[0].start_date ? result.rows[0].start_date.toISOString() : null,
    end_date: result.rows[0].end_date ? result.rows[0].end_date.toISOString() : null,
    sessions: [],
    /**
     * The linked study's revision after this write, for the caller's NEXT
     * precondition.
     *
     * OMITTED rather than sent as null when this request wrote no study, and
     * the distinction is the whole reason this is spelled with a conditional
     * spread. A client that reads a present-but-null field as "there is no
     * study" would clear a precondition it should have kept, and the save
     * after that would go through fail-open with nothing anywhere saying the
     * protection had been dropped. Absent means "this request says nothing
     * about the study", which is what a title-only save actually means.
     */
    ...(linkedStudyUpdatedAt ? { linked_study_updated_at: linkedStudyUpdatedAt } : {})
  };

  res.json(opportunity);
}));


// Anonymous, and it touches the FirstHand runtime pool - which is `max: 5` and is the
// same pool serving live participant sessions. Without a limiter, sustained requests to
// a public endpoint can starve recordings already in progress of connections, which is
// the failure mode that loses a session someone has already sat through. Same reasoning
// as healthLimiter; generous, because a participant legitimately reloads a landing page.
const recordedStudyBriefLimiter = rateLimit({
  windowMs: 60 * 1000,
  // Behind two proxy hops `trust proxy: 1` resolves req.ip to the INGRESS, so
  // this is one bucket shared by every external caller - the same reality
  // healthLimiter documents, and why it sits at 600. At 60 a single
  // participant reloading a landing page could 429 everyone else, and the
  // brief failing silently means the task count would vanish platform-wide.
  // Raised to match healthLimiter's ceiling: still a backstop against a
  // runaway loop hammering the 5-connection runtime pool, without being a
  // self-inflicted outage. Per-caller keying needs `trust proxy` to match the
  // real hop count first - getting that wrong makes the limiter
  // header-spoofable, which is worse than a shared bucket.
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' }
});

// GET /api/opportunities/:id/recorded-study-brief - What the participant is agreeing to,
// before they agree to it.
//
// A recorded study begins the moment the CTA is clicked, and until now the landing page
// said nothing the researcher had not typed by hand. This serves what the study itself
// knows, so the page can state it rather than hoping the description mentions it.
//
// It serves COUNTS AND CONSTANTS, NOTHING ELSE. The prompts are withheld on purpose: a
// participant who reads all the tasks up front rehearses the route, and the recording
// captures a performance instead of a first encounter. That is the same reason the
// welcome screen stopped listing them. The handler never loads them at all - see
// countStudyTasks - so a careless spread cannot turn this into a prompt dump.
//
// NO DURATION. Unmoderated has no duration field anywhere in the authoring form, so
// `default_duration_minutes` falls to its column default of 30 for every such study and
// the inline study copies its estimate from that same never-displayed field. Stating
// that number above a consent button would be inventing a figure no researcher chose.
// It comes back when a researcher can actually set one.
//
// Visibility mirrors GET /:id on the database path - non-admins are filtered to
// published - so this cannot expose a draft the detail page would 404. It diverges in
// the no-database branch, where GET /:id serves mock fixtures and this 404s: mock data
// has no linked studies, and a brief without counts is a better failure than a brief
// with invented ones.
//
// `withLiveRoleIfPresent` (#45): the `isAdmin` below is what lets an admin read
// the brief of a DRAFT study, so it reads the live role like its siblings.
router.get('/:id/recorded-study-brief', recordedStudyBriefLimiter, optionalAuth, withLiveRoleIfPresent, publicRuntimeWork, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const isAdmin = isAdminRole(req.user?.role);

  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    throw new NotFoundError('Study');
  }

  let query = `
    SELECT status, type, firsthand_study_id
    FROM opportunities
    WHERE id = $1
  `;
  if (!isAdmin) {
    query += ` AND status = 'published'`;
  }

  const result = await pool.query(query, [id]);
  if (result.rows.length === 0) {
    throw new NotFoundError('Study');
  }

  const { type, firsthand_study_id: studyId } = result.rows[0];

  // `unmoderated` is the only type that records anything. An opportunity authored as
  // unmoderated and later switched to `poll` keeps its firsthand_study_id, and without
  // this guard the API would tell an anonymous caller that a poll records their screen
  // and voice. The frontend gates on type too, but the API is the contract.
  if (type !== 'unmoderated' || !studyId) {
    throw new NotFoundError('Recorded session');
  }

  const taskCount = await countStudyTasks(studyId);
  if (taskCount === null) {
    throw new NotFoundError('Recorded session');
  }

  // Study status is deliberately not checked. A published opportunity linked to a draft
  // study can genuinely be run - createSession does not gate on it either - so refusing
  // the brief would describe less than the participant is about to be given.
  const study = await getStudyById(studyId);

  const brief: RecordedStudyBrief = {
    task_count: taskCount,
    // Null unless a researcher actually chose one. It used to be the
    // opportunity's NOT NULL default of 30 for every study.
    estimated_duration_minutes: resolveStudyDuration(study?.study.estimated_duration_minutes),
    // Constants rather than configurable: every recorded study captures screen and voice,
    // and none of them capture the camera. A participant-facing promise that a researcher
    // could switch off is not a promise.
    records_screen_and_voice: true,
    requires_chromium: true
  };

  res.json(brief);
}));

/**
 * The one place the participant-mint canonicalisation rule is written down.
 *
 * Both mint routes need the same three things from the opportunity row - does
 * it exist, what study does it link, and what is its id AS POSTGRES PARSED IT -
 * and both used to derive them from their own copy of this reasoning. The
 * copies had already drifted: the recorded route carried the full explanation
 * and the survey route carried two bare lines, which is how a rule stops being
 * a rule.
 *
 * THE CANONICAL ID, read back from the row, never the raw path segment.
 * `opportunities.id` is `uuid` and Postgres normalises on parse, so
 * `{97BFE613-4E1F-472C-917E-B90D1C0326B8}` and
 * `97bfe613-4e1f-472c-917e-b90d1c0326b8` both match this WHERE clause - as do
 * several other textual forms, because the parser tolerates braces, case, and
 * hyphens after any group of four digits. The column it ends up in
 * (`firsthand.runtime_sessions.opportunity_id`) is TEXT, chosen so the
 * firsthand schema needs no cross-schema foreign key, and TEXT compares by
 * bytes. Passing the path segment through would let a participant mint a family
 * of distinct keys for one opportunity and drop their own answers out of the
 * researcher's per-opportunity results by writing the URL differently. A route
 * path parameter is caller-supplied; only the parsed row is not.
 *
 * Null rather than a stringified absence: if the row somehow carries no id the
 * session is stored unattributed - refused to everyone but a superadmin -
 * instead of attributed to a literal "undefined" a later gate would compare
 * against and quietly fail.
 *
 * What it deliberately does NOT do is decide whether this opportunity may be
 * minted. The two routes have genuinely different preconditions - one requires
 * `unmoderated`, the other requires a poll or survey AND native delivery - and
 * folding those in would produce one handler whose every branch asks which of
 * two products it is in. That separation is the right one; only the shared
 * mechanics belong here.
 */
async function loadMintableOpportunity(id: string): Promise<{
  canonicalOpportunityId: string | null;
  row: { id: unknown; type: string; status: string; delivery_mode?: string | null; firsthand_study_id: string | null };
} | null> {
  if (!(await isDatabaseAvailable())) {
    return null;
  }

  const result = await pool.query(
    'SELECT id, type, firsthand_study_id, status, delivery_mode FROM opportunities WHERE id = $1',
    [id]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Study');
  }

  const row = result.rows[0];
  const parsedId = row.id;

  return {
    canonicalOpportunityId: parsedId == null ? null : String(parsedId),
    row
  };
}

/**
 * The participant block both mints send to createSession.
 *
 * `external_ref` is canonicalised for the same reason `opportunityId` is. It is
 * a correlation hint rather than an authorisation key, and its only reader
 * (completion-events.ts) writes it into a `uuid` column that normalises again,
 * so nothing is broken today - but keeping the two fields spelled identically
 * is what stops a future reader picking the unnormalised one.
 */
function mintParticipant(
  user: { id: string; name: string; email: string },
  canonicalOpportunityId: string | null,
  requestedId: string
) {
  return {
    participant_id: user.id,
    display_name: user.name,
    email: user.email,
    external_ref: canonicalOpportunityId ?? requestedId
  };
}

// POST /api/opportunities/:id/recorded-study-session - Create a recorded-study session for this opportunity.
// The legacy path /:id/firsthand-handoff is kept as a deprecated-for-removal alias so a cached SPA can
// still POST it after the backend rolls; remove the alias once no client references the old path.
router.post(['/:id/recorded-study-session', '/:id/firsthand-handoff'], requireAuth, participantSessionMintLimiter, participantRuntimeWork, asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { id } = req.params;

  let studyId: string | null = null;
  // See loadMintableOpportunity for why this is the parsed id and not the path
  // segment. Null when the database is unavailable, which leaves the mock-data
  // fallback below unchanged.
  let canonicalOpportunityId: string | null = null;

  const loaded = await loadMintableOpportunity(id);
  if (loaded) {
    // The guard the sibling brief route has carried all along, and this one
    // never did. Without it the route mints a RECORDED session - screen and
    // microphone capture, a consent screen saying so - for any published
    // opportunity that happens to carry a study, whatever its type. That was an
    // oddity while every study was a recorded task list; a native poll or
    // survey linking a study is now the designed state, so it becomes routine.
    // A survey is served by its own route, not this one.
    if (loaded.row.type !== 'unmoderated') {
      throw new NotFoundError('Recorded session');
    }
    if (loaded.row.status !== 'published') {
      return res.status(403).json({ error: 'Study is not published' });
    }
    studyId = loaded.row.firsthand_study_id;
    canonicalOpportunityId = loaded.canonicalOpportunityId;
  }

  if (!studyId) {
    return res.status(400).json({ error: 'Study has no recorded study linked' });
  }

  // Re-checked HERE, not only where the link was made.
  //
  // Checking at link time alone is a time-of-check problem with a wide window:
  // POST /api/firsthand/studies accepts a client-supplied id, so an id that
  // resolved to nothing when it was linked can be filled in afterwards, and a
  // linked study can be deleted and re-created at the same id with a different
  // vocabulary. Both were demonstrated end to end. The moment that actually
  // matters is this one - a participant is about to be shown a consent screen
  // promising screen and microphone capture - so this is where the question is
  // asked again, against the study as it is now.
  if (isStudiesPersistenceConfigured()) {
    const linked = await getStudyById(studyId);

    if (linked && linked.study.kind !== 'recorded') {
      logger.warn('Refused a recorded session on a study that is not a task list', {
        opportunityId: canonicalOpportunityId ?? id,
        studyId,
        kind: linked.study.kind
      });
      throw new NotFoundError('Recorded session');
    }
  }

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const returnUrl = `${frontendUrl}/opportunities/${encodeURIComponent(id)}?completed=1`;
  const participant = mintParticipant(req.user, canonicalOpportunityId, id);

  // Mint the session in-process and return a same-origin Cortex URL. No
  // callback_url: the internalised runtime writes lifecycle events directly to
  // opportunity_session_events (B4), so there is no HMAC callback hop back into
  // Cortex. (The HMAC handoff to the standalone app was removed with the flag.)
  // opportunityId is the id Postgres parsed, never the request body and never
  // the raw path segment: it is the key the per-opportunity results gate
  // authorises against, so it has to be one value per opportunity rather than
  // whichever spelling the caller used. See canonicalOpportunityId above.
  const result = await createSession({
    studyId,
    participant,
    ...(canonicalOpportunityId ? { opportunityId: canonicalOpportunityId } : {}),
    returnUrl
  });

  if (!result.ok) {
    switch (result.error) {
      case 'persistence_not_configured':
        return res.status(503).json({ error: 'Recorded-study sessions are not available' });
      case 'study_not_found':
        return res.status(404).json({ error: 'Linked recorded study not found' });
      case 'study_has_no_steps':
        return res.status(400).json({ error: 'Linked recorded study has no steps' });
      case 'payload_assembly_failed':
        throw new AppError(
          'Failed to assemble the recorded-study session',
          500,
          'SESSION_ASSEMBLY_FAILED'
        );
      default: {
        // Exhaustiveness guard: a new CreateSessionError must be handled here.
        // This branch only runs for a value outside the modelled union, so the
        // raw value is unpredictable and must NOT reach the participant-visible
        // AppError.message (errorHandler serialises it verbatim). Log it
        // server-side and throw a static message instead.
        const unexpected: never = result.error;
        logger.error('Unhandled session-create error', { error: String(unexpected) });
        throw new AppError(
          'Failed to assemble the recorded-study session',
          500,
          'SESSION_ASSEMBLY_FAILED'
        );
      }
    }
  }

  const sessionUrl = `${frontendUrl}/session/${result.session.session_token}`;
  return res.json({ session_url: sessionUrl });
}));

// POST /api/opportunities/:id/survey-session - Create a native survey session.
//
// The survey counterpart of /recorded-study-session, and deliberately a
// separate route rather than a mode of it. That one mints a RECORDED session -
// screen and microphone capture, a consent screen that says so - and its guard
// is `type === 'unmoderated'`. A survey records nothing, so the two have
// different preconditions and answer different failures; sharing a route would
// mean one handler whose every branch asks which of two products it is in.
router.post('/:id/survey-session', requireAuth, participantSessionMintLimiter, participantRuntimeWork, asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { id } = req.params;

  let studyId: string | null = null;
  // See loadMintableOpportunity: the parsed id, never the path segment.
  let canonicalOpportunityId: string | null = null;

  const loaded = await loadMintableOpportunity(id);
  if (loaded) {
    const row = loaded.row;

    // Shape AND kind, not either. `runsNativeSurvey` says the researcher meant
    // this to run in Cortex - and a switch to external delivery leaves the
    // study linked, so its mode half alone would let a stale link run. The
    // study's `kind`, checked below, says the questions are actually written in
    // a vocabulary this runner can draw: a recorded task list on a native
    // survey would render instructions meant to be performed aloud with nothing
    // recording.
    //
    // The type half covers `question` since #78; the route is still named for
    // the survey RUNTIME, which is what all three shapes share, rather than for
    // any one of the types that reach it.
    if (!runsNativeSurvey(row.type, row.delivery_mode)) {
      throw new NotFoundError('Survey');
    }

    if (row.status !== 'published') {
      return res.status(403).json({ error: 'Study is not published' });
    }

    studyId = row.firsthand_study_id;
    canonicalOpportunityId = loaded.canonicalOpportunityId;
  }

  if (!studyId) {
    return res.status(400).json({ error: 'Study has no questions linked' });
  }

  // Re-checked here for the same reason the recorded route re-checks: the
  // studies API takes a client-supplied id, so a study can be planted at a
  // previously dangling id or replaced at the same one long after the link was
  // made. The moment that matters is the one where a participant is about to be
  // shown the questions.
  if (isStudiesPersistenceConfigured()) {
    const linked = await getStudyById(studyId);

    // A missing study is a refusal, not a fall-through: without this the mint
    // continued and createSession answered a less specific error.
    if (!linked) {
      throw new NotFoundError('Survey');
    }

    if (linked.study.kind !== 'survey') {
      logger.warn('Refused a survey session on a study that is a task list', {
        opportunityId: canonicalOpportunityId ?? id,
        studyId,
        kind: linked.study.kind
      });
      throw new NotFoundError('Survey');
    }

    // The study's OWN status, which the opportunity's says nothing about. A
    // published opportunity can link a draft study, and without this its
    // unfinished question wording was served to participants and their answers
    // counted in the results.
    if (linked.study.status !== 'launched') {
      logger.warn('Refused a survey session on a study that is not launched', {
        opportunityId: canonicalOpportunityId ?? id,
        studyId,
        status: linked.study.status
      });
      throw new NotFoundError('Survey');
    }
  }

  /**
   * One session per participant per opportunity.
   *
   * Minting is otherwise a multiplier on the results: every mint is a new
   * runtime_sessions row and the aggregation counts one respondent per session,
   * so pressing Start repeatedly moves a poll's numbers as far as the
   * participant likes, with each fake respondent indistinguishable from a real
   * one. Demonstrated end to end as an ordinary employee before this existed -
   * three extra mints took a rating question from 3 respondents to 6.
   *
   * An unfinished session is RESUMED rather than replaced, so closing the tab
   * and coming back does not lose the answers already given. A finished one is
   * refused outright: re-answering would rewrite the stored responses, and the
   * survey runtime keeps no history of what they were.
   */
  const existing = await findParticipantSessionForOpportunity({
    opportunityId: canonicalOpportunityId ?? id,
    participantId: req.user.id
  });

  if (existing) {
    if (isAnsweredRuntimeStatus(existing.sessionStatus)) {
      return res.status(409).json({ error: 'You have already answered this' });
    }

    return res.json({
      session_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/survey/${existing.token}`
    });
  }

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const returnUrl = `${frontendUrl}/opportunities/${encodeURIComponent(id)}?completed=1`;
  const participant = mintParticipant(req.user, canonicalOpportunityId, id);

  const result = await createSession({
    studyId,
    participant,
    ...(canonicalOpportunityId ? { opportunityId: canonicalOpportunityId } : {}),
    returnUrl
  });

  if (!result.ok) {
    switch (result.error) {
      case 'persistence_not_configured':
        return res.status(503).json({ error: 'Surveys are not available' });
      case 'study_not_found':
        return res.status(404).json({ error: 'Linked questions not found' });
      case 'study_has_no_steps':
        return res.status(400).json({ error: 'This survey has no questions' });
      case 'payload_assembly_failed':
        throw new AppError('Failed to assemble the survey', 500, 'SESSION_ASSEMBLY_FAILED');
      default: {
        // Exhaustiveness guard, and the raw value must NOT reach the
        // participant-visible message: errorHandler serialises it verbatim.
        const unexpected: never = result.error;
        logger.error('Unhandled survey session-create error', { error: String(unexpected) });
        throw new AppError('Failed to assemble the survey', 500, 'SESSION_ASSEMBLY_FAILED');
      }
    }
  }

  return res.json({ session_url: `${frontendUrl}/survey/${result.session.session_token}` });
}));

// GET /api/opportunities/:id/session-events - List FirstHand session events for an opportunity
router.get('/:id/session-events', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const dbAvailable = await isDatabaseAvailable();

  if (!dbAvailable) {
    return res.json([]);
  }

  // Only owner or superadmin can view session events (matches the analytics endpoint;
  // events name participants and link to their session recordings)
  const opportunityResult = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [id]
  );

  if (opportunityResult.rows.length === 0) {
    throw new NotFoundError('Study');
  }

  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOpportunityOwner(opportunityResult.rows[0], req.user)) {
    throw new ForbiddenError('Only the study owner can view session events');
  }

  const result = await pool.query(
    `SELECT
       e.id,
       e.opportunity_id,
       e.participant_user_id,
       e.firsthand_session_id,
       e.event_type,
       e.occurred_at,
       e.payload,
       e.received_at,
       u.name AS participant_name,
       u.email AS participant_email
     FROM opportunity_session_events e
     LEFT JOIN users u ON u.id = e.participant_user_id
     WHERE e.opportunity_id = $1
     ORDER BY e.occurred_at DESC`,
    [id]
  );

  // Reviewers open the recording via the in-Cortex review route
  // (/admin/opportunities/:id/sessions/:sessionId/review); the old cross-origin
  // firsthand_review_url was retired with the HMAC seam.
  res.json(result.rows);
}));

// ─── Native survey results, scoped to the opportunity ────────────────────────
//
// The researcher-facing counterpart to GET /api/firsthand/studies/:id/results,
// which stays superadmin-only. That route aggregates a study across EVERY
// opportunity that used it, and reusing a study you did not author is a
// designed feature - so its owner would be handed answers from participants
// another researcher recruited, under that researcher's consent wording.
//
// An opportunity is the unit a researcher actually owns, so it is the unit
// these read. Gated exactly like /:id/session-events above.

/**
 * BOTH pools, because these routes read across both.
 *
 * The opportunity and its owner come from the main Cortex pool; the questions
 * and the answers come from the FirstHand runtime pool, which is configured
 * separately. Checking only the first meant an unconfigured runtime pool made
 * `getStudyById` answer null, and the route reported "Survey not found" - which
 * tells a researcher their survey does not exist during an outage. The
 * study-wide twin has always answered 503 for the same condition.
 */
async function surveyResultsAreReadable(): Promise<boolean> {
  return (await isDatabaseAvailable()) && isStudiesPersistenceConfigured();
}

/**
 * The three columns the results gate reads, named as a type.
 *
 * `pool.query` without a generic hands back `any`, so before this the row's
 * shape was whatever the reader assumed - including `owner_user_id`, which is
 * NULLABLE and is the whole subject of the guard below.
 *
 * AND IT DOES NOT MAKE THE MISSING-ROW GUARD A COMPILE ERROR, which is what a
 * review gate suggested it would and what the obvious reading of `row:
 * OpportunityOwnerRow | undefined` promises. Measured: with
 * `if (!row) throw` deleted, `tsc -p tsconfig.test.json --noEmit` still exits
 * 0. Control-flow analysis narrows `row` through the `!isSuperadmin && (!row
 * || ...)` guard above and does not put the `undefined` back for the
 * superadmin branch.
 *
 * So the guard is held by a TEST, not by the compiler - `still tells a
 * superadmin the truth about an id that is not there` - and deleting it gives
 * a superadmin a 500 on a missing id, which is a worse oracle than the one
 * this file closes. Written down because a comment claiming a check the build
 * does not have is how the next reader deletes the wrong line.
 */
type OpportunityOwnerRow = {
  id: string;
  /**
   * A SHAPE THE SCHEMA CURRENTLY FORBIDS, guarded anyway.
   *
   * This used to say "NULL for a row whose owner has been removed", and that
   * state cannot arise: `owner_user_id` is `UUID REFERENCES users(id) ON
   * DELETE CASCADE NOT NULL`, so removing the owner deletes the opportunity,
   * and `DELETE /api/admin/admins` demotes to `employee` rather than deleting
   * the user at all. A guard whose stated reason is fictional is a guard the
   * next reader deletes. The real reason is that a future nullable-owner
   * migration must not silently open this read - see the guard below, which
   * refuses unless BOTH sides are present. cto/AdaptaLabs#12 tracks the three
   * sibling routes that do not.
   */
  owner_user_id: string | null;
  firsthand_study_id: string | null;
};

type OpportunityResultsContext = {
  /** The id Postgres parsed, which is what runtime_sessions stores. */
  canonicalOpportunityId: string;
  steps: StudyStep[];
  studyId: string;
  title: string;
};

/**
 * Resolves the opportunity, enforces the gate, and loads the linked questions.
 *
 * Throws rather than writing to `res`, and every caller must await it BEFORE
 * setting a single response header. Express keeps an already-set Content-Type,
 * so a refusal placed after the CSV headers still hands over the file.
 */
async function loadOpportunityResultsContext(
  req: Request
): Promise<OpportunityResultsContext> {
  const { id } = req.params;

  const opportunityResult = await pool.query<OpportunityOwnerRow>(
    'SELECT id, owner_user_id, firsthand_study_id FROM opportunities WHERE id = $1',
    [id]
  );

  const row: OpportunityOwnerRow | undefined = opportunityResult.rows[0];

  // ONE REFUSAL FOR BOTH CASES, and it is deliberately the 403 rather than the
  // 404. Split - `NotFoundError` for a missing row and `ForbiddenError` for
  // somebody else's - the two told a researcher_admin whether an opportunity
  // id they may not read is real. An existence oracle over opportunity ids,
  // differing only in which refusal came back.
  //
  // Collapsed rather than reordered because ownership cannot be evaluated
  // without the row: there is no order that answers before it knows. The study
  // results routes in routes/firsthand.ts close the same oracle the other way,
  // by moving a role-only gate in front of the load - which they can, and this
  // cannot.
  //
  // COLLAPSED ONTO THE 403, NOT THE 404, and the direction is the whole
  // decision. Both close the oracle equally. The 403 also:
  //
  //  - keeps the sentence that is true in the common case. A researcher who
  //    opens a colleague's opportunity is told it is not theirs, rather than
  //    that a thing they can see in the admin table does not exist;
  //  - matches the nine sibling routes over this same id space ON THE CASE
  //    THAT MATTERS. /analytics, /session-events and the write paths all
  //    answer 403 to a non-owner, so the refusal a researcher actually meets
  //    is the same one everywhere. Be precise about the other half, which an
  //    earlier version of this comment was not: for an id that is genuinely
  //    MISSING these two routes now answer 403 where the siblings still
  //    answer 404. That difference IS the collapse doing its job, and it is
  //    also the remaining inconsistency - the siblings still carry the oracle
  //    this closes. cto/AdaptaLabs#10 CLOSED THAT AS WON'T-FIX: the existence
  //    of an opportunity id is metadata, and metadata is not a secret from a
  //    researcher_admin. The trust model that decision rests on, and the two
  //    things that would reopen it, are written down above `GET /studies` in
  //    routes/firsthand.ts. Do not re-argue it from here;
  //  - keeps OpportunityAnalytics.tsx's `status === 403` branch honest. The
  //    404 direction made that branch dead code promising a status the server
  //    could no longer send, on the same page that reads these routes.
  //
  // What it costs: a non-superadmin asking for an id that genuinely is not
  // there is told it is not theirs. A white lie, in the rarer case, and the
  // same direction the firsthand half already takes.
  //
  // A superadmin is unaffected and still gets the accurate 404 below.
  //
  // NEITHER SIDE OF THE COMPARISON MAY BE ABSENT, and `!==` alone does not say
  // so: `undefined !== undefined` is false, so a row carrying no
  // `owner_user_id` key and a session user carrying no `id` would have passed
  // this guard together. Not reachable through Postgres - the column is named
  // in the select list, so an ownerless row arrives as `null` and
  // `null !== undefined` refuses - but `requireAdmin` checks only the role and
  // never the id, so the database's shape is the only thing standing between
  // that pair and a fail-open. Named rather than left to it.
  //
  // THIS WAS THE ONLY GUARDED SITE OF TWENTY-FIVE. It is now the shared
  // `isOpportunityOwner`, which is that guard and nothing else - the absent
  // checks it used to spell out inline moved into the helper unchanged, and
  // are unit-tested there against the exact pairs a bare `===` admits. See
  // utils/opportunityOwnership.ts, which also records why the superadmin
  // bypass stayed OUT of it and remains the line above.
  //
  // REVERTING IT TO THE BARE `!==` SURVIVES THE WHOLE SUITE, and that is
  // correct rather than a coverage gap: no test can produce a row without the
  // key while `pool.query` names it, and no session reaches `requireAdmin`
  // without an id. Recorded as what it is - defence in depth against a shape
  // neither side can currently produce - so nobody later reads the mutant's
  // survival as permission to delete it, or the guard as something tested.
  // What IS tested, by name and with a control, is that this route consults
  // ownership at all.
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOpportunityOwner(row, req.user)) {
    // `found` is the answer the CALLER no longer gets, kept for the operator.
    // Without it this line would fire identically for a probe at a real id and
    // at one that never existed, and the refusal would stop being evidence of
    // anything.
    logger.warn('Refused a survey results read below the opportunity owner', {
      opportunityId: id,
      userId: req.user!.id,
      found: Boolean(row)
    });

    throw new ForbiddenError('Only the study owner can view survey responses');
  }

  if (!row) {
    throw new NotFoundError('Study');
  }

  if (!row.firsthand_study_id) {
    throw new NotFoundError('Survey');
  }

  const stored = await getStudyById(row.firsthand_study_id);
  if (!stored) {
    throw new NotFoundError('Survey');
  }

  // Deliberately NOT gated on delivery_mode or type. Answers already collected
  // natively survive a switch to external delivery, and they are still this
  // researcher's data - refusing would hide it from the only person entitled
  // to it, without unpublishing anything.
  return {
    // String(), not req.params.id: `opportunities.id` is uuid so Postgres
    // matched braces, case and odd hyphens, while `runtime_sessions
    // .opportunity_id` is TEXT and compares bytes. Filtering on the raw path
    // segment would silently return no answers for a URL written any other way.
    canonicalOpportunityId: String(row.id),
    steps: stored.steps,
    studyId: row.firsthand_study_id,
    title: stored.study.title
  };
}

// GET /api/opportunities/:id/survey-results - aggregated answers
router.get('/:id/survey-results', requireAdmin, surveyResultsLimiter, boundResultsRead, asyncHandler(async (req: Request, res: Response) => {
  if (!(await surveyResultsAreReadable())) {
    // Not an empty result set: zero respondents is a finding, and one this
    // route would have no evidence for.
    return res.status(503).json({ error: 'Survey results are not available' });
  }

  const context = await loadOpportunityResultsContext(req);

  const responses = await listResponsesForOpportunity({
    opportunityId: context.canonicalOpportunityId,
    studyId: context.studyId
  });

  const body = {
    title: context.title,
    results: aggregateSurveyResults(context.steps, responses)
  };

  // #85 (residual of #9): the DB read and aggregation are done, and !288 bounded
  // the aggregate body (MAX_AGGREGATE_RESPONSE_CHARS), so hand the global permit
  // back BEFORE the client-paced `res.json` drain - the same lever the .csv twin
  // below took out of the permit. The per-caller slot (held to `close`) bounds
  // concurrent buffered bodies. See releaseResultsReadPermit.
  releaseResultsReadPermit(res);

  return res.json(body);
}));

// GET /api/opportunities/:id/survey-results.csv - raw answers for export
router.get('/:id/survey-results.csv', requireAdmin, surveyResultsLimiter, boundResultsRead, asyncHandler(async (req: Request, res: Response) => {
  if (!(await surveyResultsAreReadable())) {
    return res.status(503).json({ error: 'Survey results are not available' });
  }

  // Everything that can refuse happens here, before the first setHeader below.
  // Express keeps an already-set Content-Type through an error, so a 403
  // written after these headers would still have offered the download.
  const context = await loadOpportunityResultsContext(req);

  // STREAMED, a participant at a time - see the study-wide export in
  // routes/firsthand.ts for why. Everything that can throw is still done BEFORE
  // the first setHeader, not just everything that can refuse: Express keeps an
  // already-set Content-Type through the error handler, so a throw below this
  // line would serve a JSON error object as a file called
  // "<title> responses.csv". `openSurveyCsvExport` is awaited here, rather than
  // its generator being pulled after the headers, for exactly that reason.
  const disposition = toCsvContentDisposition(context.title);
  const csvExport = await openSurveyCsvExport({
    kind: 'opportunity',
    studyId: context.studyId,
    opportunityId: context.canonicalOpportunityId
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', disposition);

  // THE PREFLIGHT-TO-STREAM BOUNDARY - see routes/firsthand.ts and
  // releaseResultsReadPermit for why the permit stops here rather than at
  // `close`.
  releaseResultsReadPermit(res);

  // The FACTORY, uncalled - see routes/firsthand.ts. `writeSurveyCsv` calls it
  // with the signal carrying the export's wall-clock deadline.
  return writeSurveyCsv(res, context.steps, csvExport.removedQuestions, csvExport.participants, {
    studyId: context.studyId
  });
}));

// DELETE /api/opportunities/:id - Delete opportunity
router.delete('/:id', requireAdmin, opportunityWriteLimiter, asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    const { id } = req.params;
    
    // Check if opportunity exists
    const existingOpportunity = getMockOpportunity(id);
    if (!existingOpportunity) {
      throw new NotFoundError('Study');
    }
    
    // Check ownership (superadmins can delete any)
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && !isOpportunityOwner(existingOpportunity, req.user)) {
      throw new ForbiddenError('Only the owner can delete this study');
    }
    
    // Delete the opportunity
    const deleted = deleteMockOpportunity(id);
    if (!deleted) {
      throw new NotFoundError('Study');
    }
    
    return res.status(204).send();
  }
  
  const { id } = req.params;
  
  // Check ownership
  const ownershipCheck = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [id]
  );
  
  if (ownershipCheck.rows.length === 0) {
    throw new NotFoundError('Study');
  }
  
  // Check ownership (superadmins can delete any)
  const isOwner = isOpportunityOwner(ownershipCheck.rows[0], req.user);
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOwner) {
    throw new ForbiddenError('Only the owner can delete this study');
  }
  
  await pool.query('DELETE FROM opportunities WHERE id = $1', [id]);

  res.status(204).send();
}));

// POST /api/opportunities/:id/duplicate - Duplicate opportunity
router.post('/:id/duplicate', requireAdmin, opportunityWriteLimiter, asyncHandler(async (req: Request, res: Response) => {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    const { id } = req.params;

    // Check if opportunity exists
    const existingOpportunity = getMockOpportunity(id);
    if (!existingOpportunity) {
      throw new NotFoundError('Study');
    }

    // Check ownership (superadmins can duplicate any)
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && !isOpportunityOwner(existingOpportunity, req.user)) {
      throw new ForbiddenError('Only the owner can duplicate this study');
    }

    // Create duplicate as draft
    const duplicateOpportunity = {
      id: `mock-${Date.now()}`,
      type: existingOpportunity.type,
      title: `${existingOpportunity.title} (copy)`,
      purpose_one_liner: existingOpportunity.purpose_one_liner,
      description_optional: existingOpportunity.description_optional,
      product_optional: existingOpportunity.product_optional,
      default_duration_minutes: existingOpportunity.default_duration_minutes,
      status: 'draft' as const,
      owner_user_id: req.user!.id,
      external_link_optional: existingOpportunity.external_link_optional,
      participant_type_required: existingOpportunity.participant_type_required,
      participant_type_specific_details: existingOpportunity.participant_type_specific_details,
      // The sixth consent write surface: the db duplicate copies these three,
      // and a mock copy that dropped them would rehearse the exact hole F5
      // closed on the real one.
      consent_text: existingOpportunity.consent_text ?? null,
      consent_template_id: existingOpportunity.consent_template_id ?? null,
      consent_template_version: existingOpportunity.consent_template_version ?? null,
      created_at: new Date(),
      updated_at: new Date(),
      owner_name: req.user!.name,
      owner_email: req.user!.email,
      sessions: []
    };

    addMockOpportunity(duplicateOpportunity);

    return res.status(201).json(duplicateOpportunity);
  }

  const { id } = req.params;

  // Check ownership
  const ownershipCheck = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [id]
  );

  if (ownershipCheck.rows.length === 0) {
    throw new NotFoundError('Study');
  }

  // Check ownership (superadmins can duplicate any)
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOpportunityOwner(ownershipCheck.rows[0], req.user)) {
    throw new ForbiddenError('Only the owner can duplicate this study');
  }

  // Get the original opportunity
  const original = await pool.query('SELECT * FROM opportunities WHERE id = $1', [id]);
  if (original.rows.length === 0) {
    throw new NotFoundError('Study');
  }

  const opp = original.rows[0];

  // Create duplicate as draft
  const query = `
    INSERT INTO opportunities (
      type, title, purpose_one_liner, description_optional,
      product_optional, default_duration_minutes, status,
      owner_user_id, external_link_optional, participant_type_required, participant_type_specific_details,
      consent_text, consent_template_id, consent_template_version
    ) VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11, $12, $13)
    RETURNING *
  `;

  const values = [
    opp.type,
    `${opp.title} (copy)`,
    opp.purpose_one_liner,
    opp.description_optional,
    opp.product_optional,
    opp.default_duration_minutes,
    req.user!.id,
    /*
     * Re-checked rather than copied through. This endpoint cannot introduce a
     * NEW bad value - it only reads a stored one - but a row carrying a link
     * from before the scheme guard existed would otherwise become two of them.
     * Dropped to null instead of refusing the duplicate: the author asked for a
     * copy of an opportunity, not for a lecture about a field they may never
     * have set.
     */
    isPublishableExternalLink(opp.external_link_optional)
      ? opp.external_link_optional
      : null,
    opp.participant_type_required,
    opp.participant_type_specific_details,
    // Moderated consent (#79) is COPIED, not re-derived. Duplicating is how a
    // researcher runs a repeat study; a copy that silently dropped consent
    // would recruit and ingest recordings with no consent text at all - the
    // review gate on this plan found exactly that hole before it shipped. The
    // provenance pair rides along verbatim: the wording is the same wording,
    // so what it resolves to cannot differ.
    opp.consent_text ?? null,
    opp.consent_template_id ?? null,
    opp.consent_template_version ?? null
  ];

  const result = await pool.query(query, values);
  const duplicatedOpportunity = result.rows[0];

  // Add empty sessions array for consistency with frontend
  duplicatedOpportunity.sessions = [];

  res.status(201).json(duplicatedOpportunity);
}));

// POST /api/opportunities/:id/close-if-past - Utility to close opportunity if all sessions are past
router.post('/:id/close-if-past', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { id: opportunityId } = req.params;

  // Check opportunity ownership
  const opportunityCheck = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [opportunityId]
  );

  if (opportunityCheck.rows.length === 0) {
    throw new NotFoundError('Study');
  }

  // Check ownership (superadmins can close any)
  const isOwner = isOpportunityOwner(opportunityCheck.rows[0], req.user);
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOwner) {
    throw new ForbiddenError('Only the owner can close this study');
  }

  await autoCloseOpportunityIfNeeded(opportunityId);

  res.json({ message: 'Study auto-close check completed' });
}));

// GET /api/opportunities/:id/sessions - Get sessions for an opportunity
// `withLiveRoleIfPresent` (#45): the two `isAdmin` reads below decide whether a
// draft opportunity's sessions are served, and whether the joining link is
// stripped. Both now read the live role.
router.get('/:id/sessions', optionalAuth, withLiveRoleIfPresent, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id: opportunityId } = req.params;

    // Above the mock/database split for the same reason as the listing route.
    if (refusedRepeatedParameters(req, res, SINGLE_VALUE_SESSION_FILTERS)) return;

    const from = req.query.from as string | undefined;
    const include_past = req.query.include_past as string | undefined;

    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      // Use mock data for development
      const opportunity = getMockOpportunity(opportunityId);
      if (!opportunity) {
        return res.status(404).json({ error: 'Study not found' });
      }
      
      const isAdmin = isAdminRole(req.user?.role);
      
      // Non-admin users can only see published opportunities
      if (!isAdmin && opportunity.status !== 'published') {
        return res.status(404).json({ error: 'Study not found' });
      }
      
      // Get mock sessions for this opportunity
      const mockSessions = getMockSessions(opportunityId);
      
      // Apply filters similar to database query
      let filteredSessions = mockSessions;
      
      // Filter by start time if provided
      if (from) {
        const fromDate = new Date(from as string);
        filteredSessions = filteredSessions.filter(session => 
          new Date(session.start_time) >= fromDate
        );
      }
      
      // Filter out past sessions unless explicitly requested
      if (include_past !== 'true') {
        const now = new Date();
        filteredSessions = filteredSessions.filter(session => 
          new Date(session.end_time) >= now
        );
      }
      
      // Sort by start time
      filteredSessions.sort((a, b) => 
        new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
      );
      
      return res.json(isAdmin ? filteredSessions : filteredSessions.map(toPublicSession));
    }
    
    // Check if opportunity exists and user has access - LEFT JOIN for demo/session-only owners
    const opportunityCheck = await pool.query(`
      SELECT o.*, u.name as owner_name, u.email as owner_email
      FROM opportunities o
      LEFT JOIN users u ON o.owner_user_id = u.id
      WHERE o.id = $1
    `, [opportunityId]);
    
    if (opportunityCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Study not found' });
    }
    
    const opportunity = opportunityCheck.rows[0];
    const isAdmin = isAdminRole(req.user?.role);
    
    // Non-admin users can only see published opportunities
    if (!isAdmin && opportunity.status !== 'published') {
      return res.status(404).json({ error: 'Study not found' });
    }
    
    // Build query for sessions with dynamic booked_count calculation
    let query = `
      SELECT s.*,
             COALESCE(COUNT(b.id) FILTER (WHERE b.status = 'booked'), 0)::int as actual_booked_count
      FROM sessions s
      LEFT JOIN bookings b ON s.id = b.session_id
      WHERE s.opportunity_id = $1
    `;
    const params: string[] = [opportunityId];
    let paramCount = 1;

    // Filter by start time if provided
    if (from) {
      paramCount++;
      query += ` AND s.start_time >= $${paramCount}`;
      params.push(from);
    }

    // Filter out past sessions unless explicitly requested
    if (include_past !== 'true') {
      query += ` AND s.end_time >= NOW()`;
    }

    query += ` GROUP BY s.id, s.opportunity_id, s.start_time, s.end_time, s.capacity,
               s.location_or_meet_link_optional, s.created_at, s.updated_at, s.booked_count`;
    query += ` ORDER BY s.start_time ASC`;

    const result = await pool.query(query, params);

    // Serialize dates for API response
    const sessions = result.rows.map(session => ({
      ...session,
      booked_count: session.actual_booked_count, // Use calculated value
      remaining: session.capacity - (session.actual_booked_count || 0), // Calculate from actual bookings
      start_time: session.start_time.toISOString(),
      end_time: session.end_time.toISOString(),
      created_at: session.created_at.toISOString(),
      updated_at: session.updated_at.toISOString(),
    }));
    
    // Same strip as the opportunity routes: this endpoint is optionalAuth and
    // returns bare session rows, so without this the joining link goes out to
    // anonymous callers by a different door.
    res.json(isAdmin ? sessions : sessions.map(toPublicSession));
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error fetching sessions', { error });
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
}));

// POST /api/opportunities/:id/sessions - Create sessions for an opportunity
router.post('/:id/sessions', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id: opportunityId } = req.params;
    const sessionsData = req.body;
    
    // Handle both single session and array of sessions
    const sessions = Array.isArray(sessionsData) ? sessionsData : [sessionsData];
    
    if (sessions.length === 0) {
      return res.status(400).json({ error: 'At least one session is required' });
    }

    // #22. Before the O(N^2) overlap scan further down, which is the per-element
    // cost that makes the missing bound matter here. See
    // MAX_TIME_SLOTS_PER_REQUEST for the number and why it refuses.
    if (sessions.length > MAX_TIME_SLOTS_PER_REQUEST) {
      return res.status(400).json({
        error: `At most ${MAX_TIME_SLOTS_PER_REQUEST} sessions may be created in one request`
      });
    }

    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      // Use mock data for development
      const opportunity = getMockOpportunity(opportunityId);
      if (!opportunity) {
        return res.status(404).json({ error: 'Study not found' });
      }
      
      // Check ownership (superadmins can add sessions to any)
      const isSuperadmin = req.user!.role === 'superadmin';
      if (!isSuperadmin && !isOpportunityOwner(opportunity, req.user)) {
        return res.status(403).json({ error: 'Only the owner can add sessions to this study' });
      }
      
      // Validate all sessions
      const validationErrors: string[] = [];
      sessions.forEach((session, index) => {
        const errors = validateNewSessionData(session);
        errors.forEach(error => validationErrors.push(`Session ${index + 1}: ${error}`));
      });
      
      if (validationErrors.length > 0) {
        return res.status(400).json({ error: 'Validation failed', details: validationErrors });
      }
      
      // Create mock sessions
      const createdSessions = addMockSessions(opportunityId, sessions);
      
      return res.status(201).json(createdSessions);
    }
    
    // Check opportunity ownership
    const opportunityCheck = await pool.query(
      'SELECT owner_user_id FROM opportunities WHERE id = $1',
      [opportunityId]
    );
    
    if (opportunityCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Study not found' });
    }
    
    // Check ownership (superadmins can add sessions to any)
    const isOwner = isOpportunityOwner(opportunityCheck.rows[0], req.user);
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && !isOwner) {
      return res.status(403).json({ error: 'Only the owner can add sessions to this study' });
    }
    
    // Validate all sessions
    const validationErrors: string[] = [];
    sessions.forEach((session, index) => {
      const errors = validateNewSessionData(session);
      errors.forEach(error => validationErrors.push(`Session ${index + 1}: ${error}`));
    });
    
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors });
    }
    
    // Check for overlaps within the batch
    for (let i = 0; i < sessions.length; i++) {
      for (let j = i + 1; j < sessions.length; j++) {
        const session1 = sessions[i];
        const session2 = sessions[j];
        const start1 = new Date(session1.start_time);
        const end1 = new Date(session1.end_time);
        const start2 = new Date(session2.start_time);
        const end2 = new Date(session2.end_time);
        
        if ((start1 < end2) && (start2 < end1)) {
          return res.status(409).json({ 
            error: `Sessions ${i + 1} and ${j + 1} overlap in time` 
          });
        }
      }
    }
    
    // Create sessions in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const createdSessions: Session[] = [];
      
      for (const session of sessions) {
        const query = `
          INSERT INTO sessions (
            opportunity_id, start_time, end_time, capacity, 
            location_or_meet_link_optional
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING *, (capacity - booked_count) as remaining
        `;
        
        const values = [
          opportunityId,
          // Store the validated instant, not the raw string - see the same
          // normalisation in routes/sessions.ts (V8 vs Postgres on
          // offset-less strings).
          new Date(session.start_time).toISOString(),
          new Date(session.end_time).toISOString(),
          session.capacity,
          session.location_or_meet_link_optional || null
        ];
        
        const result = await client.query(query, values);
        const createdSession = {
          ...result.rows[0],
          start_time: result.rows[0].start_time.toISOString(),
          end_time: result.rows[0].end_time.toISOString(),
          created_at: result.rows[0].created_at.toISOString(),
          updated_at: result.rows[0].updated_at.toISOString(),
        };
        createdSessions.push(createdSession);
      }
      
      await client.query('COMMIT');
      
      res.status(201).json(createdSessions);
    } catch (error) {
      // Never let a failing ROLLBACK mask the error that caused it. A dropped
      // connection is one of the failures this transaction exists to survive,
      // and it makes the ROLLBACK throw as well - so without the guard the raw
      // connection error replaces the real cause on its way out.
      //
      // WHAT IS AND IS NOT AT STAKE HERE, because it is narrower than it looks
      // and the issue that raised it (#67) overstated this route. The outer
      // catch below flattens everything that is not an AppError to
      // `500 Failed to create sessions`, and nothing in this transaction body
      // throws an AppError - `client.query` raises pg errors. So the STATUS IS
      // 500 EITHER WAY and the response cannot see this bug at all; measured,
      // by reverting this line and watching the named test fail on the logged
      // error while its `.expect(500)` still passed. What the guard preserves
      // is the LOG: `logger.error('Error creating sessions')` gets the
      // constraint violation instead of a bare "Connection terminated
      // unexpectedly" with no SQLSTATE. Diagnostic, not data - the server
      // aborts the transaction itself when the connection dies.
      //
      // The sibling sites in routes/sessions.ts have no outer catch, so there
      // the same one-line fix IS caller-visible (409 rather than 500).
      //
      // Same fix and same reason as routes/sessions.ts:278 (!271).
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error creating sessions', { error });
    res.status(500).json({ error: 'Failed to create sessions' });
  }
}));

// DELETE /api/opportunities/:id/sessions - Delete all sessions for an opportunity
router.delete('/:id/sessions', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id: opportunityId } = req.params;
    
    // Check if database is available
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      // Use mock data for development
      const opportunity = getMockOpportunity(opportunityId);
      if (!opportunity) {
        return res.status(404).json({ error: 'Study not found' });
      }
      
      // Check ownership (superadmins can delete sessions from any)
      const isSuperadmin = req.user!.role === 'superadmin';
      if (!isSuperadmin && !isOpportunityOwner(opportunity, req.user)) {
        return res.status(403).json({ error: 'Only the owner can delete sessions from this study' });
      }
      
      // Get all sessions for this opportunity
      const sessions = getMockSessions(opportunityId);
      
      // Check if any sessions have bookings
      const sessionsWithBookings = sessions.filter(session => session.booked_count > 0);
      if (sessionsWithBookings.length > 0) {
        return res.status(400).json({ 
          error: `Cannot delete sessions with existing bookings. ${sessionsWithBookings.length} session(s) have bookings.` 
        });
      }
      
      // Delete all sessions (this would need to be implemented in mock-data.ts)
      // For now, return success
      return res.json({ 
        message: 'All sessions deleted successfully', 
        deleted_count: sessions.length 
      });
    }
    
    // Check opportunity ownership
    const opportunityCheck = await pool.query(
      'SELECT owner_user_id FROM opportunities WHERE id = $1',
      [opportunityId]
    );
    
    if (opportunityCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Study not found' });
    }
    
    // Check ownership (superadmins can delete sessions from any)
    const isOwner = isOpportunityOwner(opportunityCheck.rows[0], req.user);
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && !isOwner) {
      return res.status(403).json({ error: 'Only the owner can delete sessions from this study' });
    }
    
    // Delete the sessions and their bookings ATOMICALLY, under a row lock.
    //
    // This was three separate pool.query calls on arbitrary pooled connections,
    // with two defects. First, the "any session still booked?" guard and the
    // DELETE were a check-then-act TOCTOU: a booking created in the window
    // between them was silently deleted, defeating the very guard that exists to
    // protect it. Second, a failure between the two DELETEs left the bookings
    // gone but the sessions intact, with no transaction to roll back.
    //
    // Locking the opportunity's sessions FOR UPDATE closes the race: the book
    // handler locks the same session row with FOR UPDATE NOWAIT, so a booking
    // attempt that arrives mid-delete is refused rather than stranded, and a
    // booking already in flight makes this SELECT wait, after which its row
    // appears in the guard below and the delete is refused.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ORDER BY id so this and the sync-booked-counts sweep (which locks every
      // session ORDER BY id) acquire shared rows in the same order and cannot
      // deadlock. cto/AdaptaLabs#34.
      await client.query(
        'SELECT id FROM sessions WHERE opportunity_id = $1 ORDER BY id FOR UPDATE',
        [opportunityId]
      );

      // Check if any sessions have bookings
      const sessionsCheck = await client.query(
        'SELECT s.id FROM sessions s WHERE s.opportunity_id = $1 AND EXISTS (SELECT 1 FROM bookings b WHERE b.session_id = s.id AND b.status = \'booked\')',
        [opportunityId]
      );

      if (sessionsCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Cannot delete sessions with existing bookings. ${sessionsCheck.rows.length} session(s) have bookings.`
        });
      }

      // Delete all bookings first (ON DELETE CASCADE should handle this, but explicit is safer)
      await client.query(
        'DELETE FROM bookings WHERE session_id IN (SELECT id FROM sessions WHERE opportunity_id = $1)',
        [opportunityId]
      );

      // Delete all sessions for this opportunity
      const deleteResult = await client.query(
        'DELETE FROM sessions WHERE opportunity_id = $1',
        [opportunityId]
      );

      await client.query('COMMIT');

      res.json({
        message: 'All sessions deleted successfully',
        deleted_count: deleteResult.rowCount
      });
    } catch (txError) {
      // Guarded for the reason spelled out at the POST handler above: a
      // ROLLBACK that throws on a dead connection would replace txError.
      await client.query('ROLLBACK').catch(() => {});
      throw txError;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error deleting sessions', { error });
    res.status(500).json({ error: 'Failed to delete sessions' });
  }
}));

// POST /api/opportunities/:id/click - Track click for poll/survey
//
// DELIBERATELY NOT CHAINED with `withLiveRoleIfPresent`, unlike the other four
// `optionalAuth` routes in this file (#45). #45's table lists this route with an
// empty "what the inline branch decides" cell and that is accurate: the handler
// reads `req.user?.id` and never `req.user.role`, so there is no admin branch
// for a stale role to reach. Adding the chain would churn the authorisation
// inventory and buy nothing. If a role branch is ever added here, chain it.
router.post('/:id/click', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id: opportunityId } = req.params;

  // Validate click_type at the boundary. 'view' = study details viewed on mount,
  // 'action' = action button clicked. Defaults to 'action' for older clients that
  // don't send it. Persisting this is what keeps views and actions distinct in
  // analytics - previously it was dropped and every row fell back to the column
  // default 'action', so "Study Views" always read 0.
  const rawClickType = req.body?.click_type ?? 'action';
  if (rawClickType !== 'view' && rawClickType !== 'action') {
    throw new ValidationError("click_type must be 'view' or 'action'");
  }
  const clickType: 'view' | 'action' = rawClickType;

  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // In demo mode, just return success
    return res.json({ ok: true });
  }

  // Load opportunity to check type and status
  const opportunityResult = await pool.query(
    'SELECT id, type, status FROM opportunities WHERE id = $1',
    [opportunityId]
  );

  if (opportunityResult.rows.length === 0) {
    throw new NotFoundError('Study');
  }

  const opportunity = opportunityResult.rows[0];

  // Only allow click tracking for poll, survey, or unmoderated types
  if (opportunity.type !== 'poll' && opportunity.type !== 'survey' && opportunity.type !== 'unmoderated') {
    throw new ValidationError('Click tracking is only available for polls, surveys, and unmoderated tests');
  }

  // Only allow tracking for published opportunities
  if (opportunity.status !== 'published') {
    throw new NotFoundError('Study not published');
  }

  // Get user ID if authenticated, otherwise null
  const userId = req.user?.id || null;

  // Get user agent and IP for tracking (privacy-aware)
  const userAgent = req.headers['user-agent'] || null;
  const clientIp = req.ip || req.socket.remoteAddress || null;
  
  // Hash IP address for privacy
  let ipHash = null;
  if (clientIp && process.env.SESSION_SECRET) {
    ipHash = crypto
      .createHash('sha256')
      .update(clientIp + process.env.SESSION_SECRET)
      .digest('hex')
      .substring(0, 32); // Store only first 32 chars
  }

  // First-party per-visitor nonce (#125). The client persists a random id and
  // sends it so anonymous visitors count distinctly at read time, surviving the
  // reverse proxy that collapses every anonymous ip_hash to the ingress address.
  // Not thrown on when malformed (unlike click_type): a bad or absent nonce just
  // degrades to the ip_hash fallback in the COALESCE, so tracking never fails on
  // it. Bounded length + a conservative charset so a hostile client cannot stuff
  // arbitrary bytes into the column; it is an opaque id, never rendered.
  const rawNonce = req.body?.visitor_nonce;
  const visitorNonce =
    typeof rawNonce === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(rawNonce)
      ? rawNonce
      : null;

  // Record the click
  await pool.query(
    `INSERT INTO opportunity_clicks (opportunity_id, user_id, click_type, user_agent, ip_hash, visitor_nonce)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [opportunityId, userId, clickType, userAgent, ipHash, visitorNonce]
  );

  res.json({ ok: true });
}));

const ANALYTICS_WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VALID_ANALYTICS_PERIODS = [7, 14, 30];

/**
 * The third and last query read in this file. The `VALID_ANALYTICS_PERIODS`
 * whitelist below already bounds it, so a repeat was never dangerous here -
 * `parseInt('7,9999')` is 7, which is in the list. It is guarded anyway, and
 * the reason is the same one `parseLimit` gives in routes/gamification.ts: 7 is
 * the answer by a coincidence of comma-joining rather than by any rule, and
 * exempting the one safe read would mean the scan needs an exemption list -
 * more code than the guard, and one more thing to go stale.
 */
const SINGLE_VALUE_ANALYTICS_FILTERS = ['period'] as const;

// GET /api/opportunities/:id/analytics - Get click analytics for admin
router.get('/:id/analytics', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { id: opportunityId } = req.params;

  if (refusedRepeatedParameters(req, res, SINGLE_VALUE_ANALYTICS_FILTERS)) return;

  const requestedPeriod = parseInt(req.query.period as string, 10);
  const period = VALID_ANALYTICS_PERIODS.includes(requestedPeriod) ? requestedPeriod : 30;

  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    return res.json({
      clicks_total: 0,
      clicks_24h: 0,
      clicks_7d: 0,
      unique_users: 0,
      avg_clicks_per_day: 0,
      week_over_week_change: null,
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
      period_clicks_total: 0,
      period_views_total: 0,
      period_actions_total: 0,
      time_zone: ANALYTICS_TIME_ZONE,
      period
    });
  }

  // Check opportunity ownership
  const opportunityResult = await pool.query(
    'SELECT owner_user_id, created_at FROM opportunities WHERE id = $1',
    [opportunityId]
  );

  if (opportunityResult.rows.length === 0) {
    throw new NotFoundError('Study');
  }

  const opportunity = opportunityResult.rows[0];

  // Only owner or superadmin can view analytics
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOpportunityOwner(opportunity, req.user)) {
    throw new ForbiddenError('Only the study owner can view analytics');
  }

  // Snapshot tiles follow the SAME period the charts do (DA-19): the selector
  // used to drive only the charts while these totals stayed all-time, so a
  // "Study Views" of 40 sat above a 30-day chart summing to 6 and the two read
  // as if they measured different things. The period predicate below is cut on
  // CALENDAR DAYS in the analytics zone - the last `period` whole days,
  // matching exactly the days the chart draws (frontend buildAnalyticsChartData
  // + the header sums in OpportunityAnalytics.tsx) - so a tile total equals the
  // sum of the bars beneath it rather than a rolling period*24h window that
  // would reintroduce the boundary-day drift of #124. first_click/last_click
  // stay all-time (they answer "tracking since"), and the 24h/7d sub-metrics
  // keep their own fixed windows.
  //
  // Distinct visitors count by the best identity we hold, not by user_id alone.
  // Click tracking is enabled for published poll/survey/unmoderated studies,
  // which a signed-OUT visitor can reach, and those clicks record user_id NULL
  // (see the INSERT above). COUNT(DISTINCT user_id) drops every NULL, so a study
  // with eight anonymous actions reported "Unique: 0" beside them - a number
  // that read as broken (DA-20). COALESCE to ip_hash, the privacy-hashed
  // per-visitor identity the row already carries, so an anonymous visitor still
  // counts once and "Distinct visitors" means what the card says.
  //
  // Distinct identity is the best one the row holds, in order: the signed-in
  // user_id; else the first-party visitor_nonce (#125), which the client
  // persists and sends so anonymous visitors survive the proxy; else the
  // privacy-hashed ip_hash as a last resort for clients that sent no nonce.
  //
  // It is an estimate, and honestly so on several counts: a visit with none of
  // the three (no nonce, and no client IP or SESSION_SECRET unset) is still
  // uncounted; one person seen signed-in on one visit and signed-out on another
  // counts twice; and a returning anonymous visitor who cleared storage gets a
  // fresh nonce. All beat a flat, misleading 0.
  //
  // ponytail: the residual ceiling is the ip_hash FALLBACK only. ip_hash =
  //   sha256(req.ip + secret), and behind trust proxy:1 with multiple hops
  //   req.ip is the INGRESS, not the visitor (see per-user-rate-limit.ts /
  //   runtime-work-class.ts), so the nonce-less tail still collapses toward one
  //   ip_hash. The visitor_nonce (#125) removes this for any client that sends
  //   one; the fallback covers only no-JS / storage-blocked / pre-#125 clients.
  //
  // ponytail: folding a client-supplied nonce into the distinct namespace makes
  //   this count gameable - an anonymous client can rotate nonces to inflate, or
  //   reuse/forge one to merge buckets. Accepted: it is an admin-only estimate,
  //   and the endpoint already allowed raw-count inflation, so the surface is not
  //   meaningfully wider. -> cto/AdaptaLabs#126 (also tracks the go-live privacy
  //   notice); the cap is per-(opportunity, ip_hash) distinct nonces if it ever
  //   feeds a real decision.
  const overallResult = await pool.query(
    `WITH bounds AS (
      SELECT (date_trunc('day', NOW() AT TIME ZONE $3) - (($2::int - 1) * INTERVAL '1 day'))
             AT TIME ZONE $3 AS period_start
    )
    SELECT
      COUNT(*) FILTER (WHERE clicked_at >= b.period_start)::int AS total,
      COUNT(DISTINCT COALESCE(user_id::text, visitor_nonce, ip_hash))
        FILTER (WHERE clicked_at >= b.period_start)::int AS unique_users,
      COUNT(*) FILTER (WHERE clicked_at >= NOW() - INTERVAL '24 hours')::int AS count_24h,
      COUNT(*) FILTER (WHERE clicked_at >= NOW() - INTERVAL '7 days')::int AS count_7d,
      MIN(clicked_at) AS first_click,
      MAX(clicked_at) AS last_click
     FROM opportunity_clicks, bounds b
     WHERE opportunity_id = $1`,
    [opportunityId, period, ANALYTICS_TIME_ZONE]
  );
  const overall = overallResult.rows[0];

  // Totals split by click_type ('view' = study details viewed, 'action' = link opened / session booked)
  const byTypeResult = await pool.query(
    `WITH bounds AS (
      SELECT (date_trunc('day', NOW() AT TIME ZONE $3) - (($2::int - 1) * INTERVAL '1 day'))
             AT TIME ZONE $3 AS period_start
    )
    SELECT
      click_type,
      -- Totals scoped to the selected period (calendar days, analytics zone);
      -- see the overall query above.
      COUNT(*) FILTER (WHERE clicked_at >= b.period_start)::int AS total,
      -- Distinct visitors by best-held identity (user_id, else visitor_nonce,
      -- else ip_hash; see the overall query above), within the period.
      COUNT(DISTINCT COALESCE(user_id::text, visitor_nonce, ip_hash))
        FILTER (WHERE clicked_at >= b.period_start)::int AS unique_count,
      COUNT(*) FILTER (WHERE clicked_at >= NOW() - INTERVAL '24 hours')::int AS count_24h,
      COUNT(*) FILTER (WHERE clicked_at >= NOW() - INTERVAL '7 days')::int AS count_7d
     FROM opportunity_clicks, bounds b
     WHERE opportunity_id = $1
     GROUP BY click_type`,
    [opportunityId, period, ANALYTICS_TIME_ZONE]
  );
  const viewStats = byTypeResult.rows.find((r: { click_type: string }) => r.click_type === 'view') || {};
  const actionStats = byTypeResult.rows.find((r: { click_type: string }) => r.click_type === 'action') || {};

  // Daily breakdown (views/actions split) over the selected period.
  //
  // Bucketed in the analytics zone, and returned as TEXT. Both halves matter.
  // `DATE(clicked_at)` alone cut the day in the DATABASE session's zone (UTC in
  // every deployment), and node-postgres then handed the result to JS as a Date
  // at LOCAL midnight, which `toISOString().split('T')[0]` read back as the
  // previous day in any positive offset. The endpoint reported clicks on the
  // 15th whose own first_click it reported as the 16th. `to_char` hands back a
  // string, so there is nothing left to reinterpret.
  const dailyResult = await pool.query(
    `SELECT
      to_char(clicked_at AT TIME ZONE $3, 'YYYY-MM-DD') AS date,
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE click_type = 'view')::int AS views,
      COUNT(*) FILTER (WHERE click_type = 'action')::int AS actions
     FROM opportunity_clicks
     WHERE opportunity_id = $1
       AND clicked_at >= NOW() - ($2 * INTERVAL '1 day')
     GROUP BY to_char(clicked_at AT TIME ZONE $3, 'YYYY-MM-DD')
     ORDER BY date ASC`,
    [opportunityId, period, ANALYTICS_TIME_ZONE]
  );
  const clicks_by_day = dailyResult.rows
    .map((row: { date: string | Date; count: number; views: number; actions: number }) => ({
      date: toAnalyticsDateString(row.date),
      count: row.count,
      views: row.views,
      actions: row.actions
    }))
    .filter((day): day is { date: string; count: number; views: number; actions: number } =>
      day.date !== null
    );

  // Hourly breakdown over the selected period
  const hourlyResult = await pool.query(
    `SELECT
      EXTRACT(HOUR FROM clicked_at AT TIME ZONE $3)::int AS hour,
      COUNT(*)::int AS count
     FROM opportunity_clicks
     WHERE opportunity_id = $1
       AND clicked_at >= NOW() - ($2 * INTERVAL '1 day')
     GROUP BY hour
     ORDER BY hour ASC`,
    [opportunityId, period, ANALYTICS_TIME_ZONE]
  );
  const hourCounts = new Map<number, number>(hourlyResult.rows.map((r: { hour: number; count: number }) => [r.hour, r.count]));
  const clicks_by_hour = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: hourCounts.get(hour) || 0
  }));

  // Day-of-week breakdown over the selected period (0 = Sunday, matching Postgres DOW)
  const weekdayResult = await pool.query(
    `SELECT
      EXTRACT(DOW FROM clicked_at AT TIME ZONE $3)::int AS weekday_num,
      COUNT(*)::int AS count
     FROM opportunity_clicks
     WHERE opportunity_id = $1
       AND clicked_at >= NOW() - ($2 * INTERVAL '1 day')
     GROUP BY weekday_num
     ORDER BY weekday_num ASC`,
    [opportunityId, period, ANALYTICS_TIME_ZONE]
  );
  const weekdayCounts = new Map<number, number>(weekdayResult.rows.map((r: { weekday_num: number; count: number }) => [r.weekday_num, r.count]));
  const clicks_by_weekday = ANALYTICS_WEEKDAY_NAMES.map((weekday, weekday_num) => ({
    weekday,
    weekday_num,
    count: weekdayCounts.get(weekday_num) || 0
  }));

  // Previous 7-day window (8-14 days ago), to compute week-over-week change
  const prevWeekResult = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM opportunity_clicks
     WHERE opportunity_id = $1
       AND clicked_at >= NOW() - INTERVAL '14 days'
       AND clicked_at < NOW() - INTERVAL '7 days'`,
    [opportunityId]
  );
  const prevWeekCount = prevWeekResult.rows[0].count;

  // Period-scoped now (DA-19): the tiles these feed follow the selector.
  const clicks_total = overall.total || 0;
  const clicks_7d = overall.count_7d || 0;
  const views_total = viewStats.total || 0;
  const actions_total = actionStats.total || 0;

  const peak_day = clicks_by_day.length > 0
    ? clicks_by_day.reduce((max, day) => (day.count > max.count ? day : max), clicks_by_day[0])
    : null;

  const peakHourEntry = clicks_by_hour.reduce((max, hour) => (hour.count > max.count ? hour : max), clicks_by_hour[0]);
  const peak_hour = peakHourEntry.count > 0
    ? { hour: peakHourEntry.hour, hour_label: `${peakHourEntry.hour}:00`, count: peakHourEntry.count }
    : null;

  const periodClicksTotal = clicks_by_day.reduce((sum, day) => sum + day.count, 0);
  const conversionPercentage = views_total > 0 ? (actions_total / views_total) * 100 : 0;

  res.json({
    clicks_total,
    clicks_24h: overall.count_24h || 0,
    clicks_7d,
    unique_users: overall.unique_users || 0,
    // Averaged over the same calendar-day period the clicks_total tile counts,
    // so "Avg Daily" equals the mean of the bars the combined chart draws.
    avg_clicks_per_day: Math.round((clicks_total / period) * 10) / 10,
    week_over_week_change: weekOverWeekChange(clicks_7d, prevWeekCount),

    views_total,
    views_24h: viewStats.count_24h || 0,
    views_7d: viewStats.count_7d || 0,
    unique_viewers: viewStats.unique_count || 0,

    actions_total,
    actions_24h: actionStats.count_24h || 0,
    actions_7d: actionStats.count_7d || 0,
    unique_actors: actionStats.unique_count || 0,

    conversion_rate: Math.round(conversionPercentage * 10) / 10,

    first_click: overall.first_click ? new Date(overall.first_click).toISOString() : null,
    last_click: overall.last_click ? new Date(overall.last_click).toISOString() : null,
    opportunity_created: new Date(opportunity.created_at).toISOString(),

    peak_day,
    peak_hour,

    // The chart cards used to print a 7-day total beside a 30-day chart. The
    // period totals travel with the period so the header can stop disagreeing
    // with its own title.
    period_clicks_total: periodClicksTotal,
    period_views_total: clicks_by_day.reduce((sum, day) => sum + day.views, 0),
    period_actions_total: clicks_by_day.reduce((sum, day) => sum + day.actions, 0),

    // Days and hours are cut in this zone, not the reader's. Named so the page
    // can say so rather than leaving everyone to assume it is theirs.
    time_zone: ANALYTICS_TIME_ZONE,

    clicks_by_day,
    clicks_by_hour,
    clicks_by_weekday,

    period
  });
}));

export default router;
