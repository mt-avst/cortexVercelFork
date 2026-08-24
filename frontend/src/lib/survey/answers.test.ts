import { describe, expect, it } from "vitest";

import type { StudyStep } from "@shared/firsthand/contract";
import { isAnswered, validateAnswer } from "./answers";

/**
 * Answer rules for the native survey question types.
 *
 * Separate from StudyRunner's validateStepResponse, which belongs to the
 * recorded flow and now treats every step as an instruction because answers
 * there are spoken aloud. These rules are for typed answers in a survey that
 * records nothing.
 */

const step = (over: Partial<StudyStep> & Pick<StudyStep, "type">): StudyStep =>
  ({
    step_id: "s1",
    order: 1,
    prompt: "Question",
    ...over
  }) as StudyStep;

describe("optional questions", () => {
  it.each([
    ["open_text"],
    ["single_choice"],
    ["multi_choice"],
    ["rating"],
    ["nps"]
  ])("lets an unanswered optional %s through", (type) => {
    expect(
      validateAnswer(step({ type, options: ["a", "b"], config: { scale_max: 5 } }), undefined)
    ).toBeNull();
  });

  // A cap is a property of the question, not of whether it is required. An
  // optional question the participant over-answers is still over-answered.
  it("still enforces the selection cap on an optional multi_choice", () => {
    expect(
      validateAnswer(
        step({
          type: "multi_choice",
          options: ["a", "b", "c"],
          config: { max_selections: 2 }
        }),
        { selectedOptions: ["a", "b", "c"] }
      )
    ).toMatch(/at most 2/);
  });

  // Likewise an out-of-range value is invalid however it got there - it can
  // only come from a tampered request, and storing it would corrupt the
  // aggregate the results view computes.
  it("still rejects an out-of-range rating on an optional question", () => {
    expect(
      validateAnswer(step({ type: "rating", config: { scale_max: 5 } }), {
        rating: 9
      })
    ).not.toBeNull();
  });
});

describe("required open_text", () => {
  const required = step({ type: "open_text", is_required: true });

  it("rejects an empty answer", () => {
    expect(validateAnswer(required, undefined)).not.toBeNull();
  });

  it("rejects whitespace only", () => {
    expect(validateAnswer(required, { text: "   " })).not.toBeNull();
  });

  it("accepts real text", () => {
    expect(validateAnswer(required, { text: "It was fine" })).toBeNull();
  });
});

describe("required single_choice", () => {
  const required = step({
    type: "single_choice",
    is_required: true,
    options: ["Jira", "Confluence"]
  });

  it("rejects no selection", () => {
    expect(validateAnswer(required, undefined)).not.toBeNull();
  });

  it("accepts a listed option", () => {
    expect(validateAnswer(required, { selectedOption: "Jira" })).toBeNull();
  });

  // Only reachable by tampering, but it decides what lands in the tally.
  it("rejects an option that is not on the question", () => {
    expect(
      validateAnswer(required, { selectedOption: "Bitbucket" })
    ).not.toBeNull();
  });
});

describe("required multi_choice", () => {
  const base = { type: "multi_choice" as const, options: ["a", "b", "c"] };

  it("rejects no selection", () => {
    expect(
      validateAnswer(step({ ...base, is_required: true }), undefined)
    ).not.toBeNull();
  });

  it("accepts one selection when no minimum is set", () => {
    expect(
      validateAnswer(step({ ...base, is_required: true }), {
        selectedOptions: ["a"]
      })
    ).toBeNull();
  });

  it("rejects fewer than the minimum", () => {
    expect(
      validateAnswer(
        step({ ...base, is_required: true, config: { min_selections: 2 } }),
        { selectedOptions: ["a"] }
      )
    ).toMatch(/at least 2/);
  });

  it("accepts exactly the minimum", () => {
    expect(
      validateAnswer(
        step({ ...base, is_required: true, config: { min_selections: 2 } }),
        { selectedOptions: ["a", "b"] }
      )
    ).toBeNull();
  });

  it("accepts exactly the maximum", () => {
    expect(
      validateAnswer(step({ ...base, config: { max_selections: 2 } }), {
        selectedOptions: ["a", "b"]
      })
    ).toBeNull();
  });

  it("rejects an option that is not on the question", () => {
    expect(
      validateAnswer(step({ ...base, is_required: true }), {
        selectedOptions: ["a", "zzz"]
      })
    ).not.toBeNull();
  });

  // Duplicates would double-count that option in the results tally.
  it("rejects the same option twice", () => {
    expect(
      validateAnswer(step({ ...base, is_required: true }), {
        selectedOptions: ["a", "a"]
      })
    ).not.toBeNull();
  });
});

describe("required rating", () => {
  const required = step({
    type: "rating",
    is_required: true,
    config: { scale_max: 5 }
  });

  it("rejects no rating", () => {
    expect(validateAnswer(required, undefined)).not.toBeNull();
  });

  it.each([[1], [3], [5]])("accepts %i on a 5 point scale", (rating) => {
    expect(validateAnswer(required, { rating })).toBeNull();
  });

  // A rating starts at 1, so 0 is not a low score - it is an unanswered
  // question that would drag every average down if it were stored.
  it.each([[0], [6], [-1], [2.5]])("rejects %s on a 5 point scale", (rating) => {
    expect(validateAnswer(required, { rating })).not.toBeNull();
  });
});

describe("required nps", () => {
  const required = step({ type: "nps", is_required: true });

  it("rejects no score", () => {
    expect(validateAnswer(required, undefined)).not.toBeNull();
  });

  // NPS genuinely starts at zero, unlike a rating, and the scale is fixed at
  // 0 to 10 by the contract rather than read from config.
  it.each([[0], [7], [10]])("accepts %i", (rating) => {
    expect(validateAnswer(required, { rating })).toBeNull();
  });

  it.each([[-1], [11]])("rejects %i", (rating) => {
    expect(validateAnswer(required, { rating })).not.toBeNull();
  });
});

describe("instruction steps", () => {
  it("never needs an answer, even when marked required", () => {
    expect(
      validateAnswer(step({ type: "instruction", is_required: true }), undefined)
    ).toBeNull();
  });
});

describe("isAnswered", () => {
  it.each([
    ["open_text", { text: "hi" }, true],
    ["open_text", { text: "  " }, false],
    ["open_text", undefined, false],
    ["single_choice", { selectedOption: "a" }, true],
    ["single_choice", {}, false],
    ["multi_choice", { selectedOptions: ["a"] }, true],
    ["multi_choice", { selectedOptions: [] }, false],
    ["rating", { rating: 3 }, true],
    ["rating", {}, false],
    ["nps", { rating: 0 }, true]
  ])("%s with %o is %s", (type, answer, expected) => {
    expect(isAnswered(step({ type }), answer)).toBe(expected);
  });

  // Zero is a real NPS score. Any truthiness check on the rating reports it as
  // unanswered, which would drop every detractor's zero from the results.
  it("treats an nps score of zero as answered", () => {
    expect(isAnswered(step({ type: "nps" }), { rating: 0 })).toBe(true);
  });

  it("never counts an instruction as answered", () => {
    expect(isAnswered(step({ type: "instruction" }), {})).toBe(false);
  });
});
