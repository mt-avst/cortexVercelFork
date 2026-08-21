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
