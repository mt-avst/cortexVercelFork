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
  /**
   * WHO answered, as distinct from WHICH RUN the answer was given in.
   *
   * `runtime_sessions.participant_id`, carried through the join so the
   * respondent count can be taken over people rather than over sessions - see
   * `respondentKey` for why those stopped being the same number.
   *
   * Typed nullable although the column is `TEXT NOT NULL` (migration 0001,
   * never relaxed) and every writer sets it from the authenticated
   * `req.user.id`. This is the input type of a pure function over a plain
   * array, not the row type, and the identity fallback the nullability forces
   * a reader to decide is the point - `respondentKey` pins which way an
   * unattributable row errs.
   */
  participant_id: string | null;
  /**
   * NULL once the question this answer was given against has been REMOVED.
   *
   * Deleting a question detaches its answers rather than destroying them
   * (migration 0015, ON DELETE SET NULL): a researcher tidying a form must not
   * silently delete somebody's answer. `step_prompt` is what keeps the row
   * meaningful afterwards, and `removed_questions` below is where it surfaces.
   */
  step_id: string | null;
  /**
   * The prompt as the PARTICIPANT was shown it, recorded beside the answer.
   *
   * Null on any row written before 0015, and on a row whose session step list
   * did not contain the step - so a removed question with no snapshot is
   * reported under a plain label rather than pretending to know its wording.
   */
  step_prompt: string | null;
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
  /**
   * Wordings this question was asked in that are NOT its current wording.
   *
   * F2 lets an author fix a typo on a live survey, which the pre-F2 guard
   * refused outright. That is only safe if it is not silent: without this, a
   * researcher reading "How was support?" would have no way to know that 200
   * of the 300 answers underneath were given against "How was checkout?".
   *
   * Built from `step_prompt`, the wording recorded beside each answer at the
   * moment it was given, so it reports what participants actually saw rather
   * than what an edit history says. Absent when every answer was given against
   * the wording the question carries now, which is the ordinary case.
   */
  asked_as?: { prompt: string; answered: number }[];
};

export type SurveyResults = {
  respondents: number;
  questions: QuestionResult[];
  /**
   * Answers to questions the study no longer has.
   *
   * Reported SEPARATELY rather than mixed into `questions`, because they are a
   * different kind of fact: nobody currently taking this survey is being asked
   * them, so a reader comparing counts down the list would otherwise see a
   * question with a suspiciously low denominator and no explanation. Kept at
   * all because the alternative is that tidying a form quietly destroys
   * research somebody collected - see `retired_options`, which is the same
   * decision one level down.
   *
   * Absent, not empty, when there are none: nothing should render a heading for
   * a section that has no content.
   */
  removed_questions?: QuestionResult[];
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

const tallyOnly = (step: StudyStep, rows: StoredResponse[]): QuestionResult => {
  if (step.type === "open_text") {
    return listOpenText(step, rows);
  }

  if (step.type === "rating" || step.type === "nps") {
    return tallyScale(step, rows);
  }

  return tallyChoice(step, rows);
};

/**
 * The wordings these answers were given against, minus the current one.
 *
 * Counted over ROWS rather than over distinct participants, because the
 * question being answered is a property of the answer: one person who answered
 * before and after a reword contributes to both wordings, and that is the
 * honest report.
 *
 * A null `step_prompt` - a row written before 0015, or one whose step was
 * missing from its session's own step list - is skipped rather than reported as
 * an unknown wording. It says nothing about whether the question was reworded,
 * and inventing a third bucket for "we do not know" would put a claim on the
 * page that the data does not support.
 */
const askedAsFrom = (step: StudyStep, rows: StoredResponse[]) => {
  const counts = new Map<string, number>();

  for (const row of rows) {
    if (row.step_prompt === null || row.step_prompt === step.prompt) {
      continue;
    }

    counts.set(row.step_prompt, (counts.get(row.step_prompt) ?? 0) + 1);
  }

  return [...counts.entries()].map(([prompt, answered]) => ({ prompt, answered }));
};

const tally = (step: StudyStep, rows: StoredResponse[]): QuestionResult => {
  const result = tallyOnly(step, rows);
  const askedAs = askedAsFrom(step, rows);

  return askedAs.length > 0 ? { ...result, asked_as: askedAs } : result;
};

/** Shown for a removed question whose prompt was never snapshotted. */
export const UNKNOWN_REMOVED_PROMPT = "A question that has since been removed";

/**
 * The removed questions a set of detached answers describes.
 *
 * Grouped by the prompt the participants were shown and the type they answered
 * in, because that pair is all the identity a detached answer has left - its
 * step id was nulled when the question was deleted, and the step itself is
 * gone. Two questions that happened to share a prompt AND a type merge into
 * one, which is a real limit and the right trade: the alternative is a section
 * listing the same wording twice with no way to tell the reader which was
 * which.
 *
 * Choice questions are reported with NO offered options, because the study no
 * longer says what was offered. Every selection therefore lands in
 * `retired_options`, which is exactly what it is for and reads correctly: these
 * were the answers, and the question that defined them is gone.
 *
 * A `rating` question needs its scale reconstructed from the answers, and
 * without that it reports NOTHING. `tallyScale` builds its distribution from
 * `config.scale_max` and drops any rating outside it; a synthetic step carries
 * no config, so the range would be empty and every answer would be discarded -
 * a removed question reporting "0 answered" underneath a heading that says
 * people answered it. `nps` needs no such repair: its scale is fixed at 0 to 10
 * by definition, which is the entire reason it is not author-configurable.
 */
const highestRating = (rows: StoredResponse[]): number =>
  rows.reduce((highest, row) => {
    const rating = row.response_payload.rating;

    return typeof rating === "number" && rating > highest ? rating : highest;
  }, 0);

const removedQuestionsFrom = (detached: StoredResponse[]): QuestionResult[] => {
  const groups = new Map<string, { prompt: string; type: string; rows: StoredResponse[] }>();

  for (const row of detached) {
    const prompt = row.step_prompt ?? UNKNOWN_REMOVED_PROMPT;
    const key = `${row.step_type}\u0000${prompt}`;
    const group = groups.get(key) ?? { prompt, type: row.step_type, rows: [] };

    group.rows.push(row);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) =>
    tally(
      {
        // A synthetic step, standing in for one that no longer exists. The id
        // is empty because there is none: `step_id` on the result is what the
        // UI keys on, and inventing a plausible-looking one would be a value a
        // reader could mistake for a real reference.
        step_id: "",
        order: 0,
        type: group.type as StudyStep["type"],
        prompt: group.prompt,
        ...(group.type === "rating"
          ? { config: { scale_max: highestRating(group.rows) } }
          : {})
      },
      group.rows
    )
  );
};

/**
 * The identity one respondent is counted under.
 *
 * `participant_id`, NOT `session_id` (cto/AdaptaLabs#129, MEDIUM-2). Those
 * were the same number for as long as a participant could only ever hold one
 * `runtime_sessions` row per opportunity, which is the reason
 * `findParticipantSessionForOpportunity` exists - before it, three extra mints
 * took a rating question from 3 respondents to 6.
 *
 * They stopped being the same number when that helper narrowed to resuming an
 * IN-FLIGHT session only (LOW-8 of the same ticket). An EXPIRED session is now
 * left behind and a fresh one minted beside it, nothing rewrites
 * `session_payload->session->expires_at` on resume, and the default token is
 * 24 hours - so "answer three questions, come back tomorrow" leaves one person
 * holding two answer-carrying sessions. The response read
 * (`survey-results-repository.ts`) filters on no `session_status`, so both
 * sessions' answers reach this function, and counting sessions reported that
 * one person as two respondents.
 *
 * WHERE THAT WRONG NUMBER WAS ACTUALLY SEEN - written down precisely, because
 * the first version of this docblock said it sat "in the denominator under
 * every percentage on the page" and that is measured false (cto/AdaptaLabs#129,
 * MEDIUM-3 of the review pass). `respondents` is a denominator NOWHERE. Every
 * percentage on the results page divides by the PER-QUESTION `answered` count
 * (`share(..., answered)` in `tallyChoice` above, and the two
 * `point.count / question.answered` expressions in
 * `frontend/src/components/survey/SurveyResults.tsx`), and `respondents` is
 * read in exactly one place in the whole tree: the "N participants" headline
 * in that component's header.
 *
 * So the defect was a headline overstating the turnout, not inflated
 * percentages - and the researcher-visible shape it leaves BEHIND is the
 * mirror image, which is the thing to know when reading this page today: a
 * study can now say "1 participant" above a chart whose own total is 2,
 * because the headline counts people while every question still counts answer
 * rows. That is cto/AdaptaLabs#152, the ponytail at the foot of this block.
 *
 * A row with no `participant_id` falls back to its own `session_id` rather
 * than collapsing every such row into a single respondent. The column is
 * `TEXT NOT NULL` (migration 0001, never relaxed) and every writer sets it
 * from the authenticated `req.user.id`, so the database cannot produce one;
 * the fallback decides which way the pure function errs if one ever arrives.
 * It errs by NOT merging - two unattributable rows from different sessions
 * stay two respondents, exactly the pre-fix behaviour - because merging would
 * invent one respondent out of people who may be different, and a headline
 * that hides real respondents understates the turnout a researcher is about
 * to draw conclusions from. An empty string is treated as absent for the same
 * reason: it identifies nobody.
 *
 * Prefixed, so a `participant_id` equal to some other row's `session_id`
 * cannot collide with it.
 *
 * ponytail: the PER-QUESTION tallies below still count one answer row as one
 *   answer, so the same participant answering the same question in both
 *   sessions counts twice in `answered`, in a choice option's count and in a
 *   scale's mean and NPS. The page can therefore read "1 participant" over a
 *   chart totalling 2.
 *   -> cto/AdaptaLabs#152, reachable whenever a participant lets a 24-hour
 *      token lapse and re-answers a question
 *
 *   The CSV EXPORT DISAGREES WITH THIS PAGE, and the export is deliberately
 *   left alone (same issue). It groups by `session_id` under a column headed
 *   "Participant", so one person holding two sessions is 1 respondent here
 *   and 2 "Participant" rows there. Changing the export's grouping to match
 *   needs the same which-answer-wins rule the tallies need - latest
 *   `saved_at`? the completed session's? - and that is a researcher-facing
 *   decision about what a study's results mean, not a refactor. Both export
 *   sites say so at the grouping itself: `toResponsesCsv` and
 *   `toCsvHeaderRow` in `survey-csv.ts`, and `streamParticipants` in
 *   `survey-results-repository.ts`.
 */
const respondentKey = (row: StoredResponse): string =>
  row.participant_id ? `p:${row.participant_id}` : `s:${row.session_id}`;

export function aggregateSurveyResults(
  steps: StudyStep[],
  responses: StoredResponse[]
): SurveyResults {
  const questions = steps.filter((step) => QUESTION_TYPES.has(step.type));

  const byStep = new Map<string, StoredResponse[]>();
  const detached: StoredResponse[] = [];
  const respondents = new Set<string>();

  for (const row of responses) {
    respondents.add(respondentKey(row));

    if (row.step_id === null) {
      detached.push(row);
      continue;
    }

    // PUSHED into the group, not rebuilt around it. The spread this replaces
    // copied the whole accumulated array on every row, so grouping k answers
    // to one question cost k^2 array writes - two thousand respondents to a
    // hundred-question survey is four hundred million, on the pod that also
    // serves live participants. The array is local to this function and never
    // escapes it, so nothing outside can observe the mutation.
    const group = byStep.get(row.step_id);
    if (group) {
      group.push(row);
    } else {
      byStep.set(row.step_id, [row]);
    }
  }

  const removed = removedQuestionsFrom(
    // Only answerable types. A detached `instruction` step carries no answer to
    // report, and listing it would invent a question nobody was asked.
    detached.filter((row) => QUESTION_TYPES.has(row.step_type))
  );

  return {
    // Distinct PEOPLE (`respondentKey`), so someone answering six questions is
    // one respondent rather than six, and someone who came back after their
    // session token expired is one rather than two. Detached answers COUNT:
    // the person answered,
    // and excluding them would make the denominator move because a researcher
    // edited the form. Collected in the loop above rather than by mapping the
    // whole set again, which allocated a second array of every row.
    respondents: respondents.size,
    questions: questions.map((step) => tally(step, byStep.get(step.step_id) ?? [])),
    ...(removed.length > 0 ? { removed_questions: removed } : {})
  };
}
