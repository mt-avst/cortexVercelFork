import { z } from "zod";

import { NPS_SCALE_MAX, type StudyStep } from "./contract";

/**
 * A participant's answer to one survey question.
 *
 * Widens the recorded flow's `{ text, selectedOption }` with the two shapes the
 * native survey types need. Stored as-is into
 * `firsthand.participant_responses.response_payload`, which is JSONB, so this
 * schema is the only description of that shape - nothing in the database
 * constrains it.
 *
 * This is the single source of truth for the payload: the backend's
 * `responsePayloadSchema` re-exports it, and the runtime mutation boundary
 * parses it with `.strict()`. A field added on the client and not here is
 * therefore a 422 the first time it is submitted - never a key that zod
 * silently strips and the aggregate quietly reads as "unanswered".
 *
 * Ceilings on a stored answer's free-text fields (cto/AdaptaLabs#155, fix 1 of
 * 2). Before these, every field below was a bare `z.string()` (or an array of
 * them) bounded only by the 100kb request-body limit, so a single crafted
 * answer could carry megabytes of text; the survey CSV export and aggregate
 * results readers then read that per session across a 100-session batch,
 * reaching ~510MB on the single-replica 2Gi runtime pod. Policy numbers,
 * pinned as literals in survey-answers.test.ts - a test that derived its
 * expectation from the constant could not see the constant move.
 *
 * A per-field cap alone is not enough: `selectedOptions` at 500 entries of
 * 1,000 chars each is 500KB, ABOVE the 100kb body limit, so raising a large
 * payload through it - on ANY step type, since nothing stopped an open_text
 * answer from also carrying `selectedOptions` - reopened the same DoS the
 * `text` cap closed. Found by the security-auditor gate on !510. Two
 * independent layers close it:
 *
 *  - these limits now match the authoring ceilings a legitimate
 *    `selectedOption`/`selectedOptions` value can ever reach -
 *    `INLINE_STUDY_LIMITS.maxOptionLength` (500 chars) and
 *    `INLINE_STUDY_LIMITS.maxOptions` (20) - so `selectedOptions` caps at
 *    10KB, under the body limit even alone. Kept as INDEPENDENT literals
 *    rather than importing those constants: this is a participant-answer
 *    security ceiling, not an authoring UX limit, and the two must not
 *    silently drift together if either is retuned for an unrelated reason;
 *  - `findAnswerValidityProblem` below refuses a payload carrying a field
 *    that step type cannot legitimately produce, so `selectedOptions` cannot
 *    be smuggled onto an open_text/rating/nps step to begin with.
 *
 * `text` (10,000 chars) is generous for genuine long-form free text and is
 * unaffected by this - it was never the field being bypassed.
 */
export const MAX_ANSWER_TEXT_LENGTH = 10_000;
export const MAX_ANSWER_OPTION_LENGTH = 500;
export const MAX_ANSWER_OPTIONS_COUNT = 20;

export const surveyAnswerSchema = z.object({
  text: z.string().max(MAX_ANSWER_TEXT_LENGTH).optional(),
  selectedOption: z.string().max(MAX_ANSWER_OPTION_LENGTH).optional(),
  selectedOptions: z
    .array(z.string().max(MAX_ANSWER_OPTION_LENGTH))
    .max(MAX_ANSWER_OPTIONS_COUNT)
    .optional(),
  rating: z.number().int().optional()
});

export type SurveyAnswer = z.infer<typeof surveyAnswerSchema>;

/**
 * Question types that capture an answer. `instruction` and `end` are read, not
 * answered, so they are never required and never count towards progress.
 */
const ANSWERABLE_TYPES = new Set([
  "open_text",
  "single_choice",
  "multi_choice",
  "rating",
  "nps"
]);

export function isAnswerable(step: StudyStep): boolean {
  return ANSWERABLE_TYPES.has(step.type);
}

/**
 * Whether the participant has given anything at all. Drives progress and the
 * save-on-advance decision, not validity.
 */
export function isAnswered(step: StudyStep, answer?: SurveyAnswer): boolean {
  if (!isAnswerable(step) || !answer) {
    return false;
  }

  switch (step.type) {
    case "open_text":
      return Boolean(answer.text?.trim());
    case "single_choice":
      return Boolean(answer.selectedOption);
    case "multi_choice":
      return (answer.selectedOptions?.length ?? 0) > 0;
    case "rating":
    case "nps":
      // Compared against undefined rather than tested for truthiness: zero is a
      // real NPS score, and a truthiness check would silently drop every
      // detractor who answered 0.
      return answer.rating !== undefined;
    default:
      return false;
  }
}

const ratingBounds = (step: StudyStep) =>
  step.type === "nps"
    ? { min: 0, max: NPS_SCALE_MAX }
    : { min: 1, max: step.config?.scale_max ?? 0 };

/**
 * The one field an answerable step type may legitimately carry. Every other
 * `SurveyAnswer` field must be absent - not merely ignored - so a payload
 * cannot relocate a large value onto a step type whose own field cap does not
 * apply to it (cto/AdaptaLabs#155, fix 1 of 2, HIGH from the security-auditor
 * gate on !510: an open_text step accepted `selectedOptions` unchecked, so the
 * 10,000-char `text` cap was sidestepped by carrying the payload there
 * instead, still under the request-body limit).
 */
const ANSWER_FIELD_BY_STEP_TYPE: Readonly<Record<string, keyof SurveyAnswer>> =
  {
    open_text: "text",
    single_choice: "selectedOption",
    multi_choice: "selectedOptions",
    rating: "rating",
    nps: "rating"
  };

const SURVEY_ANSWER_FIELDS = [
  "text",
  "selectedOption",
  "selectedOptions",
  "rating"
] as const satisfies ReadonlyArray<keyof SurveyAnswer>;

/**
 * A validity rule broken by an answer. Reported as a code rather than a
 * message, like `StepShapeProblem`, because the same rule is enforced at two
 * boundaries - the participant UI and the runtime API - and each words its
 * refusal for a different reader.
 *
 * Every one of these states is unreachable through the UI; they arrive only by
 * a tampered request, and each would corrupt the aggregate the results view
 * computes rather than merely inconveniencing the participant. That is why
 * they apply always, required question or not.
 */
export type AnswerValidityProblem =
  | { code: "step_not_answerable" }
  | { code: "field_not_applicable" }
  | { code: "option_not_offered" }
  | { code: "option_repeated" }
  | { code: "too_many_selections"; max: number }
  | { code: "score_off_scale"; min: number; max: number };

export function findAnswerValidityProblem(
  step: StudyStep,
  answer: SurveyAnswer
): AnswerValidityProblem | null {
  if (!isAnswerable(step)) {
    return { code: "step_not_answerable" };
  }

  const allowedField = ANSWER_FIELD_BY_STEP_TYPE[step.type];
  const hasInapplicableField = SURVEY_ANSWER_FIELDS.some(
    (field) => field !== allowedField && answer[field] !== undefined
  );

  if (hasInapplicableField) {
    return { code: "field_not_applicable" };
  }

  const options = step.options ?? [];

  if (step.type === "single_choice" && answer.selectedOption !== undefined) {
    if (!options.includes(answer.selectedOption)) {
      return { code: "option_not_offered" };
    }
  }

  if (step.type === "multi_choice" && answer.selectedOptions) {
    const selected = answer.selectedOptions;

    if (selected.some((option) => !options.includes(option))) {
      return { code: "option_not_offered" };
    }

    if (new Set(selected).size !== selected.length) {
      return { code: "option_repeated" };
    }

    const max = step.config?.max_selections;

    if (max !== undefined && selected.length > max) {
      return { code: "too_many_selections", max };
    }
  }

  if (
    (step.type === "rating" || step.type === "nps") &&
    answer.rating !== undefined
  ) {
    const { min, max } = ratingBounds(step);

    if (
      !Number.isInteger(answer.rating) ||
      answer.rating < min ||
      answer.rating > max
    ) {
      return { code: "score_off_scale", min, max };
    }
  }

  return null;
}

/**
 * A completeness rule broken by an answer. These apply only when the question
 * is required, and only at the moment the participant tries to move on - so
 * they gate the UI, not the API. A partial save of an optional or not-yet-full
 * answer is legitimate, and the server refusing it would strand a participant
 * mid-session.
 */
export type AnswerCompletenessProblem =
  | { code: "unanswered" }
  | { code: "too_few_selections"; min: number };

export function findAnswerCompletenessProblem(
  step: StudyStep,
  answer?: SurveyAnswer
): AnswerCompletenessProblem | null {
  if (!step.is_required || !isAnswerable(step)) {
    return null;
  }

  if (!isAnswered(step, answer)) {
    return { code: "unanswered" };
  }

  if (step.type === "multi_choice") {
    const min = step.config?.min_selections;
    const selected = answer?.selectedOptions ?? [];

    if (min !== undefined && selected.length < min) {
      return { code: "too_few_selections", min };
    }
  }

  return null;
}
