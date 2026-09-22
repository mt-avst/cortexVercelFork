import { describe, expect, it } from "vitest";

import type { StudyStep } from "../../../shared/firsthand/contract";
import {
  findAnswerValidityProblem,
  MAX_ANSWER_OPTION_LENGTH,
  MAX_ANSWER_OPTIONS_COUNT,
  MAX_ANSWER_TEXT_LENGTH,
  surveyAnswerSchema
} from "../../../shared/firsthand/survey-answers";

const step = (over: Partial<StudyStep> & Pick<StudyStep, "type">): StudyStep =>
  ({
    step_id: "s1",
    order: 1,
    prompt: "Question",
    ...over
  }) as StudyStep;

/**
 * cto/AdaptaLabs#155 (fix 1 of 2). Before these bounds every field here was a
 * bare `z.string()` (or an array of them), so a single crafted answer - still
 * under the 100kb request-body limit - could carry megabytes of text; the CSV
 * export and aggregate-results readers then read that per session in a batch.
 * See survey-results-repository.ts's MAX_AGGREGATE_RESPONSE_CHARS for the
 * aggregate-side bound, which these per-answer caps complement rather than
 * replace - that bound still matters for many small answers summing large.
 */
describe("surveyAnswerSchema answer-length caps", () => {
  // Policy numbers, pinned as literals: a test that derives its expectation
  // from the constant cannot see the constant move.
  it("pins the text ceiling as a literal", () => {
    expect(MAX_ANSWER_TEXT_LENGTH).toBe(10_000);
  });

  it("pins the option ceiling as a literal", () => {
    expect(MAX_ANSWER_OPTION_LENGTH).toBe(500);
  });

  it("pins the selectedOptions count ceiling as a literal", () => {
    expect(MAX_ANSWER_OPTIONS_COUNT).toBe(20);
  });

  it("accepts a text answer sitting exactly on the ceiling", () => {
    const result = surveyAnswerSchema.safeParse({
      text: "a".repeat(MAX_ANSWER_TEXT_LENGTH)
    });

    expect(result.success).toBe(true);
  });

  it("rejects a text answer one character past the ceiling", () => {
    const result = surveyAnswerSchema.safeParse({
      text: "a".repeat(MAX_ANSWER_TEXT_LENGTH + 1)
    });

    expect(result.success).toBe(false);
  });

  it("accepts a selectedOption sitting exactly on the ceiling", () => {
    const result = surveyAnswerSchema.safeParse({
      selectedOption: "a".repeat(MAX_ANSWER_OPTION_LENGTH)
    });

    expect(result.success).toBe(true);
  });

  it("rejects a selectedOption one character past the ceiling", () => {
    const result = surveyAnswerSchema.safeParse({
      selectedOption: "a".repeat(MAX_ANSWER_OPTION_LENGTH + 1)
    });

    expect(result.success).toBe(false);
  });

  it("accepts a selectedOptions entry sitting exactly on the ceiling", () => {
    const result = surveyAnswerSchema.safeParse({
      selectedOptions: ["a".repeat(MAX_ANSWER_OPTION_LENGTH)]
    });

    expect(result.success).toBe(true);
  });

  it("rejects a selectedOptions entry one character past the ceiling", () => {
    const result = surveyAnswerSchema.safeParse({
      selectedOptions: ["a".repeat(MAX_ANSWER_OPTION_LENGTH + 1)]
    });

    expect(result.success).toBe(false);
  });

  it("accepts a selectedOptions array sitting exactly on the count ceiling", () => {
    const options = Array.from(
      { length: MAX_ANSWER_OPTIONS_COUNT },
      (_, i) => `opt-${i}`
    );

    const result = surveyAnswerSchema.safeParse({ selectedOptions: options });

    expect(result.success).toBe(true);
  });

  it("rejects a selectedOptions array one entry past the count ceiling", () => {
    const options = Array.from(
      { length: MAX_ANSWER_OPTIONS_COUNT + 1 },
      (_, i) => `opt-${i}`
    );

    const result = surveyAnswerSchema.safeParse({ selectedOptions: options });

    expect(result.success).toBe(false);
  });
});

/**
 * cto/AdaptaLabs#155 (fix 1 of 2), HIGH from the security-auditor gate on
 * !510. The per-field caps above bound EACH field, but nothing stopped a
 * payload from carrying a field its own step type does not use - so an
 * open_text answer could carry `selectedOptions` instead of `text`, and at
 * the pre-fix caps (500 x 1,000 chars = 500KB) that alone was above the
 * 100kb body limit: the smuggled field re-opened the exact DoS the `text`
 * cap was meant to close. `findAnswerValidityProblem` now refuses any field
 * a step type cannot legitimately produce.
 */
describe("findAnswerValidityProblem field exclusivity", () => {
  it("rejects an open_text answer smuggling selectedOptions", () => {
    const problem = findAnswerValidityProblem(step({ type: "open_text" }), {
      selectedOptions: ["a".repeat(MAX_ANSWER_OPTION_LENGTH)]
    });

    expect(problem).toEqual({ code: "field_not_applicable" });
  });

  it("rejects a rating answer smuggling selectedOptions", () => {
    const problem = findAnswerValidityProblem(
      step({ type: "rating", config: { scale_max: 5 } }),
      { selectedOptions: ["a".repeat(MAX_ANSWER_OPTION_LENGTH)] }
    );

    expect(problem).toEqual({ code: "field_not_applicable" });
  });

  // Controls: each step type's OWN field, alone, is still accepted - proof
  // the guard refuses cross-field smuggling specifically, not every answer.
  it("still accepts an open_text answer carrying only text", () => {
    expect(
      findAnswerValidityProblem(step({ type: "open_text" }), {
        text: "A genuine answer"
      })
    ).toBeNull();
  });

  it("still accepts a single_choice answer carrying only selectedOption", () => {
    expect(
      findAnswerValidityProblem(step({ type: "single_choice", options: ["a", "b"] }), {
        selectedOption: "a"
      })
    ).toBeNull();
  });

  it("still accepts a multi_choice answer carrying only selectedOptions", () => {
    expect(
      findAnswerValidityProblem(step({ type: "multi_choice", options: ["a", "b"] }), {
        selectedOptions: ["a"]
      })
    ).toBeNull();
  });

  it("still accepts a rating answer carrying only rating", () => {
    expect(
      findAnswerValidityProblem(
        step({ type: "rating", config: { scale_max: 5 } }),
        { rating: 3 }
      )
    ).toBeNull();
  });
});
