export type FlowPhase =
  | "welcome"
  | "consent"
  | "setup"
  | "running"
  | "uploading"
  | "completed"
  | "declined";

const flowPhases: readonly FlowPhase[] = [
  "welcome",
  "consent",
  "setup",
  "running",
  "uploading",
  "completed",
  "declined"
];

export type SessionRecordingStatus =
  | "not_started"
  | "starting"
  | "active"
  | "stopping"
  | "stopped"
  | "failed";

type StorageScope = "all" | "flow" | "runner";
type StorageLike = Pick<Storage, "removeItem">;

function buildAttemptStorageSuffix(attemptNumber?: number) {
  return attemptNumber ? `:attempt:${attemptNumber}` : "";
}

export function getFlowStorageKey(token: string, attemptNumber?: number) {
  return `firsthand-flow:${token}${buildAttemptStorageSuffix(attemptNumber)}`;
}

export function getRunnerStorageKey(token: string, attemptNumber?: number) {
  return `firsthand-runner:${token}${buildAttemptStorageSuffix(attemptNumber)}`;
}

export function clearParticipantSessionStorage(
  storage: StorageLike,
  token: string,
  scope: StorageScope = "all",
  attemptNumber?: number
) {
  const flowKeys = new Set([
    getFlowStorageKey(token),
    getFlowStorageKey(token, attemptNumber)
  ]);
  const runnerKeys = new Set([
    getRunnerStorageKey(token),
    getRunnerStorageKey(token, attemptNumber)
  ]);

  if (scope === "all" || scope === "flow") {
    for (const key of flowKeys) {
      storage.removeItem(key);
    }
  }

  if (scope === "all" || scope === "runner") {
    for (const key of runnerKeys) {
      storage.removeItem(key);
    }
  }
}

export function migratePersistedPhase(raw: string): FlowPhase {
  if (raw === "ready") {
    return "setup";
  }

  return (flowPhases as readonly string[]).includes(raw)
    ? (raw as FlowPhase)
    : "welcome";
}

// The server's session lifecycle states that mean real, mid-flight progress
// exists for this participant - progress a fresh local device knows nothing
// about. Mirrors backend/src/firsthand/state-model.ts sessionLifecycleStates,
// but kept as its own literal set here on purpose: increment-1 only needs to
// answer "is there something to lose", and pinning the exact five states as a
// literal is what lets a test fail by name if that answer ever drifts.
// ponytail: hand-mirrored subset of the backend lifecycle enum. An 11th backend
//   state would fail safe to "no prompt" here (never crash or mis-warn), and the
//   session-local-state test pins the current 10 by name so a re-partition of the
//   existing set is caught. Fold this into a shared contract if the enum grows.
const midFlightServerStates: ReadonlySet<string> = new Set([
  "consent_accepted",
  "setup_in_progress",
  "ready_to_start",
  "recording_in_progress",
  "uploading"
]);

/**
 * Whether a server-side session status represents unfinished, mid-flight
 * progress worth warning a participant about before they start over on a fresh
 * device. True ONLY for the mid-flight set; false for the pre-progress states
 * (created, link_opened) and for every terminal state (completed, abandoned,
 * failed), and false for any unrecognised string so an unknown status fails
 * safe to "no prompt".
 */
export function hasUnfinishedServerProgress(sessionStatus: string): boolean {
  return midFlightServerStates.has(sessionStatus);
}

export function getInterruptedRunRecovery(input: {
  phase: FlowPhase;
  recordingStatus: SessionRecordingStatus;
}) {
  if (
    (input.phase === "running" || input.phase === "uploading") &&
    input.recordingStatus === "not_started"
  ) {
    return {
      nextPhase: "setup" as const,
      runtimeEventType: "session_abandoned" as const,
      message:
        "Your last attempt was interrupted, so nothing was saved. Start again when you are ready."
    };
  }

  return null;
}
