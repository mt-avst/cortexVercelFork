import { describe, expect, it } from "vitest";

import { isSafeTargetUrl } from "../../../shared/firsthand/url-safety";

/**
 * Direct tests for the predicate itself. It was previously exercised only
 * transitively through stepSchema and inlineStudySchema, which is exactly why a
 * bug in its own contract survived: a first attempt at hardening resolved
 * against a SINGLE sentinel base, so an input NAMING that base satisfied the
 * origin check. Nothing stated the function's own behaviour, so nothing probed
 * it.
 */
describe("isSafeTargetUrl", () => {
  describe("accepts", () => {
    it.each([
      ["an absolute https URL", "https://example.com/checkout"],
      ["an absolute http URL", "http://example.com/checkout"],
      ["a root-relative path", "/demo/checkout"],
      ["the bare root", "/"],
      ["a path with query and fragment", "/a/b?c=d#e"]
    ])("%s", (_label, url) => {
      expect(isSafeTargetUrl(url)).toBe(true);
    });
  });

  describe("rejects active and non-http schemes", () => {
    it.each([
      ["javascript:alert(1)"],
      ["JavaScript:alert(1)"],
      ["data:text/html,<script>alert(1)</script>"],
      ["vbscript:msgbox(1)"],
      ["blob:https://example.com/abc"],
      ["filesystem:https://example.com/temporary/x"],
      ["file:///etc/passwd"]
    ])("%s", (url) => {
      expect(isSafeTargetUrl(url)).toBe(false);
    });
  });

  describe("rejects inputs that look root-relative but escape the origin", () => {
    // The WHATWG parser treats `\` as `/` after a special scheme and strips
    // tab/CR/LF anywhere in the input, so a startsWith("/") check sees a safe
    // path while the browser navigates cross-origin. Each case asserts where it
    // ACTUALLY resolves, against a base deliberately different from the
    // implementation's sentinels - otherwise the assertion would collapse into
    // a restatement of the implementation and prove nothing.
    it.each([
      ["protocol-relative", "//evil.example/x"],
      ["backslash", "/\\evil.example/x"],
      ["tab", "/\t/evil.example/x"],
      ["line feed", "/\n/evil.example/x"],
      ["carriage return", "/\r/evil.example/x"]
    ])("%s", (_label, url) => {
      expect(new URL(url, "https://cortex.test").origin).toBe(
        "https://evil.example"
      );
      expect(isSafeTargetUrl(url)).toBe(false);
    });
  });

  describe("rejects inputs that name the resolution sentinel itself", () => {
    // The regression a single-base implementation had. `//same-origin.invalid`
    // resolved to the sentinel's own origin and was accepted - and the string
    // check this replaced would have rejected it, so it was a step backwards.
    it.each([
      ["//same-origin.invalid/x"],
      ["//a.same-origin.invalid/x"],
      ["//b.same-origin.invalid/x"],
      ["//SAME-ORIGIN.INVALID/x"],
      ["/\\a.same-origin.invalid/x"],
      ["/\\a.same-origin.invalid\\@evil.example/x"]
    ])("%s", (url) => {
      expect(isSafeTargetUrl(url)).toBe(false);
    });
  });

  describe("rejects path-relative inputs, whose meaning depends on the base", () => {
    // These resolve against the sentinel ROOT in the validator but against the
    // opener's document URL at the sink (window.open("") inherits a base
    // carrying a path), so accepting them would validate a different
    // destination from the one that is opened.
    it.each([["checkout"], ["./checkout"], ["../checkout"], ["?q=1"], ["#f"]])(
      "%s",
      (url) => {
        expect(isSafeTargetUrl(url)).toBe(false);
      }
    );
  });

  it("rejects malformed authority forms that throw on resolution", () => {
    expect(isSafeTargetUrl("/\\")).toBe(false);
    expect(isSafeTargetUrl("//")).toBe(false);
  });
});
