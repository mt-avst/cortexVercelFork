import { describe, expect, it } from "vitest";

import {
  sessionPayloadSchema,
  stepSchema
} from "../../../shared/firsthand/contract";
import {
  authorableStepTypes,
  inlineStudySchema
} from "../../../shared/firsthand/inline-study";

/**
 * Native poll and survey question types.
 *
 * `poll` and `survey` opportunities were external-link-only, so the step
 * vocabulary only ever had to describe a recorded first-hand task: an
 * instruction, a free-text answer and a single choice. Running them natively
 * needs the question types a real survey uses, which is why `multi_choice`,
 * `rating` and `nps` are added here rather than in a separate survey schema -
 * they store in the same `firsthand.study_steps` rows and answer into the same
 * `participant_responses`, so a second vocabulary would only duplicate the
 * runtime.
 *
 * Storage needed no reshaping for this: `study_steps.type` is TEXT and
 * `options` / `response_payload` are JSONB. The contract is the only real gate,
 * which is exactly why the per-type rules below have to bite here.
 */

const validPayload = (step: Record<string, unknown>) => ({
  contract_version: "1.0" as const,
  study: {
    id: "study-1",
    title: "Design system survey",
    intro_text: "A few questions about the design system.",
    consent_text: "Your answers are stored for research analysis."
  },
  participant: { participant_id: "part-1" },
  session: {
    session_id: "sess-1",
    session_token: "tok-1",
    study_id: "study-1",
    participant_id: "part-1"
  },
  steps: [step]
});

describe("multi_choice steps", () => {
  const base = {
    step_id: "s1",
    order: 1,
    type: "multi_choice" as const,
    prompt: "Which of these do you use?"
  };

  it("is accepted with two or more options", () => {
    expect(
      stepSchema.safeParse({ ...base, options: ["Jira", "Confluence"] }).success
    ).toBe(true);
  });

  // Mirrors the single_choice rule. A one-option multi_choice renders as a
  // checkbox the participant can only ever agree with, which is a consent
  // control wearing a question's clothes.
  it("is rejected with fewer than two options", () => {
    expect(
      sessionPayloadSchema.safeParse(
        validPayload({ ...base, options: ["Jira"] })
      ).success
    ).toBe(false);
  });

  it("is rejected with no options at all", () => {
    expect(sessionPayloadSchema.safeParse(validPayload(base)).success).toBe(
      false
    );
  });

  it("rejects max_selections below min_selections", () => {
    expect(
      sessionPayloadSchema.safeParse(
        validPayload({
          ...base,
          options: ["Jira", "Confluence", "Bitbucket"],
          config: { min_selections: 3, max_selections: 2 }
        })
      ).success
    ).toBe(false);
  });

  // An author can otherwise write a question that cannot be satisfied: the
  // runner would block completion on a required step nobody can answer.
  it("rejects min_selections greater than the number of options", () => {
    expect(
      sessionPayloadSchema.safeParse(
        validPayload({
          ...base,
          options: ["Jira", "Confluence"],
          config: { min_selections: 3 }
        })
      ).success
    ).toBe(false);
  });

  it("accepts a workable selection range", () => {
    expect(
      sessionPayloadSchema.safeParse(
        validPayload({
          ...base,
          options: ["Jira", "Confluence", "Bitbucket"],
          config: { min_selections: 1, max_selections: 2 }
        })
      ).success
    ).toBe(true);
  });
});

describe("rating steps", () => {
  const base = {
    step_id: "s1",
    order: 1,
    type: "rating" as const,
    prompt: "How easy was that?"
  };

  it("is accepted with a scale and end labels", () => {
    expect(
      sessionPayloadSchema.safeParse(
        validPayload({
          ...base,
          config: { scale_max: 5, min_label: "Very hard", max_label: "Very easy" }
        })
      ).success
    ).toBe(true);
  });

  // Without a scale the runner has nothing to render. Defaulting silently
  // would make two studies with identical authored content produce
  // incomparable data, so the contract requires it to be stated.
  it("is rejected without a scale", () => {
    expect(sessionPayloadSchema.safeParse(validPayload(base)).success).toBe(
      false
    );
  });

  it.each([
    ["below the floor", 1],
    ["above the ceiling", 11]
  ])("is rejected with a scale %s", (_label, scale_max) => {
    expect(
      sessionPayloadSchema.safeParse(
        validPayload({ ...base, config: { scale_max } })
      ).success
    ).toBe(false);
  });

  it.each([[2], [5], [7], [10]])("accepts the usable scale %i", (scale_max) => {
    expect(
      sessionPayloadSchema.safeParse(
        validPayload({ ...base, config: { scale_max } })
      ).success
    ).toBe(true);
  });
});

describe("nps steps", () => {
  const base = {
    step_id: "s1",
    order: 1,
    type: "nps" as const,
    prompt: "How likely are you to recommend us?"
  };

  // NPS is 0 to 10 by definition. Letting an author set a scale would produce
  // something labelled NPS that cannot be compared with anyone else's NPS.
  it("is accepted with no configuration", () => {
    expect(sessionPayloadSchema.safeParse(validPayload(base)).success).toBe(
      true
    );
  });

  it("is rejected when given a scale to override", () => {
    expect(
      sessionPayloadSchema.safeParse(
        validPayload({ ...base, config: { scale_max: 5 } })
      ).success
    ).toBe(false);
  });

  it("is rejected when given options", () => {
    expect(
      sessionPayloadSchema.safeParse(
        validPayload({ ...base, options: ["Yes", "No"] })
      ).success
    ).toBe(false);
  });
});

describe("existing step types are unaffected", () => {
  it.each([
    ["instruction", {}],
    ["open_text", {}],
    ["single_choice", { options: ["Yes", "No"] }],
    ["end", {}]
  ])("still accepts a %s step", (type, extra) => {
    expect(
      sessionPayloadSchema.safeParse(
        validPayload({
          step_id: "s1",
          order: 1,
          type,
          prompt: "Prompt",
          ...extra
        })
      ).success
    ).toBe(true);
  });

  it("still rejects a single_choice step with one option", () => {
    expect(
      sessionPayloadSchema.safeParse(
        validPayload({
          step_id: "s1",
          order: 1,
          type: "single_choice",
          prompt: "Pick one",
          options: ["Only"]
        })
      ).success
    ).toBe(false);
  });
});

/**
 * The recorded first-hand task list must NOT gain these types.
 *
 * Its answers are spoken aloud rather than typed, so a rating or multi-choice
 * widget has nothing to render into, and its authoring tab is keyed on
 * `authorableStepTypes` (FirstHandStudyTab's STEP_TYPE_LABELS). Widening that
 * set is what a careless version of this change does, and it would push survey
 * controls into the recorded runner. Native surveys author from their own set,
 * added with the survey builder.
 */
describe("the recorded task list vocabulary is unchanged", () => {
  it.each([["multi_choice"], ["rating"], ["nps"]])(
    "does not offer %s as a recorded task type",
    (type) => {
      expect(authorableStepTypes).not.toContain(type);
    }
  );

  it("still offers exactly the three recorded task types", () => {
    expect([...authorableStepTypes]).toEqual([
      "instruction",
      "open_text",
      "single_choice"
    ]);
  });

  it("still rejects an authored choice step with one option", () => {
    expect(
      inlineStudySchema.safeParse({
        consent_text: "Your answers are stored for research analysis.",
        steps: [{ type: "single_choice", prompt: "Pick one", options: ["Only"] }]
      }).success
    ).toBe(false);
  });

  it("still accepts a workable authored task list", () => {
    expect(
      inlineStudySchema.safeParse({
        consent_text: "Your answers are stored for research analysis.",
        steps: [{ type: "instruction", prompt: "Find a flight to Berlin" }]
      }).success
    ).toBe(true);
  });
});
