/**
 * Whether an opportunity is allowed to be published, and if not, why.
 *
 * The rule lived twice inside `backend/src/routes/opportunities.ts` - once on
 * the create path and once on the update path - and nowhere the client could
 * reach it. C3 adds a Review step that has to tell the author a publish will be
 * refused BEFORE they press the button, and the only honest way to do that is
 * to ask the same function the server asks. A second copy on the client is a
 * copy that can start disagreeing, and the one it disagrees with is the one
 * that decides.
 *
 * In `shared/firsthand/` because both sides import this tree directly, the
 * backend by relative path and the frontend through the `@shared/*` alias.
 * There is one copy of this function and both callers get that copy, so it
 * cannot start disagreeing with itself. It previously lived here because this
 * was the tree a copy script duplicated into the frontend wholesale; that
 * duplication, and the unchecked-copy defect it caused, is gone.
 *
 * Reported as a code rather than a string, per the pattern
 * `findStepVocabularyProblem` sets in `study-input.ts`: the server throws the
 * wording, and the client wants the wording AND the step to send the author to,
 * which is not something a message can carry.
 */

/**
 * Every reason a publish is refused for want of content.
 *
 * `unmoderated_study_removed` is not a fifth rule - it is the same empty-study
 * state as `unmoderated_study_required`, worded for the author who got there by
 * taking the task list AWAY from something already published. Telling them to
 * "add a prompt before publishing" describes an action they are not taking.
 */
export type PublishProblemCode =
  | "unmoderated_study_required"
  | "unmoderated_study_removed"
  | "native_survey_study_required"
  | "external_link_required"
  | "bookable_slot_required";

export interface PublishProblem {
  code: PublishProblemCode;
}

export const PUBLISH_PROBLEM_MESSAGES: Record<PublishProblemCode, string> = {
  unmoderated_study_required:
    "Add at least one prompt to the task list, or link an existing task list, before publishing",
  unmoderated_study_removed:
    "A published unmoderated test cannot have its task list removed; unpublish it first",
  native_survey_study_required:
    "Add questions, or link an existing set of questions, before publishing",
  external_link_required:
    "External link is required for published polls, surveys and one-question studies",
  bookable_slot_required:
    "Add at least one upcoming time slot before publishing a live session or interview"
};

/**
 * Whether a string is a link this product will hand a participant.
 *
 * Moved here from `opportunities.ts`'s private `validateUrl` rather than
 * duplicated: "is the link valid" is half of `external_link_required`, so a
 * client that answers it differently previews a refusal the server will not
 * make, or misses one it will.
 *
 * Protocol only. This is not `isSafeTargetUrl`, which additionally refuses
 * private hosts for a page Cortex will OPEN inside a recorded study; an
 * external hand-off is a link the author is publishing on purpose.
 */
/*
 * `isPublishableExternalLink` and `EXTERNAL_LINK_PROTOCOL_MESSAGE` used to live
 * here and now live in `url-safety.ts`, beside `isSafeTargetUrl`.
 *
 * A security gate asked for the move and its reasoning is worth keeping: this
 * module holds PRODUCT rules about when an opportunity may be published, and
 * `findPublishProblem` below calls that predicate. With both in one file, a
 * decision to relax what counts as an acceptable hand-off would read as a
 * publish-rule change while silently widening two request schemas and a
 * participant-facing render gate.
 */
import {
  isPublishableExternalLink
} from "./url-safety";
import { QUESTION_CARRYING_TYPES, runsNativeSurvey } from "./delivery";
import { MODERATED_CONSENT_TYPES } from "./consent-templates";

/**
 * The RESULTING state of the opportunity, not the request that produced it.
 *
 * Deliberately resolved by the caller. The create path reads its own body; the
 * update path has to merge the body over the stored row first, and gets four of
 * these values from that merge (`existingType`, `newLink`, `newDeliveryMode`,
 * `newFirstHandStudyId`). Taking raw request fields here would mean this
 * function performing that merge twice, differently.
 */
export interface PublishReadinessInput {
  /** Whether the opportunity will be published once this write lands. */
  willBePublished: boolean;
  /** The resulting research study type. */
  type: string;
  /** The resulting delivery mode. Anything but `native` is a hand-off. */
  deliveryMode: string;
  /**
   * Whether a study id will be attached. Callers pass the result of a TRIMMED
   * check: an all-whitespace id stores NULL, so treating it as present is how
   * a published unmoderated test ends up with no task list.
   */
  hasLinkedStudy: boolean;
  /** Whether this write authors a recorded task list inline. */
  hasInlineStudy: boolean;
  /** Whether this write authors survey questions inline. */
  hasInlineSurvey: boolean;
  /** The resulting external link. */
  externalLink?: string | null;
  /**
   * True only when this write is taking a study away from an opportunity that
   * had one. Changes the wording, never the outcome.
   */
  removingLinkedStudy?: boolean;
  /**
   * Whether the opportunity has at least one bookable (upcoming) session slot,
   * for the moderated-type gate below. TRI-STATE on purpose:
   *   - `false`     -> the caller counted zero bookable slots. A moderated
   *                    publish is refused.
   *   - `true`      -> at least one. Permitted.
   *   - `undefined` -> the caller cannot report it. The gate does NOT fire, so a
   *                    caller that never counts (the create route, which writes
   *                    its sessions in a SEPARATE request, and every pre-#118
   *                    caller) is not refused every moderated publish. Only a
   *                    positive report of zero gates. See the branch below.
   */
  hasBookableSlot?: boolean;
}

/**
 * The first reason this opportunity may not be published, or null.
 *
 * One problem at a time, because the shapes are mutually exclusive: an
 * unmoderated test is never also a poll, and a native poll never needs a link.
 */
export const findPublishProblem = (
  input: PublishReadinessInput
): PublishProblem | null => {
  if (!input.willBePublished) {
    return null;
  }

  if (input.type === "unmoderated") {
    if (!input.hasLinkedStudy && !input.hasInlineStudy) {
      return {
        code: input.removingLinkedStudy
          ? "unmoderated_study_removed"
          : "unmoderated_study_required"
      };
    }
    return null;
  }

  // A live session or interview is BOOKED, not handed off: its participant
  // starts by choosing a slot, so a published one with no bookable slot is a
  // study advertised as LIVE / "Book a time" over nothing anyone can book -
  // audit row 15 (a19 Review "Completed", a21 dashboard "Book a time" with
  // nothing bookable).
  //
  // `MODERATED_CONSENT_TYPES` is `{test, interview}` - the same set that decides
  // which bookings carry consent - so "which types are booked" is decided once,
  // not re-listed here.
  //
  // Guarded on `=== false`, NOT `!input.hasBookableSlot`: the signal is
  // tri-state (see the field doc), and `undefined` means the caller could not
  // count. Only a positive report of zero refuses; the create route (sessions
  // are a separate write) and every pre-#118 caller pass no signal and sail
  // through, exactly as before.
  if (MODERATED_CONSENT_TYPES.has(input.type)) {
    return input.hasBookableSlot === false
      ? { code: "bookable_slot_required" }
      : null;
  }

  // Asked about the type AND the mode rather than about `deliveryMode` alone,
  // because a type outside the question-carrying set can hold `native` in a
  // column that defaults per row and is never cleared by a type change.
  //
  // `question` joined that set in #78 and reaches this branch now: a native one
  // needs its question, not a link. Before #78 it fell through to the link
  // check below whatever its mode said, because no runner existed for it.
  if (runsNativeSurvey(input.type, input.deliveryMode)) {
    return input.hasLinkedStudy || input.hasInlineSurvey
      ? null
      : { code: "native_survey_study_required" };
  }

  // Everything that hands the participant to another site needs somewhere to
  // send them.
  //
  // `question` is in this set and was missing from it, which is the whole of
  // the original defect: the gate named three types and `question` was not one,
  // so a one-question study published with an empty link and the author was
  // told nothing. What the participant then met was a disabled "Link
  // unavailable" button - honest, and the wrong place to find out.
  //
  // Reached only by a hand-off, because the native branch above returns for
  // every shape it covers. That ordering is what stops a native question being
  // asked for a link it does not use, and it is the same ordering the client's
  // own preview chain relies on.
  if (QUESTION_CARRYING_TYPES.has(input.type)) {
    if (!isPublishableExternalLink(input.externalLink)) {
      return { code: "external_link_required" };
    }
  }

  return null;
};
