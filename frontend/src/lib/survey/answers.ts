import type { StudyStep } from "@shared/firsthand/contract";
import type {
  AnswerCompletenessProblem,
  AnswerValidityProblem,
  SurveyAnswer
} from "@shared/firsthand/survey-answers";
import {
  findAnswerCompletenessProblem,
  findAnswerValidityProblem,
  isAnswerable,
  isAnswered
} from "@shared/firsthand/survey-answers";

/**
 * The rules themselves live in shared/firsthand/survey-answers.ts, because the
 * runtime API enforces the same validity rules server-side - a tampered
 * request must not be able to store an answer the UI could never produce.
 * This module keeps the participant-facing wording, which is this boundary's
 * only job.
 */

export type { SurveyAnswer };
export { isAnswerable, isAnswered };

const validityMessage = (problem: AnswerValidityProblem): string => {
  switch (problem.code) {
    case "option_not_offered":
      return "That answer is not one of the options.";
    case "option_repeated":
      return "That answer selects the same option twice.";
    case "too_many_selections":
      return `Choose at most ${problem.max}.`;
    case "score_off_scale":
      return "That score is not on the scale.";
    case "step_not_answerable":
      // Unreachable from the runner: it only renders answer widgets for
      // answerable steps. Worded anyway rather than thrown, so a future
      // caller gets a message, not a crash.
      return "This step does not take an answer.";
  }
};

const completenessMessage = (problem: AnswerCompletenessProblem): string => {
  switch (problem.code) {
    case "unanswered":
      return "Please answer this question before continuing.";
    case "too_few_selections":
      return `Choose at least ${problem.min}.`;
  }
};

/**
 * Returns a message to show the participant, or null when the answer may be
 * submitted.
 *
 * Two classes of rule, and the difference matters:
 *
 * - Validity (an option that is not on the question, a score outside the scale,
 *   the same option twice, more selections than the cap) applies always.
 * - Completeness ("you have not answered this") applies only when the question
 *   is required.
 */
export function validateAnswer(
  step: StudyStep,
  answer?: SurveyAnswer
): string | null {
  if (!isAnswerable(step)) {
    return null;
  }

  const validity = findAnswerValidityProblem(step, answer ?? {});

  if (validity) {
    return validityMessage(validity);
  }

  const completeness = findAnswerCompletenessProblem(step, answer);

  if (completeness) {
    return completenessMessage(completeness);
  }

  return null;
}
