import { describe, expect, it } from "vitest";

import type { StudyStep } from "@shared/firsthand/contract";
import { describeTarget, getPrimaryTargetUrl } from "./task-target";

function step(overrides: Partial<StudyStep>): StudyStep {
  return {
    step_id: "s1",
    order: 1,
    type: "instruction",
    prompt: "Do the thing",
    ...overrides
  } as StudyStep;
}

describe("getPrimaryTargetUrl", () => {
  it("returns the first task step's target_url", () => {
    const steps = [
      step({ step_id: "a", order: 1, target_url: "https://acme.test/checkout" }),
      step({ step_id: "b", order: 2, target_url: "https://acme.test/other" })
    ];

    expect(getPrimaryTargetUrl(steps)).toBe("https://acme.test/checkout");
  });

  it("skips leading steps that carry no target_url", () => {
    const steps = [
      step({ step_id: "a", order: 1, type: "open_text" }),
      step({ step_id: "b", order: 2, target_url: "https://acme.test/two" })
    ];

    expect(getPrimaryTargetUrl(steps)).toBe("https://acme.test/two");
  });

  it("never treats an end step as the target, even if one slipped a url in", () => {
    const steps = [
      step({ step_id: "end", order: 1, type: "end", target_url: "https://x.test/end" })
    ];

    expect(getPrimaryTargetUrl(steps)).toBeNull();
  });

  it("returns null when no step has a target_url (a survey-style study)", () => {
    const steps = [
      step({ step_id: "a", order: 1, type: "open_text" }),
      step({ step_id: "b", order: 2, type: "single_choice", options: ["Yes", "No"] })
    ];

    expect(getPrimaryTargetUrl(steps)).toBeNull();
  });
});

describe("describeTarget", () => {
  it("uses the hostname for an absolute https target", () => {
    expect(describeTarget("https://checkout.acme.com/cart?token=abc123")).toEqual({
      host: "checkout.acme.com",
      label: "checkout.acme.com"
    });
  });

  it("keeps a non-standard port in the host so the window is still identifiable", () => {
    expect(describeTarget("http://localhost:3000/demo")).toEqual({
      host: "localhost:3000",
      label: "localhost:3000"
    });
  });

  it("does not claim a host for a relative path (it would be this app's own)", () => {
    expect(describeTarget("/demo-target/checkout")).toEqual({
      host: null,
      label: "the task page"
    });
  });

  it("falls back to the neutral label for a non-http scheme", () => {
    expect(describeTarget("mailto:someone@acme.com")).toEqual({
      host: null,
      label: "the task page"
    });
  });
});
