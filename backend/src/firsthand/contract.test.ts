import { describe, expect, it } from "vitest";

import { sessionSchema, stepSchema } from "../../../shared/firsthand/contract";

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

  // These four LOOK root-relative and used to pass a startsWith("/") check,
  // but the WHATWG parser treats `\` as `/` and strips tab/CR/LF anywhere in
  // the input, so every one of them resolves to https://evil.example/.
  //
  // Worse than an ordinary cross-origin target: describeTarget throws on them
  // and falls back to calling the destination "the task page" - the copy that
  // exists because a relative target is this app's own origin - so the
  // participant is told they are opening a Cortex page and then asked to share
  // it. The guard resolves against a sentinel origin for exactly this reason.
  it.each([
    ["backslash", "/\\evil.example/x"],
    ["tab", "/\t/evil.example/x"],
    ["line feed", "/\n/evil.example/x"],
    ["carriage return", "/\r/evil.example/x"]
  ])("rejects a %s target that escapes to another origin", (_label, target) => {
    expect(new URL(target, "https://cortex.test").origin).toBe(
      "https://evil.example"
    );
    expect(stepSchema.safeParse({ ...base, target_url: target }).success).toBe(
      false
    );
  });

  it.each([["/demo/checkout"], ["/"], ["/a/b?c=d#e"]])(
    "still accepts the genuinely same-origin path %s",
    (target) => {
      expect(stepSchema.safeParse({ ...base, target_url: target }).success).toBe(
        true
      );
    }
  );

  it("still allows an omitted target_url (survey-style steps)", () => {
    expect(stepSchema.safeParse(base).success).toBe(true);
  });
});

// callback_url is POSTed to server-side and return_url becomes an <a href> at
// the participant return, so a non-http(s) scheme must be rejected at the
// contract boundary (the pre-flag-flip follow-up to B6's sink-side guard), not
// only at the sinks. z.string().url() alone accepts javascript:/data:.
describe("sessionSchema callback_url / return_url safety", () => {
  const base = {
    session_id: "sess-1",
    session_token: "tok-1",
    study_id: "study-1",
    participant_id: "part-1"
  };

  it("accepts an absolute https callback_url and return_url", () => {
    expect(
      sessionSchema.safeParse({
        ...base,
        callback_url: "https://cortex.example/api/firsthand/callbacks",
        return_url: "https://cortex.example/opportunities/o1?completed=1"
      }).success
    ).toBe(true);
  });

  it("allows both to be omitted (internal sessions carry neither)", () => {
    expect(sessionSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a javascript: return_url", () => {
    expect(
      sessionSchema.safeParse({ ...base, return_url: "javascript:alert(1)" }).success
    ).toBe(false);
  });

  it("rejects a data: callback_url", () => {
    expect(
      sessionSchema.safeParse({
        ...base,
        callback_url: "data:text/html,<script>1</script>"
      }).success
    ).toBe(false);
  });
});
