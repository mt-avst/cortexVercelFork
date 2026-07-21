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
