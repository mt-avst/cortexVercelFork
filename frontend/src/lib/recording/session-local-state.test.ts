import { describe, expect, it } from "vitest";

import {
  clearParticipantSessionStorage,
  getFlowStorageKey,
  getInterruptedRunRecovery,
  getRunnerStorageKey,
  hasUnfinishedServerProgress,
  migratePersistedPhase,
  type FlowPhase
} from "./session-local-state";

describe("session local state helpers", () => {
  it("returns stable storage keys for flow and runner state", () => {
    expect(getFlowStorageKey("fh_demo_valid")).toBe(
      "firsthand-flow:fh_demo_valid"
    );
    expect(getRunnerStorageKey("fh_demo_valid")).toBe(
      "firsthand-runner:fh_demo_valid"
    );
    expect(getFlowStorageKey("fh_demo_valid", 3)).toBe(
      "firsthand-flow:fh_demo_valid:attempt:3"
    );
    expect(getRunnerStorageKey("fh_demo_valid", 3)).toBe(
      "firsthand-runner:fh_demo_valid:attempt:3"
    );
  });

  it("clears both flow and runner storage by default", () => {
    const removedKeys: string[] = [];
    const storage = {
      removeItem(key: string) {
        removedKeys.push(key);
      }
    };

    clearParticipantSessionStorage(storage, "fh_demo_valid");

    expect(removedKeys).toEqual([
      "firsthand-flow:fh_demo_valid",
      "firsthand-runner:fh_demo_valid"
    ]);
  });

  it("clears only the runner state when requested", () => {
    const removedKeys: string[] = [];
    const storage = {
      removeItem(key: string) {
        removedKeys.push(key);
      }
    };

    clearParticipantSessionStorage(storage, "fh_demo_valid", "runner");

    expect(removedKeys).toEqual(["firsthand-runner:fh_demo_valid"]);
  });

  it("clears both legacy and attempt-scoped storage when an attempt is provided", () => {
    const removedKeys: string[] = [];
    const storage = {
      removeItem(key: string) {
        removedKeys.push(key);
      }
    };

    clearParticipantSessionStorage(storage, "fh_demo_valid", "all", 4);

    expect(removedKeys).toEqual([
      "firsthand-flow:fh_demo_valid",
      "firsthand-flow:fh_demo_valid:attempt:4",
      "firsthand-runner:fh_demo_valid",
      "firsthand-runner:fh_demo_valid:attempt:4"
    ]);
  });

  it("resets interrupted running sessions back to setup state", () => {
    expect(
      getInterruptedRunRecovery({
        phase: "running",
        recordingStatus: "not_started"
      })
    ).toEqual({
      nextPhase: "setup",
      runtimeEventType: "session_abandoned",
      message:
        "Your last attempt was interrupted, so nothing was saved. Start again when you are ready."
    });
  });

  it("resets interrupted uploading sessions back to setup state", () => {
    expect(
      getInterruptedRunRecovery({
        phase: "uploading",
        recordingStatus: "not_started"
      })
    ).toEqual({
      nextPhase: "setup",
      runtimeEventType: "session_abandoned",
      message:
        "Your last attempt was interrupted, so nothing was saved. Start again when you are ready."
    });
  });

  it("does not recover sessions that are not interrupted", () => {
    expect(
      getInterruptedRunRecovery({
        phase: "running",
        recordingStatus: "active"
      })
    ).toBeNull();
    expect(
      getInterruptedRunRecovery({
        phase: "setup",
        recordingStatus: "not_started"
      })
    ).toBeNull();
  });

  it("migrates persisted ready phases to setup", () => {
    expect(migratePersistedPhase("ready")).toBe("setup");
  });

  it("passes valid persisted phases through unchanged", () => {
    const phases: FlowPhase[] = [
      "welcome",
      "consent",
      "setup",
      "running",
      "uploading",
      "completed",
      "declined"
    ];

    for (const phase of phases) {
      expect(migratePersistedPhase(phase)).toBe(phase);
    }
  });

  it("falls back to welcome for unknown persisted phases", () => {
    expect(migratePersistedPhase("finished")).toBe("welcome");
    expect(migratePersistedPhase("")).toBe("welcome");
  });
});

describe("hasUnfinishedServerProgress", () => {
  // Every lifecycle state from backend/src/firsthand/state-model.ts is pinned
  // here by name: if the mid-flight set widens or narrows, one of these fails
  // by name rather than the behaviour drifting silently.
  const midFlight = [
    "consent_accepted",
    "setup_in_progress",
    "ready_to_start",
    "recording_in_progress",
    "uploading"
  ] as const;

  const notMidFlight = [
    "created",
    "link_opened",
    "completed",
    "abandoned",
    "failed"
  ] as const;

  for (const status of midFlight) {
    it(`treats ${status} as unfinished progress`, () => {
      expect(hasUnfinishedServerProgress(status)).toBe(true);
    });
  }

  for (const status of notMidFlight) {
    it(`does not treat ${status} as unfinished progress`, () => {
      expect(hasUnfinishedServerProgress(status)).toBe(false);
    });
  }

  it("fails safe to false for an unrecognised status", () => {
    expect(hasUnfinishedServerProgress("something_else")).toBe(false);
    expect(hasUnfinishedServerProgress("")).toBe(false);
  });
});
