import { describe, expect, it } from "vitest";

import type { StudyStep } from "../../../shared/firsthand/contract";
import { aggregateSurveyResults, type StoredResponse } from "./survey-results";

/**
 * Aggregation for the native survey results view.
 *
 * The numbers here are the whole point of running a survey natively, so the
 * denominators matter more than anything else in this module: a percentage
 * against the wrong base is not a rounding difference, it is a different
 * finding.
 */

const step = (over: Partial<StudyStep> & Pick<StudyStep, "type" | "step_id">) =>
  ({ order: 1, prompt: "Question", ...over }) as StudyStep;

const response = (
  stepId: string | null,
  sessionId: string,
  payload: Record<string, unknown>,
  over: Partial<StoredResponse> = {}
): StoredResponse => ({
  session_id: sessionId,
  // Defaulted to the session id, which is what the count used to key on - so
  // every fixture written before MEDIUM-2 keeps the respondent number it
  // asserted, and only a test that OVERRIDES this can see the change.
  participant_id: sessionId,
  step_id: stepId,
  // Spelled out rather than defaulted away, because a fixture that omits a
  // field cannot test what the field does - and this one decides whether an
  // answer is reported under a live question or a removed one.
  step_prompt: null,
  step_type: "x",
  response_payload: payload,
  saved_at: "2026-08-16T00:00:00.000Z",
  ...over
});

describe("single choice tallies", () => {
  const steps = [
    step({
      step_id: "q1",
      type: "single_choice",
      prompt: "Which one?",
      options: ["Jira", "Confluence", "Bitbucket"]
    })
  ];

  it("counts each option and reports the share of those who answered", () => {
    const [result] = aggregateSurveyResults(steps, [
      response("q1", "s1", { selectedOption: "Jira" }),
      response("q1", "s2", { selectedOption: "Jira" }),
      response("q1", "s3", { selectedOption: "Confluence" })
    ]).questions;

    expect(result).toMatchObject({ step_id: "q1", answered: 3 });
    expect(result.options).toEqual([
      { option: "Jira", count: 2, percent: 66.7 },
      { option: "Confluence", count: 1, percent: 33.3 },
      { option: "Bitbucket", count: 0, percent: 0 }
    ]);
  });

  // An option nobody picked still has to appear. Dropping it makes a rejected
  // option look like one that was never offered.
  it("keeps an option nobody chose", () => {
    const [result] = aggregateSurveyResults(steps, [
      response("q1", "s1", { selectedOption: "Jira" })
    ]).questions;

    expect(result.options).toBeDefined();
    expect(result.options!.map((o) => o.option)).toEqual([
      "Jira",
      "Confluence",
      "Bitbucket"
    ]);
  });

  // Authors edit questions after launch. An answer naming an option that has
  // since been removed must not vanish silently, or the counts stop summing to
  // the number of people who answered and nobody can tell why.
  it("reports an answer whose option was edited away", () => {
    const result = aggregateSurveyResults(steps, [
      response("q1", "s1", { selectedOption: "Jira" }),
      response("q1", "s2", { selectedOption: "Crucible" })
    ]).questions[0];

    expect(result.answered).toBe(2);
    expect(result.retired_options).toEqual([{ option: "Crucible", count: 1 }]);
  });

  it("reports no answers as zero rather than dividing by zero", () => {
    const [result] = aggregateSurveyResults(steps, []).questions;

    expect(result.answered).toBe(0);
    expect(result.options!.every((o) => o.percent === 0)).toBe(true);
  });
});

describe("multi choice tallies", () => {
  const steps = [
    step({
      step_id: "q1",
      type: "multi_choice",
      prompt: "Which ones?",
      options: ["a", "b", "c"]
    })
  ];

  // The denominator is respondents, not selections. Three people picking two
  // options each is six selections, and a percentage over six would report
  // every option at half its real support.
  it("takes the percentage over respondents, not selections", () => {
    const [result] = aggregateSurveyResults(steps, [
      response("q1", "s1", { selectedOptions: ["a", "b"] }),
      response("q1", "s2", { selectedOptions: ["a", "b"] }),
      response("q1", "s3", { selectedOptions: ["a", "c"] })
    ]).questions;

    expect(result.answered).toBe(3);
    expect(result.options).toEqual([
      { option: "a", count: 3, percent: 100 },
      { option: "b", count: 2, percent: 66.7 },
      { option: "c", count: 1, percent: 33.3 }
    ]);
  });

  it("counts a respondent once per option even if stored twice", () => {
    const [result] = aggregateSurveyResults(steps, [
      response("q1", "s1", { selectedOptions: ["a", "a"] })
    ]).questions;

    expect(result.options![0]).toEqual({ option: "a", count: 1, percent: 100 });
  });
});

describe("rating", () => {
  const steps = [
    step({
      step_id: "q1",
      type: "rating",
      prompt: "How easy?",
      config: { scale_max: 5 }
    })
  ];

  it("reports a distribution over every point and the mean", () => {
    const [result] = aggregateSurveyResults(steps, [
      response("q1", "s1", { rating: 5 }),
      response("q1", "s2", { rating: 4 }),
      response("q1", "s3", { rating: 5 })
    ]).questions;

    expect(result.answered).toBe(3);
    expect(result.distribution).toEqual([
      { value: 1, count: 0 },
      { value: 2, count: 0 },
      { value: 3, count: 0 },
      { value: 4, count: 1 },
      { value: 5, count: 2 }
    ]);
    expect(result.mean).toBe(4.7);
  });

  it("reports no mean at all when nobody answered", () => {
    const [result] = aggregateSurveyResults(steps, []).questions;

    // null, not 0: a mean of zero is not even on the scale, and it would drag
    // any comparison across questions towards a score nobody gave.
    expect(result.mean).toBeNull();
  });
});

describe("nps", () => {
  const steps = [step({ step_id: "q1", type: "nps", prompt: "Recommend?" })];

  const scores = (values: number[]) =>
    aggregateSurveyResults(
      steps,
      values.map((rating, index) => response("q1", `s${index}`, { rating }))
    ).questions[0];

  // The banding is the standard one and is not negotiable: 9-10 promoters,
  // 7-8 passives, 0-6 detractors. Getting a boundary wrong produces a number
  // that looks plausible and is not comparable with anyone else's NPS.
  it("bands promoters, passives and detractors at the standard boundaries", () => {
    const result = scores([10, 9, 8, 7, 6, 0]);

    expect(result.promoters).toBe(2);
    expect(result.passives).toBe(2);
    expect(result.detractors).toBe(2);
  });

  it("scores promoters minus detractors as a percentage", () => {
    // 5 promoters, 3 passives, 2 detractors of 10 => 50 - 20 = 30
    const result = scores([10, 10, 10, 9, 9, 8, 8, 7, 6, 0]);

    expect(result.score).toBe(30);
  });

  it("can score negative when detractors outweigh promoters", () => {
    expect(scores([0, 0, 0, 10]).score).toBe(-50);
  });

  it("has no score when nobody answered", () => {
    expect(aggregateSurveyResults(steps, []).questions[0].score).toBeNull();
  });

  it("covers all eleven points in the distribution", () => {
    const result = scores([0, 10]);

    expect(result.distribution).toHaveLength(11);
    expect(result.distribution![0]).toEqual({ value: 0, count: 1 });
    expect(result.distribution![10]).toEqual({ value: 10, count: 1 });
  });
});

describe("open text", () => {
  const steps = [
    step({ step_id: "q1", type: "open_text", prompt: "What would you change?" })
  ];

  it("lists the answers rather than aggregating them", () => {
    const [result] = aggregateSurveyResults(steps, [
      response("q1", "s1", { text: "Better search" }),
      response("q1", "s2", { text: "More examples" })
    ]).questions;

    expect(result.answered).toBe(2);
    expect(result.answers).toEqual([
      { session_id: "s1", text: "Better search" },
      { session_id: "s2", text: "More examples" }
    ]);
  });

  it("drops a blank answer rather than listing an empty quote", () => {
    const [result] = aggregateSurveyResults(steps, [
      response("q1", "s1", { text: "   " })
    ]).questions;

    expect(result.answered).toBe(0);
    expect(result.answers).toEqual([]);
  });
});

describe("the result set as a whole", () => {
  const steps = [
    step({ step_id: "q1", type: "instruction", prompt: "Read this" }),
    step({ step_id: "q2", type: "open_text", prompt: "Thoughts?", order: 2 }),
    step({ step_id: "q3", type: "end", prompt: "Done", order: 3 })
  ];

  // Neither is a question, and including them would put two rows in the
  // results view that can never have an answer.
  it("excludes instruction and end steps", () => {
    const { questions } = aggregateSurveyResults(steps, []);

    expect(questions.map((q) => q.step_id)).toEqual(["q2"]);
  });

  it("counts distinct participants across all questions", () => {
    const { respondents } = aggregateSurveyResults(steps, [
      response("q2", "s1", { text: "a" }),
      response("q2", "s2", { text: "b" })
    ]);

    expect(respondents).toBe(2);
  });

  // One person answering three questions is one respondent, not three.
  it("counts a participant once however many questions they answered", () => {
    const many = [
      step({ step_id: "q1", type: "open_text", prompt: "One" }),
      step({ step_id: "q2", type: "open_text", prompt: "Two", order: 2 })
    ];

    const { respondents } = aggregateSurveyResults(many, [
      response("q1", "s1", { text: "a" }),
      response("q2", "s1", { text: "b" })
    ]);

    expect(respondents).toBe(1);
  });

  it("ignores a response whose step is not on the study any more", () => {
    const { questions } = aggregateSurveyResults(steps, [
      response("deleted_step", "s1", { text: "orphan" })
    ]);

    expect(questions).toHaveLength(1);
    expect(questions[0].answered).toBe(0);
  });

  /**
   * ONE PERSON IS ONE RESPONDENT ACROSS SESSIONS (cto/AdaptaLabs#129, MEDIUM-2).
   *
   * A participant can hold more than one answer-carrying `runtime_sessions`
   * row for the same study: the mint route resumes only an IN-FLIGHT session
   * (LOW-8), nothing rewrites the payload's `expires_at` on resume, and the
   * default token is 24 hours - so answering three questions and coming back
   * tomorrow leaves an expired session behind and mints a fresh one. Both
   * carry answers and the response read filters on no `session_status`, so
   * both reach this function. Keyed on `session_id` this reported one person
   * as two, in the denominator under every percentage on the page.
   */
  it("counts two sessions belonging to one participant as one respondent", () => {
    const { respondents } = aggregateSurveyResults(steps, [
      response("q2", "expired_session", { text: "yesterday" }, {
        participant_id: "person_a"
      }),
      response("q2", "fresh_session", { text: "today" }, {
        participant_id: "person_a"
      })
    ]);

    expect(respondents).toBe(1);
  });

  // The control for the test above: the fix must still be able to SEE two
  // people. An assertion that a count collapsed passes just as well when the
  // count collapsed everything.
  it("counts two participants as two respondents", () => {
    const { respondents } = aggregateSurveyResults(steps, [
      response("q2", "session_1", { text: "a" }, { participant_id: "person_a" }),
      response("q2", "session_2", { text: "b" }, { participant_id: "person_b" })
    ]);

    expect(respondents).toBe(2);
  });

  /**
   * PINNED, not incidental. `runtime_sessions.participant_id` is `TEXT NOT
   * NULL` (migration 0001, never relaxed) and every writer sets it from the
   * authenticated `req.user.id`, so the database cannot produce this row - but
   * `aggregateSurveyResults` is a pure function over a plain array and the
   * fallback decides which way it errs if one ever arrives. It errs by NOT
   * merging: two unattributable rows from different sessions stay two
   * respondents, exactly the pre-fix behaviour. Merging them would invent one
   * respondent out of people who may be different, and a denominator that
   * hides real respondents overstates every percentage taken against it.
   */
  it("falls back to the session id for a row with no participant id", () => {
    const { respondents } = aggregateSurveyResults(steps, [
      response("q2", "session_1", { text: "a" }, { participant_id: null }),
      response("q2", "session_2", { text: "b" }, { participant_id: null })
    ]);

    expect(respondents).toBe(2);
  });

  // An empty string identifies nobody, so it takes the same fallback rather
  // than collapsing every such row onto the one key "".
  it("treats an empty participant id as absent, not as a shared identity", () => {
    const { respondents } = aggregateSurveyResults(steps, [
      response("q2", "session_1", { text: "a" }, { participant_id: "" }),
      response("q2", "session_2", { text: "b" }, { participant_id: "" })
    ]);

    expect(respondents).toBe(2);
  });

  // The prefixes in `respondentKey` exist for this: without them a participant
  // id equal to another row's session id merges two different people.
  it("does not merge a participant id with another rows session id", () => {
    const { respondents } = aggregateSurveyResults(steps, [
      response("q2", "collide", { text: "a" }, { participant_id: null }),
      response("q2", "session_2", { text: "b" }, { participant_id: "collide" })
    ]);

    expect(respondents).toBe(2);
  });
});

/**
 * F2. Answers to questions the study no longer has.
 *
 * Removing a question DETACHES its answers rather than deleting them (migration
 * 0015, ON DELETE SET NULL): a researcher tidying a form must not silently
 * destroy research somebody collected. Detached rows arrive here with a null
 * `step_id` and the prompt the participant was actually shown.
 */
describe("a question the author removed after people answered it", () => {
  const live = [step({ step_id: "q1", type: "open_text", prompt: "Still asked" })];

  const detached = (
    prompt: string | null,
    sessionId: string,
    payload: Record<string, unknown>,
    stepType = "open_text"
  ) => response(null, sessionId, payload, { step_prompt: prompt, step_type: stepType });

  it("reports its answers under the prompt the participant was shown", () => {
    const { questions, removed_questions } = aggregateSurveyResults(live, [
      response("q1", "s1", { text: "live answer" }),
      detached("What did you think of the old checkout?", "s1", { text: "detached answer" })
    ]);

    // The live question is untouched, and the detached answer did NOT land on
    // it. That pairing is the assertion: an implementation that dropped the
    // null step_id into the by-step map would file it under a live question.
    expect(questions[0].answers).toEqual([{ session_id: "s1", text: "live answer" }]);
    expect(removed_questions).toEqual([
      expect.objectContaining({
        prompt: "What did you think of the old checkout?",
        answered: 1,
        answers: [{ session_id: "s1", text: "detached answer" }]
      })
    ]);
  });

  it("groups the answers of one removed question together", () => {
    const { removed_questions } = aggregateSurveyResults(live, [
      detached("Which docs did you read?", "s1", { text: "the API reference" }),
      detached("Which docs did you read?", "s2", { text: "none" })
    ]);

    expect(removed_questions).toHaveLength(1);
    expect(removed_questions?.[0].answered).toBe(2);
  });

  it("keeps two different removed questions apart", () => {
    // A single-group fixture cannot tell grouping from concatenation.
    const { removed_questions } = aggregateSurveyResults(live, [
      detached("First removed question", "s1", { text: "a" }),
      detached("Second removed question", "s1", { text: "b" })
    ]);

    expect(removed_questions?.map((question) => question.prompt)).toEqual([
      "First removed question",
      "Second removed question"
    ]);
  });

  it("keeps the same wording apart when the two questions were different types", () => {
    const { removed_questions } = aggregateSurveyResults(live, [
      detached("How was it?", "s1", { text: "fine" }, "open_text"),
      detached("How was it?", "s1", { rating: 4 }, "nps")
    ]);

    expect(removed_questions).toHaveLength(2);
  });

  it("says the wording is unknown rather than inventing one", () => {
    const { removed_questions } = aggregateSurveyResults(live, [
      detached(null, "s1", { text: "a" })
    ]);

    expect(removed_questions?.[0].prompt).toBe(
      "A question that has since been removed"
    );
  });

  it("reconstructs a removed rating's scale from the answers themselves", () => {
    // Without this the synthetic step has no `config.scale_max`, `tallyScale`
    // builds an EMPTY range, and every answer is discarded - a removed question
    // reporting "0 answered" under a heading saying people answered it.
    const { removed_questions } = aggregateSurveyResults(live, [
      detached("How easy was it?", "s1", { rating: 4 }, "rating"),
      detached("How easy was it?", "s2", { rating: 7 }, "rating")
    ]);

    expect(removed_questions?.[0]).toMatchObject({ answered: 2, mean: 5.5 });
  });

  it("still bands a removed NPS on the fixed 0-10 scale", () => {
    const { removed_questions } = aggregateSurveyResults(live, [
      detached("Would you recommend it?", "s1", { rating: 10 }, "nps"),
      detached("Would you recommend it?", "s2", { rating: 3 }, "nps")
    ]);

    expect(removed_questions?.[0]).toMatchObject({
      promoters: 1,
      detractors: 1,
      score: 0
    });
  });

  it("counts a detached answer's author as a respondent", () => {
    // Otherwise the denominator moves because a RESEARCHER edited the form,
    // which would change every percentage on the page after an edit that
    // collected nothing.
    const { respondents } = aggregateSurveyResults(live, [
      detached("Removed", "s1", { text: "a" }),
      detached("Removed", "s2", { text: "b" })
    ]);

    expect(respondents).toBe(2);
  });

  it("omits the section entirely when nothing was removed", () => {
    // Absent, not empty: nothing should render a heading for an empty section.
    const { removed_questions } = aggregateSurveyResults(live, [
      response("q1", "s1", { text: "a" })
    ]);

    expect(removed_questions).toBeUndefined();
  });

  it("does not report a detached instruction as a question nobody answered", () => {
    const { removed_questions } = aggregateSurveyResults(live, [
      detached("A section heading", "s1", {}, "instruction")
    ]);

    expect(removed_questions).toBeUndefined();
  });
});

/**
 * F2. A question that was reworded after people had answered it.
 *
 * The pre-F2 guard refused any edit to a live study's questions, so fixing a
 * typo was impossible. F2 allows it - and that is only safe if it is not
 * silent, because every result path labels an answer with the question's
 * CURRENT wording. `step_prompt` records what each participant was actually
 * shown; `asked_as` is what makes it legible.
 */
describe("a question reworded after people answered it", () => {
  const live = [step({ step_id: "q1", type: "open_text", prompt: "How was support?" })];

  const answeredAs = (prompt: string | null, sessionId: string, text: string) =>
    response("q1", sessionId, { text }, { step_prompt: prompt });

  it("reports the wording those answers were actually given against", () => {
    const { questions } = aggregateSurveyResults(live, [
      answeredAs("How was checkout?", "s1", "slow"),
      answeredAs("How was support?", "s2", "fine")
    ]);

    // Both answers still belong to the question - the identity never moved -
    // and the earlier wording is reported beside them rather than replaced by
    // the new one.
    expect(questions[0].answered).toBe(2);
    expect(questions[0].asked_as).toEqual([
      { prompt: "How was checkout?", answered: 1 }
    ]);
  });

  it("counts every answer given against an earlier wording", () => {
    const { questions } = aggregateSurveyResults(live, [
      answeredAs("How was checkout?", "s1", "slow"),
      answeredAs("How was checkout?", "s2", "fine")
    ]);

    expect(questions[0].asked_as).toEqual([
      { prompt: "How was checkout?", answered: 2 }
    ]);
  });

  it("reports more than one earlier wording separately", () => {
    // A single-group fixture cannot tell grouping from concatenation.
    const { questions } = aggregateSurveyResults(live, [
      answeredAs("How was checkout?", "s1", "a"),
      answeredAs("How was the basket?", "s2", "b")
    ]);

    expect(questions[0].asked_as).toEqual([
      { prompt: "How was checkout?", answered: 1 },
      { prompt: "How was the basket?", answered: 1 }
    ]);
  });

  it("says nothing when every answer was given against the current wording", () => {
    const { questions } = aggregateSurveyResults(live, [
      answeredAs("How was support?", "s1", "fine")
    ]);

    expect(questions[0].asked_as).toBeUndefined();
  });

  it("does not report a row that recorded no wording as a different wording", () => {
    // A null snapshot says nothing about whether the question was reworded.
    // Reporting it would put a claim on the page the data does not support.
    const { questions } = aggregateSurveyResults(live, [answeredAs(null, "s1", "fine")]);

    expect(questions[0].asked_as).toBeUndefined();
  });

  it("does not invent an earlier wording for a removed question", () => {
    // `removedQuestionsFrom` builds a synthetic step whose prompt IS the
    // snapshot, so every row in the group matches it by construction. A
    // comparison that used the live study's prompt instead would report every
    // removed question as reworded.
    const { removed_questions } = aggregateSurveyResults(live, [
      response(null, "s1", { text: "a" }, { step_prompt: "A removed question" })
    ]);

    expect(removed_questions?.[0].asked_as).toBeUndefined();
  });
});

/**
 * The cost of grouping, which no assertion about the RESULT can see.
 *
 * `aggregateSurveyResults` groups every answer by its question, and the
 * obvious immutable spelling - rebuilding the group array around each new row
 * - copies the whole accumulated array on every row. Grouping k answers to one
 * question costs k^2 array writes, and the reader above it is bounded at
 * 200,000 rows.
 *
 * This is a mutation the output cannot detect: both spellings return exactly
 * the same aggregate, so it is caught on TIME instead.
 *
 * MAX_RESPONSE_ROWS answers to one question, which is the bound the reader
 * actually enforces rather than a number picked to make a point. Measured on
 * this machine: 43 SECONDS the quadratic way and 4 MILLISECONDS the other, so
 * the budget below has three orders of magnitude of headroom on the passing
 * side and still fires on the failing one. Fifty thousand was tried first and
 * was not enough - 2.5s, comfortably inside any sane budget, which is how a
 * timing test comes to prove nothing.
 */
/** What survey-results-repository caps a single read at. */
const MAX_RESPONSE_ROWS = 200_000;

describe("grouping every answer the reader will return, all to one question", () => {
  it("stays linear", () => {
    const step: StudyStep = {
      step_id: "step_1",
      order: 1,
      type: "open_text",
      prompt: "What did you think?"
    };

    const responses: StoredResponse[] = Array.from(
      { length: MAX_RESPONSE_ROWS },
      (_unused, index) => ({
        // One person per row. Since cto/AdaptaLabs#152 a person answering the
        // same question twice keeps only their latest answer, so a fixture that
        // reused 500 people would hand the grouping 500 rows rather than the
        // 200,000 this test exists to push through it.
        session_id: `session_${index}`,
        participant_id: `participant_${index}`,
        step_id: "step_1",
        step_prompt: "What did you think?",
        step_type: "open_text",
        response_payload: { text: "fine" },
        saved_at: "2026-08-21T00:00:00.000Z"
      })
    );

    const results = aggregateSurveyResults([step], responses);

    expect(results.respondents).toBe(MAX_RESPONSE_ROWS);
    expect(results.questions[0].answered).toBe(MAX_RESPONSE_ROWS);
  }, 15_000);
});

/**
 * ONE PERSON, TWO SESSIONS, THE SAME QUESTION (cto/AdaptaLabs#152).
 *
 * An expired session earns a fresh mint rather than a dead link
 * (cto/AdaptaLabs#129), so one person can answer a question in both. The
 * headline counts people; before this every tally under it counted answer
 * rows, and the page could read "1 participant" above a chart totalling 2.
 * Decided: the LATEST answer wins, per person, per question, in every
 * aggregate on the page.
 */
describe("one person answering the same question in two sessions", () => {
  const choice = step({
    step_id: "q1",
    type: "single_choice",
    prompt: "Which did you prefer?",
    options: ["Left", "Right"]
  });

  const answer = (
    stepId: string | null,
    sessionId: string,
    payload: Record<string, unknown>,
    savedAt: string,
    over: Partial<StoredResponse> = {}
  ) =>
    response(stepId, sessionId, payload, {
      participant_id: "person",
      step_type: "single_choice",
      saved_at: savedAt,
      ...over
    });

  it("counts the latest answer once, and the earlier one not at all", () => {
    const results = aggregateSurveyResults(
      [choice],
      [
        answer("q1", "monday", { selectedOption: "Left" }, "2026-09-21T09:00:00.000Z"),
        answer("q1", "tuesday", { selectedOption: "Right" }, "2026-09-22T09:00:00.000Z")
      ]
    );

    expect(results.respondents).toBe(1);
    expect(results.questions[0]).toMatchObject({ answered: 1 });
    expect(results.questions[0].options).toEqual([
      { option: "Left", count: 0, percent: 0 },
      { option: "Right", count: 1, percent: 100 }
    ]);
  });

  it("decides by saved_at, not by the order the rows arrived in", () => {
    // The later answer FIRST in the input. A rule that kept "the last row it
    // saw" would report Left here.
    const results = aggregateSurveyResults(
      [choice],
      [
        answer("q1", "tuesday", { selectedOption: "Right" }, "2026-09-22T09:00:00.000Z"),
        answer("q1", "monday", { selectedOption: "Left" }, "2026-09-21T09:00:00.000Z")
      ]
    );

    expect(results.questions[0].options?.map((o) => o.count)).toEqual([0, 1]);
  });

  it("breaks a saved_at tie by input order, which both readers sort by saved_at then id", () => {
    const at = "2026-09-21T09:00:00.000Z";
    const results = aggregateSurveyResults(
      [choice],
      [
        answer("q1", "first", { selectedOption: "Left" }, at),
        answer("q1", "second", { selectedOption: "Right" }, at)
      ]
    );

    expect(results.questions[0].options?.map((o) => o.count)).toEqual([0, 1]);
  });

  it("keeps a mean and an NPS to one answer per person", () => {
    const rating = step({ step_id: "r1", type: "rating", config: { scale_max: 5 } });
    const nps = step({ step_id: "n1", type: "nps" });

    const [ratingResult, npsResult] = aggregateSurveyResults(
      [rating, nps],
      [
        answer("r1", "monday", { rating: 1 }, "2026-09-21T09:00:00.000Z", { step_type: "rating" }),
        answer("r1", "tuesday", { rating: 5 }, "2026-09-22T09:00:00.000Z", { step_type: "rating" }),
        answer("n1", "monday", { rating: 0 }, "2026-09-21T09:00:00.000Z", { step_type: "nps" }),
        answer("n1", "tuesday", { rating: 10 }, "2026-09-22T09:00:00.000Z", { step_type: "nps" })
      ]
    ).questions;

    // Counting both rows would give a mean of 3 and an NPS of 0.
    expect(ratingResult).toMatchObject({ answered: 1, mean: 5 });
    expect(npsResult).toMatchObject({
      answered: 1,
      promoters: 1,
      detractors: 0,
      score: 100
    });
  });

  it("lists only the latest open-text answer", () => {
    const open = step({ step_id: "t1", type: "open_text" });

    const [result] = aggregateSurveyResults(
      [open],
      [
        answer("t1", "monday", { text: "before" }, "2026-09-21T09:00:00.000Z", { step_type: "open_text" }),
        answer("t1", "tuesday", { text: "after" }, "2026-09-22T09:00:00.000Z", { step_type: "open_text" })
      ]
    ).questions;

    expect(result.answers).toEqual([{ session_id: "tuesday", text: "after" }]);
  });

  it("keeps both answers when the two sessions answered DIFFERENT questions", () => {
    const second = step({
      step_id: "q2",
      type: "single_choice",
      prompt: "And this one?",
      options: ["Yes", "No"]
    });

    const results = aggregateSurveyResults(
      [choice, second],
      [
        answer("q1", "monday", { selectedOption: "Left" }, "2026-09-21T09:00:00.000Z"),
        answer("q2", "tuesday", { selectedOption: "Yes" }, "2026-09-22T09:00:00.000Z")
      ]
    );

    expect(results.questions.map((q) => q.answered)).toEqual([1, 1]);
  });

  it("does not merge two different people who answered the same question", () => {
    const results = aggregateSurveyResults(
      [choice],
      [
        answer("q1", "s1", { selectedOption: "Left" }, "2026-09-21T09:00:00.000Z", { participant_id: "one" }),
        answer("q1", "s2", { selectedOption: "Right" }, "2026-09-22T09:00:00.000Z", { participant_id: "two" })
      ]
    );

    expect(results.respondents).toBe(2);
    expect(results.questions[0].answered).toBe(2);
  });

  it("applies the same rule to a question that has since been removed", () => {
    const results = aggregateSurveyResults(
      [],
      [
        answer(null, "monday", { selectedOption: "Left" }, "2026-09-21T09:00:00.000Z", { step_prompt: "Gone?" }),
        answer(null, "tuesday", { selectedOption: "Right" }, "2026-09-22T09:00:00.000Z", { step_prompt: "Gone?" })
      ]
    );

    expect(results.removed_questions).toHaveLength(1);
    expect(results.removed_questions?.[0]).toMatchObject({
      answered: 1,
      retired_options: [{ option: "Right", count: 1 }]
    });
  });

  it("reports the wording of the answer that won, so asked_as never outnumbers answered", () => {
    const results = aggregateSurveyResults(
      [choice],
      [
        answer("q1", "monday", { selectedOption: "Left" }, "2026-09-21T09:00:00.000Z", { step_prompt: "Old wording?" }),
        answer("q1", "tuesday", { selectedOption: "Right" }, "2026-09-22T09:00:00.000Z", { step_prompt: "Which did you prefer?" })
      ]
    );

    expect(results.questions[0].answered).toBe(1);
    expect(results.questions[0].asked_as).toBeUndefined();
  });

  it("still counts a person whose only answer lost as a respondent", () => {
    // The CONTROL for the skip: the person answered, so the headline keeps
    // them even though one of their two rows is not tallied.
    const results = aggregateSurveyResults(
      [choice],
      [
        answer("q1", "monday", { selectedOption: "Left" }, "2026-09-21T09:00:00.000Z"),
        answer("q1", "tuesday", { selectedOption: "Right" }, "2026-09-22T09:00:00.000Z")
      ]
    );

    expect(results.respondents).toBe(1);
  });
});
