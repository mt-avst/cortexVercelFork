import { describe, expect, it } from "vitest";

import { stepSchema } from "../../../shared/firsthand/contract";

// The task page opens in a same-origin window and is navigated by assigning
// location.href, so a javascript:/data: target_url would run in this app's
// origin. The schema is the ingestion boundary for both integration payloads
// and authored studies (study-input reuses stepSchema), so the guard must bite
// here, not only at the window sink.
describe("stepSchema target_url safety", () => {
  const base = {
    step_id: "s1",
    order: 1,
    type: "instruction" as const,
    prompt: "Do the task"
  };

  it("accepts an absolute https target", () => {
    expect(
      stepSchema.safeParse({ ...base, target_url: "https://acme.test/checkout" })
        .success
    ).toBe(true);
  });

  it("accepts a same-origin root-relative target", () => {
    expect(
      stepSchema.safeParse({ ...base, target_url: "/demo-target/checkout" }).success
    ).toBe(true);
  });

  it("rejects a javascript: target", () => {
    expect(
      stepSchema.safeParse({ ...base, target_url: "javascript:alert(1)" }).success
    ).toBe(false);
  });

  it("rejects a protocol-relative target", () => {
    expect(
      stepSchema.safeParse({ ...base, target_url: "//evil.example/x" }).success
    ).toBe(false);
  });

  it("still allows an omitted target_url (survey-style steps)", () => {
    expect(stepSchema.safeParse(base).success).toBe(true);
  });
});
