import { describe, expect, it } from "vitest";

import {
  MAX_ANSWER_OPTION_LENGTH,
  MAX_ANSWER_OPTIONS_COUNT,
  MAX_ANSWER_TEXT_LENGTH,
  surveyAnswerSchema
} from "../../../shared/firsthand/survey-answers";

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
    expect(MAX_ANSWER_OPTION_LENGTH).toBe(1_000);
  });

  it("pins the selectedOptions count ceiling as a literal", () => {
    expect(MAX_ANSWER_OPTIONS_COUNT).toBe(500);
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
