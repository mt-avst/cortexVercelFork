import { describe, expect, it } from "vitest";

import {
  isPublishableExternalLink,
  isSafeMeetingLocation,
  isSafeTargetUrl
} from "../../../shared/firsthand/url-safety";

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

/**
 * The two predicates that joined this module, and the reason they are separate
 * from `isSafeTargetUrl` above: that one guards a URL Cortex OPENS and then
 * navigates a same-origin window to, so it also refuses protocol-relative and
 * non-rooted forms. These two guard values handed to a participant's browser,
 * where only EXECUTION is ours to prevent - where the author points a link is
 * their decision.
 */
describe("isPublishableExternalLink", () => {
  it.each([
    ["an https URL", "https://example.com/survey"],
    ["an http URL", "http://example.com/survey"],
    ["an uppercase scheme, which the parser normalises", "HTTPS://example.com"],
    ["a mixed-case scheme", "HtTp://example.com"]
  ])("accepts %s", (_why, raw) => {
    expect(isPublishableExternalLink(raw)).toBe(true);
  });

  it.each([
    ["javascript", "javascript:alert(document.domain)"],
    ["javascript with a leading space", " javascript:alert(1)"],
    ["javascript in mixed case", "JaVaScRiPt:alert(1)"],
    ["javascript with an embedded tab", "java\tscript:alert(1)"],
    ["javascript with an embedded newline", "java\nscript:alert(1)"],
    ["data", "data:text/html,<script>alert(1)</script>"],
    ["vbscript", "vbscript:msgbox(1)"],
    ["file", "file:///etc/passwd"],
    ["blob", "blob:https://example.com/x"],
    ["ftp", "ftp://example.com/x"],
    ["mailto", "mailto:someone@example.com"],
    ["protocol-relative, which is not an absolute URL", "//evil.example.com"],
    ["free text", "not a url at all"],
    ["an empty string", ""]
  ])("refuses %s", (_why, raw) => {
    expect(isPublishableExternalLink(raw)).toBe(false);
  });

  it.each([[null], [undefined]])("refuses %s", (raw) => {
    expect(isPublishableExternalLink(raw)).toBe(false);
  });

  it("is not confused by an allowlisted host appearing inside the payload", () => {
    /*
     * The shape that defeated the substring check this replaced on the sessions
     * side: the `//` makes the trusted host a JavaScript comment, so any test
     * that looks for the host ANYWHERE in the string says yes.
     */
    expect(
      isPublishableExternalLink("javascript:alert(document.cookie)//meet.google.com")
    ).toBe(false);
  });
});

describe("isSafeMeetingLocation", () => {
  /*
   * A DIFFERENT question from the one above, and the difference is the whole
   * point: this field is dual-purpose. Requiring a URL would refuse every
   * room-number booking in the table, so the rule is "not executable" rather
   * than "must be a link".
   */
  it.each([
    ["a room", "Room 3B"],
    ["a note", "Zoom, see the calendar invite"],
    ["an address", "12 Example Street, London"],
    ["an https joining link", "https://meet.google.com/abc-defg-hij"],
    ["an http joining link", "http://zoom.us/j/123"],
    ["nothing at all", ""]
  ])("accepts %s", (_why, raw) => {
    expect(isSafeMeetingLocation(raw)).toBe(true);
  });

  it.each([[null], [undefined]])("accepts %s, because the field is optional", (raw) => {
    expect(isSafeMeetingLocation(raw)).toBe(true);
  });

  it.each([
    ["javascript hiding behind an allowlisted host", "javascript:alert(document.cookie)//meet.google.com"],
    ["javascript hiding behind a comment", "javascript:alert(1)/*teams.microsoft.com*/"],
    ["data with a trusted host in the fragment", "data:text/html,<script>alert(1)</script>#meet.google.com"],
    ["plain javascript", "javascript:alert(1)"],
    ["vbscript", "vbscript:msgbox(1)"]
  ])("refuses %s", (_why, raw) => {
    expect(isSafeMeetingLocation(raw)).toBe(false);
  });

  it("differs from isPublishableExternalLink exactly on free text", () => {
    /*
     * Stated as a relationship rather than two separate lists, because the
     * temptation when these drift is to make one call the other - and that
     * would either start refusing "Room 3B" or start accepting `javascript:`
     * for an opportunity link.
     */
    expect(isSafeMeetingLocation("Room 3B")).toBe(true);
    expect(isPublishableExternalLink("Room 3B")).toBe(false);
    // And they agree on everything executable.
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x"]) {
      expect(isSafeMeetingLocation(bad)).toBe(false);
      expect(isPublishableExternalLink(bad)).toBe(false);
    }
  });
});
