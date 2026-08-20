import { describe, expect, it } from "vitest";

import { sessionPayloadSchema } from "../../../shared/firsthand/contract";
import {
  END_STEP_PROMPT,
  inlineStudySchema,
  toStudySteps
} from "../../../shared/firsthand/inline-study";

describe("toStudySteps", () => {
  it("numbers steps from array position and appends the end marker", () => {
    const steps = toStudySteps(
      [
        { type: "instruction", prompt: "Open the dashboard" },
        { type: "open_text", prompt: "What did you expect?" }
      ],
      "study_x"
    );

    expect(steps).toEqual([
      {
        step_id: "study_x_step_1",
        order: 1,
        type: "instruction",
        prompt: "Open the dashboard"
      },
      {
        step_id: "study_x_step_2",
        order: 2,
        type: "open_text",
        prompt: "What did you expect?"
      },
      {
        step_id: "study_x_step_end",
        order: 3,
        type: "end",
        prompt: END_STEP_PROMPT
      }
    ]);
  });

  it("puts the study-level target url on every authored step, never the end marker", () => {
    // Not just the first: StudyRunner renders the task-window panel - the "go
    // to the task page" button and the "keep it open or recording stops"
    // warning - only when the CURRENT step carries a target. First-step-only
    // left tasks 2..n with no way to recover a buried or closed popup.
    const steps = toStudySteps(
      [
        { type: "instruction", prompt: "Open the dashboard" },
        { type: "open_text", prompt: "What did you expect?" }
      ],
      "study_x",
      "https://example.com/checkout"
    );

    expect(steps[0].target_url).toBe("https://example.com/checkout");
    expect(steps[1].target_url).toBe("https://example.com/checkout");
    // The appended completion marker is never a task and never gets one.
    expect(steps[2].type).toBe("end");
    expect(steps[2].target_url).toBeUndefined();
  });

  it("omits target_url entirely when no starting url is given", () => {
    // Absence is meaningful: a study with no target on any step is not a
    // first-hand study, and the setup flow falls back to a single start action.
    const [step] = toStudySteps([{ type: "open_text", prompt: "A" }], "study_x");

    expect("target_url" in step).toBe(false);
  });

  it("gives two studies disjoint step ids", () => {
    // study_steps.id is a GLOBAL primary key rather than one scoped by
    // study_id, so position-only ids made the second inline study fail with a
    // unique violation. This is the regression guard for that.
    const a = toStudySteps([{ type: "open_text", prompt: "A" }], "study_a");
    const b = toStudySteps([{ type: "open_text", prompt: "B" }], "study_b");

    const aIds = a.map((s) => s.step_id);
    const bIds = b.map((s) => s.step_id);

    expect(aIds.some((id) => bIds.includes(id))).toBe(false);
  });

  it("trims prompts and omits absent optional fields rather than setting undefined", () => {
    const [step] = toStudySteps(
      [{ type: "open_text", prompt: "  padded  " }],
      "study_x"
    );

    expect(step.prompt).toBe("padded");
    // Presence matters, not just value: an explicit `options: undefined` key
    // serialises to JSON differently from an absent one.
    expect(Object.keys(step)).toEqual(["step_id", "order", "type", "prompt"]);
  });

  it("carries choice options through", () => {
    const [step] = toStudySteps(
      [{ type: "single_choice", prompt: "Pick one", options: ["A", "B"] }],
      "study_x"
    );

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
      steps: toStudySteps(
        [
          { type: "instruction", prompt: "Do the thing" },
          { type: "single_choice", prompt: "Pick one", options: ["A", "B"] }
        ],
        "study_1"
      )
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

  it.each([
    ["javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["//evil.example.com/checkout"],
    // Look root-relative, resolve cross-origin: the parser treats `\` as `/`
    // and strips tab/CR/LF. See url-safety.ts for why these were the dangerous
    // ones - they also suppress the destination label shown to the participant.
    ["/\\evil.example.com/checkout"],
    ["/\t/evil.example.com/checkout"],
    ["/\n/evil.example.com/checkout"],
    ["/\r/evil.example.com/checkout"]
  ])("rejects the unsafe target url %s", (target) => {
    // The task page is opened as a same-origin about:blank and navigated by
    // assigning location.href, so an active scheme would execute against the
    // participant's session. Protocol-relative resolves to another origin.
    const result = inlineStudySchema.safeParse({
      consent_text: "C",
      target_url: target,
      steps: [{ type: "open_text", prompt: "A" }]
    });

    expect(result.success).toBe(false);
  });

  it.each([["https://example.com/checkout"], ["/demo/checkout"]])(
    "accepts the safe target url %s",
    (target) => {
      const result = inlineStudySchema.safeParse({
        consent_text: "C",
        target_url: target,
        steps: [{ type: "open_text", prompt: "A" }]
      });

      expect(result.success).toBe(true);
    }
  );

  it("rejects the end type, which is machine-appended rather than authored", () => {
    const result = inlineStudySchema.safeParse({
      consent_text: "C",
      steps: [{ type: "end", prompt: "Done" }]
    });

    expect(result.success).toBe(false);
  });

  /**
   * B3: the picker copies a study rather than linking to it, and records what
   * it copied from. This object is NOT `.strict()`, so an undeclared field
   * would not fail parsing - it would be silently stripped, and `.success`
   * alone cannot tell the two apart. Asserted on the parsed VALUE for that
   * reason: this is the non-strict twin of the identical field on
   * inlineSurveySchema, and provenance silently vanishing on this twin only
   * is exactly the failure mode the brief calls out.
   */
  it("carries copied_from_study_id through to the parsed value", () => {
    const result = inlineStudySchema.safeParse({
      consent_text: "C",
      steps: [{ type: "open_text", prompt: "A" }],
      copied_from_study_id: "study_source"
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.copied_from_study_id).toBe("study_source");
  });
});
