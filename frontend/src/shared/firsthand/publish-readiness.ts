/**
 * AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY
 *
 * Copied from the shared/ directory by frontend/copy-shared-types.js. Nothing
 * runs that script for you: edit the source under shared/, then run
 * `node copy-shared-types.js` from frontend/ and commit the result.
 *
 * Source: See copy-shared-types.js for the source path
 */

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
 * In `shared/firsthand/` rather than a directory of its own because that is the
 * tree `frontend/copy-shared-types.js` copies wholesale and
 * `shared-copies-are-current.test.ts` checks by construction. A new file
 * anywhere else needs two hand-written lists updated, and a shared module whose
 * frontend copy is unchecked is the defect C1 shipped and then fixed.
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
  | "external_link_required";

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
    "External link is required for published polls and surveys"
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
export const isPublishableExternalLink = (
  url: string | null | undefined
): boolean => {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

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

  if (input.type === "poll" || input.type === "survey") {
    // The link is required only where the participant is actually being sent
    // somewhere else. A native poll needs its questions instead.
    if (input.deliveryMode === "native") {
      return input.hasLinkedStudy || input.hasInlineSurvey
        ? null
        : { code: "native_survey_study_required" };
    }
    if (!isPublishableExternalLink(input.externalLink)) {
      return { code: "external_link_required" };
    }
  }

  return null;
};
