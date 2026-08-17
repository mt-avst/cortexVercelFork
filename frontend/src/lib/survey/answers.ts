import {
  NPS_SCALE_MAX,
  type StudyStep
} from "../../shared/firsthand/contract";

/**
 * A participant's answer to one survey question.
 *
 * Widens the recorded flow's `{ text, selectedOption }` with the two shapes the
 * native survey types need. Stored as-is into
 * `firsthand.participant_responses.response_payload`, which is JSONB, so this
 * type is the only description of that shape - nothing in the database
 * constrains it.
 */
export type SurveyAnswer = {
  text?: string;
  selectedOption?: string;
  selectedOptions?: string[];
  rating?: number;
};

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
 * Returns a message to show the participant, or null when the answer may be
 * submitted.
 *
 * Two classes of rule, and the difference matters:
 *
 * - Completeness ("you have not answered this") applies only when the question
 *   is required.
 * - Validity (an option that is not on the question, a score outside the scale,
 *   the same option twice, more selections than the cap) applies always. Those
 *   states are not reachable through the UI, only through a tampered request,
 *   and every one of them would corrupt the aggregate the results view
 *   computes rather than merely inconveniencing the participant.
 */
export function validateAnswer(
  step: StudyStep,
  answer?: SurveyAnswer
): string | null {
  if (!isAnswerable(step)) {
    return null;
  }

  const options = step.options ?? [];

  if (step.type === "single_choice" && answer?.selectedOption !== undefined) {
    if (!options.includes(answer.selectedOption)) {
      return "That answer is not one of the options.";
    }
  }

  if (step.type === "multi_choice" && answer?.selectedOptions) {
    const selected = answer.selectedOptions;

    if (selected.some((option) => !options.includes(option))) {
      return "That answer is not one of the options.";
    }

    if (new Set(selected).size !== selected.length) {
      return "That answer selects the same option twice.";
    }

    const max = step.config?.max_selections;

    if (max !== undefined && selected.length > max) {
      return `Choose at most ${max}.`;
    }
  }

  if (
    (step.type === "rating" || step.type === "nps") &&
    answer?.rating !== undefined
  ) {
    const { min, max } = ratingBounds(step);

    if (
      !Number.isInteger(answer.rating) ||
      answer.rating < min ||
      answer.rating > max
    ) {
      return "That score is not on the scale.";
    }
  }

  if (!step.is_required) {
    return null;
  }

  if (!isAnswered(step, answer)) {
    return "Please answer this question before continuing.";
  }

  if (step.type === "multi_choice") {
    const min = step.config?.min_selections;
    const selected = answer?.selectedOptions ?? [];

    if (min !== undefined && selected.length < min) {
      return `Choose at least ${min}.`;
    }
  }

  return null;
}
