import { describe, expect, it } from "vitest";

import {
  answeredRuntimeStates,
  isAnsweredRuntimeStatus,
  isInFlightRuntimeSession,
  sessionLifecycleStates,
  terminalUnansweredRuntimeStates
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

describe("isInFlightRuntimeSession", () => {
  // Pinned as literals for the same reason answeredRuntimeStates is: this is
  // the ONE predicate the survey-session mint route's resume lookup and the
  // participant detail read's completion.inProgress both use, and a drift in
  // it is a drift in both (cto/AdaptaLabs#129).
  it("pins the terminal-unanswered set to exactly abandoned and failed", () => {
    expect([...terminalUnansweredRuntimeStates]).toEqual(["abandoned", "failed"]);
  });

  it("is in flight for an unanswered, unexpired session", () => {
    expect(
      isInFlightRuntimeSession({ sessionStatus: "link_opened", sessionNotExpired: true })
    ).toBe(true);
  });

  it("is not in flight once the session has been answered (completed)", () => {
    expect(
      isInFlightRuntimeSession({ sessionStatus: "completed", sessionNotExpired: true })
    ).toBe(false);
  });

  it("is not in flight while the recording still uploads", () => {
    // Shares the answered set with the recorded runtime - an uploading
    // session is done, not resumable.
    expect(
      isInFlightRuntimeSession({ sessionStatus: "uploading", sessionNotExpired: true })
    ).toBe(false);
  });

  it.each(["abandoned", "failed"])(
    "is not in flight once the session is terminal-unanswered (%s)",
    (sessionStatus) => {
      expect(isInFlightRuntimeSession({ sessionStatus, sessionNotExpired: true })).toBe(false);
    }
  );

  it("is not in flight once the session's own token has expired", () => {
    // An unanswered, non-terminal status - but the payload-carried expiry has
    // passed. A dead link, not a live one: LOW-8 (cto/AdaptaLabs#129).
    expect(
      isInFlightRuntimeSession({ sessionStatus: "link_opened", sessionNotExpired: false })
    ).toBe(false);
  });

  it("an answered session outranks expiry: still not in flight even if unexpired", () => {
    expect(
      isInFlightRuntimeSession({ sessionStatus: "completed", sessionNotExpired: false })
    ).toBe(false);
  });
});
