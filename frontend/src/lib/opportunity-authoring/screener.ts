import { VALIDATION } from '@shared/constants';
import {
  SCREENER_NEEDS_SCREEN_OUT,
  SCREENER_QUESTION_NEEDS_PASS
} from '@shared/screener';
import type { ScreenerOption, ScreenerQuestion } from '@shared/types';

import { mintClientId, withClientId, type WithClientId } from './client-ids';

/**
 * The authoring-side screener helpers: factories the builder mints new questions
 * and answers with, and the validator the form gates a save on.
 *
 * The validator is deliberately a pure function beside the factories rather than
 * inlined into `computeValidationErrors`, so its rules can be tested against the
 * shared message constants directly. It is the client half of the contract in
 * `shared/screener.ts`: it must refuse exactly what the zod there refuses, in
 * the same words, because a screener the form accepts and the API then rejects
 * would fail with a message the author never saw on any step.
 *
 * The stored `id` on a question and an option is minted here, distinct per item,
 * so a screener built from these seeds can never trip the shared duplicate-id
 * refinements. `_clientId` is the React list key and never leaves the browser -
 * `buildSavePayload` copies only `{ id, prompt, options }` across.
 */

/** The top-level error key: too few / too many questions, or no screen-out. */
export const SCREENER_QUESTIONS_KEY = 'screener_questions';
/** The not-a-match message error key. */
export const SCREENER_MESSAGE_KEY = 'screener_message';

/** A blank answer, flagged qualify or screen-out. */
export const makeScreenerOption = (disqualifies: boolean): ScreenerOption => ({
  id: mintClientId(),
  label: '',
  disqualifies
});

/**
 * A blank question seeded with one qualifying and one screening-out answer.
 *
 * The seed is a VALID SHAPE waiting for wording: one qualify plus one screen-out
 * is the smallest question the shared schema accepts, so an author who fills the
 * labels in has a passing question without having to reason about the flags.
 */
export const makeScreenerQuestion = (): ScreenerQuestion => ({
  id: mintClientId(),
  prompt: '',
  options: [makeScreenerOption(false), makeScreenerOption(true)]
});

/** The list a screener starts as the moment the author turns it on. */
export const emptyScreenerQuestions = (): WithClientId<ScreenerQuestion>[] => [
  withClientId(makeScreenerQuestion())
];

export interface ScreenerValidationInput {
  /** No screener means nothing to validate: the payload sends none. */
  hasScreener: boolean;
  questions: WithClientId<ScreenerQuestion>[];
  message: string;
}

/**
 * The authoring validation errors for the screener step, keyed so the error
 * summary and step router can place each one.
 *
 * Returns `{}` when there is no screener at all - a half-built screener left
 * behind by "Remove screener" must not block a save, because the payload sends
 * nothing for the server to refuse.
 */
export const collectScreenerErrors = ({
  hasScreener,
  questions,
  message
}: ScreenerValidationInput): Record<string, string> => {
  if (!hasScreener) {
    return {};
  }

  const errors: Record<string, string> = {};

  if (questions.length < VALIDATION.SCREENER_MIN_QUESTIONS) {
    errors[SCREENER_QUESTIONS_KEY] = 'Add at least one screener question';
  } else if (questions.length > VALIDATION.SCREENER_MAX_QUESTIONS) {
    errors[SCREENER_QUESTIONS_KEY] =
      `Use at most ${VALIDATION.SCREENER_MAX_QUESTIONS} screener questions`;
  }

  questions.forEach((question, index) => {
    const prompt = question.prompt.trim();
    if (!prompt) {
      errors[`screener_questions.${index}.prompt`] =
        'Enter the question participants see';
    } else if (prompt.length > VALIDATION.SCREENER_MAX_PROMPT_CHARS) {
      errors[`screener_questions.${index}.prompt`] =
        `Shorten this question to ${VALIDATION.SCREENER_MAX_PROMPT_CHARS} characters or fewer`;
    }

    const optionsKey = `screener_questions.${index}.options`;
    const options = question.options;

    if (options.length < VALIDATION.SCREENER_MIN_OPTIONS) {
      errors[optionsKey] =
        `Enter at least ${VALIDATION.SCREENER_MIN_OPTIONS} answers`;
    } else if (options.length > VALIDATION.SCREENER_MAX_OPTIONS) {
      errors[optionsKey] =
        `Use at most ${VALIDATION.SCREENER_MAX_OPTIONS} answers`;
    }

    options.forEach((option, optionIndex) => {
      const label = option.label.trim();
      if (!label) {
        errors[`screener_questions.${index}.options.${optionIndex}.label`] =
          'Enter this answer';
      } else if (label.length > VALIDATION.SCREENER_MAX_OPTION_LABEL_CHARS) {
        errors[`screener_questions.${index}.options.${optionIndex}.label`] =
          `Shorten this answer to ${VALIDATION.SCREENER_MAX_OPTION_LABEL_CHARS} characters or fewer`;
      }
    });

    // The shared refinement, in the shared words: a question every answer to
    // which screens out can never be passed. Only when the count rule above has
    // not already claimed this key, and only once there are enough answers to
    // reason about - an author mid-build has empty flags we should not lecture.
    if (
      !errors[optionsKey] &&
      options.length >= VALIDATION.SCREENER_MIN_OPTIONS &&
      !options.some((option) => !option.disqualifies)
    ) {
      errors[optionsKey] = SCREENER_QUESTION_NEEDS_PASS;
    }
  });

  // The whole-screener refinement, in the shared words: a screener with no
  // screen-out answer filters no-one. Held back until the questions are
  // otherwise sound, so it never stacks on top of a still-empty question - the
  // author has not finished saying who to screen out yet.
  const questionsAreShaped =
    questions.length >= VALIDATION.SCREENER_MIN_QUESTIONS &&
    !Object.keys(errors).some((key) => key.startsWith('screener_questions.'));

  if (
    questionsAreShaped &&
    !errors[SCREENER_QUESTIONS_KEY] &&
    !questions.some((question) =>
      question.options.some((option) => option.disqualifies)
    )
  ) {
    errors[SCREENER_QUESTIONS_KEY] = SCREENER_NEEDS_SCREEN_OUT;
  }

  if (message.trim().length > VALIDATION.SCREENER_MAX_MESSAGE_CHARS) {
    errors[SCREENER_MESSAGE_KEY] =
      `Shorten this message to ${VALIDATION.SCREENER_MAX_MESSAGE_CHARS} characters or fewer`;
  }

  return errors;
};
