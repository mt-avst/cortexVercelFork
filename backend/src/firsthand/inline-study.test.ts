import { describe, expect, it } from "vitest";

import { sessionPayloadSchema } from "../../../shared/firsthand/contract";
import {
  END_STEP_PROMPT,
  inlineStudySchema,
  toStudySteps
} from "../../../shared/firsthand/inline-study";

describe("toStudySteps", () => {
  it("numbers steps from array position and appends the end marker", () => {
    const steps = toStudySteps([
      { type: "instruction", prompt: "Open the dashboard" },
      { type: "open_text", prompt: "What did you expect?" }
    ]);

    expect(steps).toEqual([
      { step_id: "step_1", order: 1, type: "instruction", prompt: "Open the dashboard" },
      { step_id: "step_2", order: 2, type: "open_text", prompt: "What did you expect?" },
      { step_id: "step_end", order: 3, type: "end", prompt: END_STEP_PROMPT }
    ]);
  });

  it("trims prompts and omits absent optional fields rather than setting undefined", () => {
    const [step] = toStudySteps([{ type: "open_text", prompt: "  padded  " }]);

    expect(step.prompt).toBe("padded");
    // Presence matters, not just value: an explicit `options: undefined` key
    // serialises to JSON differently from an absent one.
    expect(Object.keys(step)).toEqual(["step_id", "order", "type", "prompt"]);
  });

  it("carries choice options through", () => {
    const [step] = toStudySteps([
      { type: "single_choice", prompt: "Pick one", options: ["A", "B"] }
    ]);

    expect(step.options).toEqual(["A", "B"]);
  });

  it("produces steps the session contract accepts", () => {
    // The point of the builder: what it emits has to survive the same schema
    // the participant runtime validates a session payload against.
    const payload = {
      contract_version: "1.0" as const,
      study: {
        id: "study_1",
        title: "T",
        intro_text: "I",
        consent_text: "C"
      },
      participant: { participant_id: "p1" },
      session: {
        session_id: "s1",
        session_token: "tok",
        study_id: "study_1",
        participant_id: "p1"
      },
      steps: toStudySteps([
        { type: "instruction", prompt: "Do the thing" },
        { type: "single_choice", prompt: "Pick one", options: ["A", "B"] }
      ])
    };

    expect(sessionPayloadSchema.safeParse(payload).success).toBe(true);
  });
});

describe("inlineStudySchema", () => {
  it("rejects a choice step with fewer than two options", () => {
    const result = inlineStudySchema.safeParse({
      consent_text: "C",
      steps: [{ type: "single_choice", prompt: "Pick one", options: ["only"] }]
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty step list", () => {
    const result = inlineStudySchema.safeParse({ consent_text: "C", steps: [] });

    expect(result.success).toBe(false);
  });

  it("rejects the end type, which is machine-appended rather than authored", () => {
    const result = inlineStudySchema.safeParse({
      consent_text: "C",
      steps: [{ type: "end", prompt: "Done" }]
    });

    expect(result.success).toBe(false);
  });
});
