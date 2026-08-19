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
  stepId: string,
  sessionId: string,
  payload: Record<string, unknown>
): StoredResponse => ({
  session_id: sessionId,
  step_id: stepId,
  step_type: "x",
  response_payload: payload,
  saved_at: "2026-08-16T00:00:00.000Z"
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
