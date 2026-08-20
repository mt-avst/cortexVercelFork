import { describe, expect, it } from "vitest";

import {
  SCALE_LABEL_MAX_LENGTH,
  stepSchema
} from "../../../shared/firsthand/contract";
import { authorableStepTypes } from "../../../shared/firsthand/inline-study";
import {
  createStudyRequestSchema,
  updateStudyRequestSchema
} from "../../../shared/firsthand/study-input";
import {
  authorableSurveyStepTypes,
  inlineSurveySchema,
  toSurveySteps
} from "../../../shared/firsthand/survey-authoring";

/**
 * The survey authoring vocabulary.
 *
 * A native poll or survey authors from its own set rather than from
 * `authorableStepTypes`. That set is the vocabulary of a RECORDED task list,
 * whose answers are spoken aloud, so a rating widget has nothing to render
 * into. The two sets are deliberately different and this file pins the
 * difference from the survey side; `survey-steps.test.ts` pins it from the
 * recorded side.
 */

const workableSurvey = {
  consent_text: "Your answers are stored for research analysis.",
  steps: [
    { type: "instruction", prompt: "A few questions about the editor." },
    {
      type: "single_choice",
      prompt: "Which editor do you use?",
      options: ["VS Code", "IntelliJ"]
    }
  ]
};

describe("authorableSurveyStepTypes", () => {
  it("offers every answerable question type plus the instruction page", () => {
    expect([...authorableSurveyStepTypes]).toEqual([
      "instruction",
      "open_text",
      "single_choice",
      "multi_choice",
      "rating",
      "nps"
    ]);
  });

  it("does not offer the end marker, which is appended rather than authored", () => {
    expect(authorableSurveyStepTypes).not.toContain("end");
  });

  it("is wider than the recorded task-list vocabulary", () => {
    for (const type of authorableStepTypes) {
      expect(authorableSurveyStepTypes).toContain(type);
    }

    expect(authorableSurveyStepTypes.length).toBeGreaterThan(
      authorableStepTypes.length
    );
  });
});

describe("inlineSurveySchema", () => {
  it("accepts a workable survey", () => {
    expect(inlineSurveySchema.safeParse(workableSurvey).success).toBe(true);
  });

  it("accepts every authorable type in one survey", () => {
    const result = inlineSurveySchema.safeParse({
      consent_text: "Your answers are stored for research analysis.",
      steps: [
        { type: "instruction", prompt: "Nearly done." },
        { type: "open_text", prompt: "What would you change?" },
        { type: "single_choice", prompt: "Pick one", options: ["A", "B"] },
        { type: "multi_choice", prompt: "Pick some", options: ["A", "B", "C"] },
        { type: "rating", prompt: "Rate it", config: { scale_max: 5 } },
        { type: "nps", prompt: "Would you recommend it?" }
      ]
    });

    expect(result.success).toBe(true);
  });

  it("rejects the end marker as an authored type", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      steps: [{ type: "end", prompt: "Thanks" }]
    });

    expect(result.success).toBe(false);
  });

  it("rejects a rating with no scale, so two surveys cannot silently differ", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      steps: [{ type: "rating", prompt: "Rate it" }]
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "Choose how many points the rating scale has"
    );
  });

  it("rejects a multi-choice question with one option", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      steps: [{ type: "multi_choice", prompt: "Pick some", options: ["Only"] }]
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "A choice step needs at least two options"
    );
  });

  it("rejects an NPS question carrying options", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      steps: [{ type: "nps", prompt: "Recommend?", options: ["Yes", "No"] }]
    });

    expect(result.success).toBe(false);
  });

  it("reports the problem against the step being edited", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      steps: [
        { type: "instruction", prompt: "First" },
        { type: "rating", prompt: "Rate it" }
      ]
    });

    expect(result.error?.issues[0]?.path).toEqual(["steps", 1, "config"]);
  });

  it("rejects a whitespace-only prompt rather than storing an empty one", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      steps: [{ type: "open_text", prompt: "   " }]
    });

    expect(result.success).toBe(false);
  });

  it("requires consent text", () => {
    const result = inlineSurveySchema.safeParse({
      steps: workableSurvey.steps
    });

    expect(result.success).toBe(false);
  });

  it("requires at least one question", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      steps: []
    });

    expect(result.success).toBe(false);
  });

  /**
   * A survey has no page under test, so it takes no target_url. Accepting one
   * would put the recorded runner's task-window affordances - "open the task
   * page", "keep it open or the recording stops" - into a flow that records
   * nothing.
   */
  it("rejects a target_url", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      target_url: "https://example.com/checkout"
    });

    expect(result.success).toBe(false);
  });

  /**
   * Strict per QUESTION, not only on the survey around them. The object-level
   * .strict() rejects a study-level target_url; without one on the question
   * schema a per-question target_url was accepted and silently dropped, which
   * is the same silent strip that discarded every multi_choice, rating and nps
   * answer before 7.36.2.
   */
  it("rejects a target_url on an individual question", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      steps: [
        {
          type: "instruction",
          prompt: "Open the page",
          target_url: "https://example.com/checkout"
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unknown key on a question rather than dropping it", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      steps: [
        { type: "open_text", prompt: "What would you change?", min_length: 5 }
      ]
    });

    expect(result.success).toBe(false);
  });

  /**
   * B3: the picker copies a study rather than linking to it, and records what
   * it copied from. This object is `.strict()`, so a field missing from its
   * declared shape is a 400 rather than a silent drop - which is exactly what
   * makes this the twin that bites first if only inlineStudySchema were
   * updated. This is the twin of the identical field on inlineStudySchema;
   * both must accept it.
   */
  it("accepts copied_from_study_id", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      copied_from_study_id: "study_source"
    });

    expect(result.success).toBe(true);
  });

  /**
   * Proves `.strict()` survived adding copied_from_study_id: an unrelated
   * unknown top-level key must still be refused, not silently dropped.
   */
  it("still rejects an unrelated unknown top-level key", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      not_a_real_field: "x"
    });

    expect(result.success).toBe(false);
  });

  /**
   * The scale's end labels are participant-facing and were the one uncapped
   * author-supplied string reachable through the study API: 80KB of labels on
   * one step went straight in, bounded only by the JSON body limit.
   */
  it("rejects a scale label longer than an answer option may be", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      steps: [
        {
          type: "rating",
          prompt: "Rate it",
          config: {
            scale_max: 5,
            min_label: "x".repeat(SCALE_LABEL_MAX_LENGTH + 1)
          }
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  /**
   * Both ends, separately. Capping only one and testing only that one is how a
   * pair of fields ends up half-guarded: removing max_label's bound passed the
   * whole suite while min_label's test still looked like coverage of the rule.
   */
  it("rejects an over-long label at the other end of the scale too", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      steps: [
        {
          type: "rating",
          prompt: "Rate it",
          config: {
            scale_max: 5,
            max_label: "x".repeat(SCALE_LABEL_MAX_LENGTH + 1)
          }
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it("accepts a scale label at the limit", () => {
    const result = inlineSurveySchema.safeParse({
      ...workableSurvey,
      steps: [
        {
          type: "rating",
          prompt: "Rate it",
          config: {
            scale_max: 5,
            max_label: "x".repeat(SCALE_LABEL_MAX_LENGTH)
          }
        }
      ]
    });

    expect(result.success).toBe(true);
  });
});

describe("toSurveySteps", () => {
  const authored = inlineSurveySchema.parse({
    consent_text: "Your answers are stored for research analysis.",
    steps: [
      { type: "instruction", prompt: "A few questions." },
      {
        type: "multi_choice",
        prompt: "Pick some",
        options: ["A", "B"],
        config: { max_selections: 2 },
        helper_text: "Choose up to two",
        is_required: true
      }
    ]
  });

  it("namespaces every step id with the study id", () => {
    const steps = toSurveySteps(authored.steps, "study_abc");

    expect(steps.map((step) => step.step_id)).toEqual([
      "study_abc_step_1",
      "study_abc_step_2",
      "study_abc_step_end"
    ]);
  });

  it("appends the end marker after the authored questions", () => {
    const steps = toSurveySteps(authored.steps, "study_abc");
    const last = steps[steps.length - 1];

    expect(last.type).toBe("end");
    expect(last.order).toBe(3);
  });

  it("carries options, config, helper text and requiredness through", () => {
    const steps = toSurveySteps(authored.steps, "study_abc");

    expect(steps[1]).toMatchObject({
      type: "multi_choice",
      options: ["A", "B"],
      config: { max_selections: 2 },
      helper_text: "Choose up to two",
      is_required: true
    });
  });

  it("omits absent optional fields rather than setting them undefined", () => {
    const steps = toSurveySteps(authored.steps, "study_abc");

    expect(steps[0]).not.toHaveProperty("options");
    expect(steps[0]).not.toHaveProperty("config");
    expect(steps[0]).not.toHaveProperty("is_required");
  });

  it("gives no step a target_url", () => {
    const steps = toSurveySteps(authored.steps, "study_abc");

    for (const step of steps) {
      expect(step).not.toHaveProperty("target_url");
    }
  });

  /**
   * The fixture-shape rule: assert on what the authoring boundary actually
   * produces, not on a hand-built stored shape. A survey whose steps do not
   * satisfy stepSchema cannot be stored or assembled into a session, and the
   * failure would surface to a participant rather than to the author.
   */
  it("produces steps the contract accepts", () => {
    const steps = toSurveySteps(authored.steps, "study_abc");

    for (const step of steps) {
      expect(stepSchema.safeParse(step).success).toBe(true);
    }
  });
});

/**
 * A study's steps must be written in the vocabulary its `kind` declares.
 *
 * `createStudyRequestSchema` validates steps with `stepSchema`, which permits
 * the whole seven-type vocabulary whatever the kind says - so without this rule
 * the API accepted a `recorded` study full of `nps` steps, and a `survey` study
 * whose steps carried `target_url`. Both were proven reachable as
 * researcher_admin. Neither is visible today because nothing reads `kind` yet,
 * which is exactly why it has to be closed now: the phase that switches a
 * runner on `kind` will assume the invariant it never checked.
 */
describe("steps must match the declared vocabulary", () => {
  const recordedStep = {
    step_id: "study_abc_step_1",
    order: 1,
    type: "instruction" as const,
    prompt: "Talk through the page"
  };

  const npsStep = {
    step_id: "study_abc_step_1",
    order: 1,
    type: "nps" as const,
    prompt: "Would you recommend it?"
  };

  const baseRequest = {
    title: "Pulse",
    intro_text: "Intro",
    consent_text: "Consent"
  };

  it("accepts survey question types in a survey", () => {
    const result = createStudyRequestSchema.safeParse({
      ...baseRequest,
      kind: "survey",
      steps: [npsStep]
    });

    expect(result.success).toBe(true);
  });

  it("refuses survey question types in a recorded task list", () => {
    const result = createStudyRequestSchema.safeParse({
      ...baseRequest,
      kind: "recorded",
      steps: [npsStep]
    });

    expect(result.success).toBe(false);
  });

  it("refuses survey question types when no kind is given, because that means recorded", () => {
    const result = createStudyRequestSchema.safeParse({
      ...baseRequest,
      steps: [npsStep]
    });

    expect(result.success).toBe(false);
  });

  it("accepts a recorded vocabulary step in a survey, since a survey may explain", () => {
    const result = createStudyRequestSchema.safeParse({
      ...baseRequest,
      kind: "survey",
      steps: [recordedStep]
    });

    expect(result.success).toBe(true);
  });

  /**
   * A survey records nothing, so a step carrying a page to open would hand the
   * participant the recorded runner's task-window affordances in a flow with no
   * recording behind them. `inlineSurveySchema` forbids it, but that schema is
   * not what this route parses.
   */
  it("refuses a target_url on a survey step", () => {
    const result = createStudyRequestSchema.safeParse({
      ...baseRequest,
      kind: "survey",
      steps: [{ ...npsStep, target_url: "https://example.com/checkout" }]
    });

    expect(result.success).toBe(false);
  });

  it("still allows a target_url on a recorded step, which is the whole point of one", () => {
    const result = createStudyRequestSchema.safeParse({
      ...baseRequest,
      kind: "recorded",
      steps: [{ ...recordedStep, target_url: "https://example.com/checkout" }]
    });

    expect(result.success).toBe(true);
  });

  it("allows the end marker in either vocabulary", () => {
    const endStep = {
      step_id: "study_abc_step_end",
      order: 2,
      type: "end" as const,
      prompt: "Thanks"
    };

    expect(
      createStudyRequestSchema.safeParse({
        ...baseRequest,
        kind: "survey",
        steps: [npsStep, endStep]
      }).success
    ).toBe(true);

    expect(
      createStudyRequestSchema.safeParse({
        ...baseRequest,
        kind: "recorded",
        steps: [recordedStep, endStep]
      }).success
    ).toBe(true);
  });

  it("names the offending step so the author is told which one", () => {
    const result = createStudyRequestSchema.safeParse({
      ...baseRequest,
      kind: "recorded",
      steps: [recordedStep, { ...npsStep, step_id: "s2", order: 2 }]
    });

    expect(result.error?.issues[0]?.path).toEqual(["steps", 1, "type"]);
  });
});

/**
 * The vocabulary is fixed at create. Silently ignoring an attempt to change it
 * and answering 200 tells the caller the opposite of what happened.
 */
describe("updateStudyRequestSchema", () => {
  it("refuses an attempt to change the vocabulary rather than ignoring it", () => {
    const result = updateStudyRequestSchema.safeParse({
      title: "Renamed",
      kind: "survey"
    });

    expect(result.success).toBe(false);
  });

  it("still accepts an ordinary update", () => {
    expect(
      updateStudyRequestSchema.safeParse({ title: "Renamed" }).success
    ).toBe(true);
  });

  /**
   * StudyEditor sends one payload shape for create and update, so the id
   * arrives on both. Rejecting it would break every save made by a cached
   * bundle during a deploy window, so it is accepted and ignored on purpose.
   */
  it("accepts the id the editor sends, which the route ignores", () => {
    const result = updateStudyRequestSchema.safeParse({
      id: "study_abc",
      title: "Renamed"
    });

    expect(result.success).toBe(true);
  });

  it("refuses any other unknown field rather than dropping it", () => {
    expect(
      updateStudyRequestSchema.safeParse({
        title: "Renamed",
        owner_user_idd: "typo-that-would-silently-do-nothing"
      }).success
    ).toBe(false);
  });
});
