import { describe, expect, it } from "vitest";

import { resolveStudyDuration } from "./study-duration";

/**
 * An unmoderated study had no duration field anywhere in the authoring form, so
 * `createStudy` fell back to the opportunity's `default_duration_minutes` - a
 * NOT NULL column whose DEFAULT is 30. Every recorded study therefore carried
 * "30 minutes", chosen by nobody, and it was shown to participants directly
 * above a consent button. The number was suppressed in three places rather than
 * corrected, because suppressing an invented figure is the only honest thing to
 * do with one.
 *
 * `firsthand.studies.estimated_duration_minutes` is nullable with no default,
 * so null is already available to mean "the researcher did not say". This
 * function is the whole rule: take what was authored, and never substitute the
 * opportunity's default for it.
 */
describe("resolveStudyDuration", () => {
  it("keeps a duration the researcher actually chose", () => {
    expect(resolveStudyDuration(25)).toBe(25);
  });

  it("returns null when none was given, rather than the opportunity's default", () => {
    // The bug in one line: `inlineStudy.estimated_duration_minutes ?? data.default_duration_minutes`.
    expect(resolveStudyDuration(undefined)).toBeNull();
    expect(resolveStudyDuration(null)).toBeNull();
  });

  it("treats zero as not stated, because a zero-minute session is not a duration", () => {
    expect(resolveStudyDuration(0)).toBeNull();
  });

  it("refuses a negative or non-finite value rather than storing it", () => {
    expect(resolveStudyDuration(-5)).toBeNull();
    expect(resolveStudyDuration(Number.NaN)).toBeNull();
    expect(resolveStudyDuration(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rounds a fractional value to whole minutes, because the column is an integer", () => {
    expect(resolveStudyDuration(12.4)).toBe(12);
    expect(resolveStudyDuration(12.6)).toBe(13);
  });

  it("refuses anything longer than a day, which the schema also caps", () => {
    expect(resolveStudyDuration(24 * 60)).toBe(24 * 60);
    expect(resolveStudyDuration(24 * 60 + 1)).toBeNull();
  });
});
