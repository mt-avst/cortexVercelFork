import type { StudyStep } from "../../../shared/firsthand/contract";
import { NPS_SCALE_MAX } from "../../../shared/firsthand/contract";

/**
 * Aggregation for the native survey results view.
 *
 * A pure function over rows already read from the database, so the arithmetic
 * that decides what a researcher concludes is testable without a database and
 * without a route. The denominators are the substance of this module: a
 * percentage taken against the wrong base is not a rounding difference, it is
 * a different finding.
 */

export type StoredResponse = {
  session_id: string;
  step_id: string;
  step_type: string;
  response_payload: Record<string, unknown>;
  saved_at: string;
};

type OptionTally = { option: string; count: number; percent: number };

type BaseResult = {
  step_id: string;
  prompt: string;
  answered: number;
};

export type QuestionResult = BaseResult & {
  type: string;
  /** Choice questions. */
  options?: OptionTally[];
  /**
   * Answers naming an option the study no longer offers, because the author
   * edited the question after launch. Surfaced rather than dropped: without
   * it the tallies stop summing to `answered` and nothing explains the gap.
   */
  retired_options?: { option: string; count: number }[];
  /** Rating and NPS. */
  distribution?: { value: number; count: number }[];
  mean?: number | null;
  promoters?: number;
  passives?: number;
  detractors?: number;
  score?: number | null;
  /** Open text. */
  answers?: { session_id: string; text: string }[];
};

export type SurveyResults = {
  respondents: number;
  questions: QuestionResult[];
};

const QUESTION_TYPES = new Set([
  "open_text",
  "single_choice",
  "multi_choice",
  "rating",
  "nps"
]);

/** One decimal place. Percentages are read, not recomputed from, so rounding
 *  here is presentational and deliberate. */
const round1 = (value: number) => Math.round(value * 10) / 10;

const share = (count: number, total: number) =>
  total === 0 ? 0 : round1((count / total) * 100);

const asText = (payload: Record<string, unknown>) =>
  typeof payload.text === "string" ? payload.text : "";

const asRating = (payload: Record<string, unknown>) =>
  typeof payload.rating === "number" ? payload.rating : undefined;

const asSelections = (payload: Record<string, unknown>, type: string) => {
  if (type === "multi_choice") {
    const selected = payload.selectedOptions;
    // Deduplicated: a payload storing the same option twice is one respondent
    // supporting it once, not two.
    return Array.isArray(selected)
      ? [...new Set(selected.filter((v): v is string => typeof v === "string"))]
      : [];
  }

  return typeof payload.selectedOption === "string"
    ? [payload.selectedOption]
    : [];
};

function tallyChoice(step: StudyStep, rows: StoredResponse[]): QuestionResult {
  const offered = step.options ?? [];
  const counts = new Map(offered.map((option) => [option, 0]));
  const retired = new Map<string, number>();
  let answered = 0;

  for (const row of rows) {
    const selections = asSelections(row.response_payload, step.type);

    if (selections.length === 0) {
      continue;
    }

    answered += 1;

    for (const option of selections) {
      if (counts.has(option)) {
        counts.set(option, (counts.get(option) ?? 0) + 1);
      } else {
        retired.set(option, (retired.get(option) ?? 0) + 1);
      }
    }
  }

  return {
    step_id: step.step_id,
    prompt: step.prompt,
    type: step.type,
    answered,
    // The base is respondents, not selections: on a multi-choice, three people
    // picking two options each is six selections, and a percentage over six
    // reports every option at half its real support.
    options: offered.map((option) => ({
      option,
      count: counts.get(option) ?? 0,
      percent: share(counts.get(option) ?? 0, answered)
    })),
    ...(retired.size > 0
      ? {
          retired_options: [...retired.entries()].map(([option, count]) => ({
            option,
            count
          }))
        }
      : {})
  };
}

function tallyScale(step: StudyStep, rows: StoredResponse[]): QuestionResult {
  const isNps = step.type === "nps";
  const min = isNps ? 0 : 1;
  const max = isNps ? NPS_SCALE_MAX : (step.config?.scale_max ?? 0);

  const counts = new Map<number, number>();
  for (let value = min; value <= max; value += 1) {
    counts.set(value, 0);
  }

  const ratings: number[] = [];

  for (const row of rows) {
    const rating = asRating(row.response_payload);

    if (rating === undefined || !counts.has(rating)) {
      continue;
    }

    ratings.push(rating);
    counts.set(rating, (counts.get(rating) ?? 0) + 1);
  }

  const distribution = [...counts.entries()].map(([value, count]) => ({
    value,
    count
  }));

  const base: QuestionResult = {
    step_id: step.step_id,
    prompt: step.prompt,
    type: step.type,
    answered: ratings.length,
    distribution
  };

  if (!isNps) {
    return {
      ...base,
      // null rather than 0 when nobody answered: a mean of zero is not even on
      // the scale, and it would drag any comparison towards a score nobody
      // gave.
      mean:
        ratings.length === 0
          ? null
          : round1(ratings.reduce((sum, r) => sum + r, 0) / ratings.length)
    };
  }

  // The standard banding, and not negotiable: a moved boundary produces a
  // number that looks plausible and is not comparable with anyone else's NPS.
  const promoters = ratings.filter((r) => r >= 9).length;
  const passives = ratings.filter((r) => r >= 7 && r <= 8).length;
  const detractors = ratings.filter((r) => r <= 6).length;

  return {
    ...base,
    promoters,
    passives,
    detractors,
    score:
      ratings.length === 0
        ? null
        : Math.round(
            (promoters / ratings.length) * 100 -
              (detractors / ratings.length) * 100
          )
  };
}

function listOpenText(step: StudyStep, rows: StoredResponse[]): QuestionResult {
  const answers = rows
    .map((row) => ({
      session_id: row.session_id,
      text: asText(row.response_payload).trim()
    }))
    // A blank answer is not an answer. Listing it puts an empty quote in front
    // of a researcher and inflates the response count.
    .filter((answer) => answer.text.length > 0);

  return {
    step_id: step.step_id,
    prompt: step.prompt,
    type: step.type,
    answered: answers.length,
    answers
  };
}

export function aggregateSurveyResults(
  steps: StudyStep[],
  responses: StoredResponse[]
): SurveyResults {
  const questions = steps.filter((step) => QUESTION_TYPES.has(step.type));

  const byStep = new Map<string, StoredResponse[]>();
  for (const row of responses) {
    byStep.set(row.step_id, [...(byStep.get(row.step_id) ?? []), row]);
  }

  return {
    // Distinct participants, so someone answering six questions is one
    // respondent rather than six.
    respondents: new Set(responses.map((row) => row.session_id)).size,
    questions: questions.map((step) => {
      const rows = byStep.get(step.step_id) ?? [];

      if (step.type === "open_text") {
        return listOpenText(step, rows);
      }

      if (step.type === "rating" || step.type === "nps") {
        return tallyScale(step, rows);
      }

      return tallyChoice(step, rows);
    })
  };
}
