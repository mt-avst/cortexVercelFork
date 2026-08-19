import { INLINE_STUDY_LIMITS } from '../../shared/firsthand/inline-study';

/**
 * How long the thing the author has written is likely to take.
 *
 * The duration field was free text with no help, so it was either left empty -
 * and the participant told nothing - or filled with a guess. Neither improves
 * as the question list grows, which is exactly when the guess gets worse.
 *
 * These numbers are a stated model, not a measurement: nothing in the product
 * times a real participant yet, so the estimate is honest about being an
 * estimate and the author can always override it. They are deliberately
 * generous. Telling someone a survey takes four minutes when it takes seven is
 * worse than the reverse, because the first is discovered halfway through.
 */
const SURVEY_SECONDS_BY_TYPE: Record<string, number> = {
  // Read, not answered. Counted anyway - a survey front-loaded with section
  // text still costs the participant the reading.
  instruction: 15,
  open_text: 60,
  single_choice: 20,
  multi_choice: 30,
  rating: 15,
  nps: 15
};

/** Anything not in the table above. Matches the most expensive answer type. */
const SURVEY_SECONDS_FALLBACK = 60;

/** Reading the consent wording and accepting it, before the first question. */
const SURVEY_OVERHEAD_SECONDS = 30;

/**
 * Consent, choosing a screen to share, and opening the page under test.
 * Measurably the slowest part of a recorded session and the part authors
 * forget, because they never do it themselves.
 */
const RECORDED_SETUP_MINUTES = 3;

/** One task, performed aloud while a recording runs. */
const RECORDED_MINUTES_PER_TASK = 2;

const clampToStorable = (minutes: number): number =>
  Math.min(Math.max(minutes, 1), INLINE_STUDY_LIMITS.maxDurationMinutes);

/**
 * Minutes a survey is likely to take, or null when there is nothing to
 * estimate from.
 *
 * Null rather than 1: an empty list has no length, and showing "1 minute"
 * against no questions is a number nobody chose - the failure this whole
 * control exists to stop.
 */
export const estimateSurveyMinutes = (
  questions: readonly { type: string }[]
): number | null => {
  if (questions.length === 0) {
    return null;
  }

  const seconds = questions.reduce(
    (total, question) =>
      total + (SURVEY_SECONDS_BY_TYPE[question.type] ?? SURVEY_SECONDS_FALLBACK),
    SURVEY_OVERHEAD_SECONDS
  );

  return clampToStorable(Math.ceil(seconds / 60));
};

/** Minutes a recorded task list is likely to take, or null when it is empty. */
export const estimateRecordedMinutes = (
  steps: readonly { type: string }[]
): number | null => {
  if (steps.length === 0) {
    return null;
  }

  return clampToStorable(
    RECORDED_SETUP_MINUTES + steps.length * RECORDED_MINUTES_PER_TASK
  );
};
