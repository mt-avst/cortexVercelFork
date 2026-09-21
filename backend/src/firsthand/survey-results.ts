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
 * Counted over the answers that WON (`supersededAnswers`), the same set
 * `answered` counts, so the wordings under a question never total more than
 * the question does. A session stores one answer per question, so the only
 * way one person reaches two wordings is by answering again in a second
 * session - and then only their latest answer is on this page, under the
 * wording it was given against (cto/AdaptaLabs#152). The earlier one is still
 * in the CSV, flagged as superseded.
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
 * percentages. Its mirror image - "1 participant" above a chart totalling 2,
 * because the headline counted people while every question counted answer
 * rows - was cto/AdaptaLabs#152, closed by `supersededAnswers` below: the
 * tallies now count one answer per person per question as well.
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
 * Exported because the CSV groups its rows by the same person, and a second
 * copy of the fallback is a second place for the two to disagree.
 */
export const respondentKey = (row: StoredResponse): string =>
  row.participant_id ? `p:${row.participant_id}` : `s:${row.session_id}`;

/**
 * The question an answer was given to, as a key.
 *
 * The step id while the question exists. Once it is removed the step id is
 * NULL and the wording and type are all the identity the answer has left -
 * the same pair `removedQuestionsFrom` above and the CSV's removed columns
 * group on, so an answer superseded here is superseded under the heading it is
 * reported under. Prefixed so the two kinds cannot collide.
 */
const questionKey = (row: StoredResponse): string =>
  row.step_id !== null
    ? `q:${row.step_id}`
    : `r:${row.step_type}\u0000${row.step_prompt ?? UNKNOWN_REMOVED_PROMPT}`;

/**
 * Whether a stored row is an answer the tallies would count, by the same
 * predicates they use: non-blank text, at least one selection, a numeric
 * rating. The rating's RANGE is not checked here - that needs the step's
 * scale, which a removed question no longer has - so an off-scale rating
 * still takes part, and would then be dropped by `tallyScale`. That is the
 * one gap between this and the tallies, and it needs a stored rating outside
 * the question's own scale to reach.
 */
const countsAsAnswer = (row: StoredResponse): boolean => {
  if (!QUESTION_TYPES.has(row.step_type)) {
    return false;
  }

  const payload = row.response_payload ?? {};

  if (row.step_type === "open_text") {
    return asText(payload).trim().length > 0;
  }

  if (row.step_type === "rating" || row.step_type === "nps") {
    return asRating(payload) !== undefined;
  }

  return asSelections(payload, row.step_type).length > 0;
};

/**
 * The answers that LOST: for each person and each question, every answer but
 * the latest (cto/AdaptaLabs#152).
 *
 * One person can hold two answer-carrying sessions - an expired session earns
 * a fresh mint rather than a dead link (cto/AdaptaLabs#129) - and answer the
 * same question in both. The results page counts people in its headline, so
 * it must count one answer per person per question in every tally under it,
 * or it reads "1 participant" above a chart totalling 2. The decision is
 * LATEST WINS: the answer with the greatest `saved_at`, on the reasoning that
 * the most recent thing a person told us is what they think now.
 *
 * A tie on `saved_at` goes to the answer LATER IN THE INPUT. Both readers hand
 * this rows ordered by `(saved_at, id)`, so a tie is broken by `id` - a random
 * uuid, so the choice is arbitrary, but it is DETERMINISTIC and the same
 * whichever reader asked, which is the property that matters: the page and
 * the CSV's flag never disagree about which answer won.
 *
 * `saved_at` is stamped by the server unless an API caller supplies one; the
 * app never does. A caller who backdates can only choose between their OWN
 * answers, so it buys nothing over simply answering again.
 *
 * Returned as the losers rather than the winners because both consumers want
 * the losers: the aggregation SKIPS them, and the CSV keeps every row and
 * FLAGS the sessions holding one. A lost answer is still data - for a small
 * qualitative study, somebody changing their mind is a finding.
 *
 * Only ANSWERS take part - an answerable type carrying something the tallies
 * below would count (`countsAsAnswer`). An `instruction` row is not an answer,
 * so flagging a session for one would mark a row superseded with nothing on
 * it that lost. And a BLANK later row - storable by a client driving the API,
 * which accepts partial saves - must not knock out a real earlier answer:
 * the tallies drop blanks, so letting one win would leave the person counted
 * in the headline with their real answer gone from every chart.
 *
 * Keyed by object identity, so it only means anything for the array it was
 * built from - which is how both callers use it.
 *
 * HAS A TWIN IN SQL. The streamed CSV export reads a hundred sessions at a
 * time, so it decides the same thing in `supersededCsvSessions`
 * (survey-results-repository.ts); change this rule there too.
 * survey-csv-export-postgres.test.ts compares the two byte for byte and goes
 * red if they disagree.
 */
export function supersededAnswers(
  responses: readonly StoredResponse[]
): ReadonlySet<StoredResponse> {
  const latest = new Map<string, StoredResponse>();
  const superseded = new Set<StoredResponse>();

  for (const row of responses) {
    if (!countsAsAnswer(row)) {
      continue;
    }

    const key = `${respondentKey(row)}\u0000${questionKey(row)}`;
    const current = latest.get(key);

    if (current === undefined) {
      latest.set(key, row);
    } else if (Date.parse(row.saved_at) >= Date.parse(current.saved_at)) {
      superseded.add(current);
      latest.set(key, row);
    } else {
      superseded.add(row);
    }
  }

  return superseded;
}

export function aggregateSurveyResults(
  steps: StudyStep[],
  responses: StoredResponse[]
): SurveyResults {
  const questions = steps.filter((step) => QUESTION_TYPES.has(step.type));

  const byStep = new Map<string, StoredResponse[]>();
  const detached: StoredResponse[] = [];
  const respondents = new Set<string>();
  const superseded = supersededAnswers(responses);

  for (const row of responses) {
    respondents.add(respondentKey(row));

    // AFTER the respondent is counted and before anything is tallied: a person
    // whose only answer lost is still somebody who answered, but the answer
    // itself is replaced by their later one (cto/AdaptaLabs#152). This is the
    // one line that keeps `answered`, the option counts, the means and the
    // NPS from counting one person twice.
    if (superseded.has(row)) {
      continue;
    }

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
