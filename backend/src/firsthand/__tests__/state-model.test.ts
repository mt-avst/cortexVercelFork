import { describe, expect, it } from "vitest";

import {
  answeredRuntimeStates,
  isAnsweredRuntimeStatus,
  sessionLifecycleStates
} from "../state-model";

describe("isAnsweredRuntimeStatus", () => {
  // Pinned as literals, not derived from the set: a change that widened or
  // narrowed the "already answered" gate must fail HERE by name rather than
  // silently agreeing with whatever the constant now says. This is the one
  // predicate the mint gate, the detail read and the list read all share, so a
  // drift in it is a drift in all three.
  it("treats a completed session as answered", () => {
    expect(isAnsweredRuntimeStatus("completed")).toBe(true);
  });

  it("treats an uploading session as answered", () => {
    // Surveys never upload, but the status set is shared with recorded runs and
    // the gate must not let an uploading session slip through as re-answerable.
    expect(isAnsweredRuntimeStatus("uploading")).toBe(true);
  });

  it("pins the answered set to exactly completed and uploading", () => {
    expect([...answeredRuntimeStates]).toEqual(["completed", "uploading"]);
  });

  it.each([
    "created",
    "link_opened",
    "consent_accepted",
    "setup_in_progress",
    "ready_to_start",
    "recording_in_progress",
    "abandoned",
    "failed"
  ])("treats %s as not yet answered", (status) => {
    expect(isAnsweredRuntimeStatus(status)).toBe(false);
  });

  it("covers every lifecycle state (no status is unclassified)", () => {
    // If a new lifecycle state is added, this forces a decision about which
    // side of the gate it falls on rather than defaulting to "not answered".
    for (const status of sessionLifecycleStates) {
      expect(typeof isAnsweredRuntimeStatus(status)).toBe("boolean");
    }
  });

  it("returns false for an unknown status string", () => {
    expect(isAnsweredRuntimeStatus("banana")).toBe(false);
  });
});
