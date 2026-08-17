import type { SessionPayload } from "../../../shared/firsthand/contract";
import type {
  RuntimeEventRecord,
  RuntimeMutation,
  RuntimeSessionRecord,
  RuntimeStore
} from "./runtime-records";

export function ensureRuntimeSession(
  store: RuntimeStore,
  payload: SessionPayload
) {
  const existing = findLatestRuntimeSessionAttempt(
    store,
    payload.session.session_id
  );

  if (existing) {
    return existing;
  }

  return createRuntimeSessionAttempt(store, payload);
}

export function createRuntimeSessionAttempt(
  store: RuntimeStore,
  payload: SessionPayload
) {
  const attemptNumber =
    findRuntimeSessionAttempts(store, payload.session.session_id).reduce(
      (maxAttemptNumber, session) =>
        Math.max(maxAttemptNumber, session.attemptNumber),
      0
    ) + 1;
  const record = createRuntimeSessionRecord(payload, {
    attemptNumber,
    sessionId: buildRuntimeAttemptSessionId(
      payload.session.session_id,
      attemptNumber
    )
  });
  store.sessions[record.sessionId] = record;

  return record;
}

export function createRuntimeSessionRecord(
  payload: SessionPayload,
  input?: {
    attemptNumber?: number;
    sessionId?: string;
  }
): RuntimeSessionRecord {
  const attemptNumber = input?.attemptNumber ?? 1;
  const logicalSessionId = payload.session.session_id;
  const sessionId =
    input?.sessionId ??
    buildRuntimeAttemptSessionId(logicalSessionId, attemptNumber);

  return {
    sessionId,
    logicalSessionId,
    attemptNumber,
    token: payload.session.session_token,
    studyId: payload.study.id,
    studyTitle: payload.study.title,
    participantId: payload.participant.participant_id,
    participantDisplayName:
      payload.participant.display_name ?? payload.participant.participant_id,
    sessionStatus: "link_opened",
    transcriptStatus: "not_requested",
    microphonePermission: "not_requested",
    screenPermission: "not_requested",
    recordingStatus: "not_started",
    uploadStatus: "not_started",
    currentStepId: null,
    startedAt: null,
    completedAt: null,
    transcript: null,
    transcriptFailureMessage: null,
    steps: payload.steps.map((step) => ({
      stepId: step.step_id,
      order: step.order,
      type: step.type,
      prompt: step.prompt
    })),
    events: [
      {
        id: crypto.randomUUID(),
        sessionId,
        eventType: "link_opened",
        timestamp: new Date().toISOString(),
        metadata: {
          source: "server_seed"
        }
      }
    ],
    responses: [],
    assets: []
  };
}

export function applyRuntimeMutationToSession(
  session: RuntimeSessionRecord,
  mutation: RuntimeMutation
) {
  if (mutation.type === "event") {
    const eventRecord: RuntimeEventRecord = {
      id: crypto.randomUUID(),
      sessionId: session.sessionId,
      stepId: mutation.stepId,
      eventType: mutation.eventType,
      timestamp: mutation.timestamp ?? new Date().toISOString(),
      metadata: mutation.metadata
    };

    session.events.push(eventRecord);
    applyDerivedStatusFromEvent(session, eventRecord);
    return;
  }

  if (mutation.type === "recording_state") {
    session.microphonePermission =
      mutation.microphonePermission ?? session.microphonePermission;
    session.screenPermission =
      mutation.screenPermission ?? session.screenPermission;
    session.recordingStatus =
      mutation.recordingStatus ?? session.recordingStatus;
    session.uploadStatus = mutation.uploadStatus ?? session.uploadStatus;
    return;
  }

  const responseRecord = {
    id: crypto.randomUUID(),
    sessionId: session.sessionId,
    stepId: mutation.stepId,
    stepType: mutation.stepType,
    responsePayload: mutation.responsePayload,
    savedAt: mutation.savedAt ?? new Date().toISOString()
  };

  session.responses = [
    ...session.responses.filter((response) => response.stepId !== mutation.stepId),
    responseRecord
  ].sort((left, right) => left.stepId.localeCompare(right.stepId));
}

export function applyDerivedStatusFromEvent(
  session: RuntimeSessionRecord,
  eventRecord: RuntimeEventRecord
) {
  switch (eventRecord.eventType) {
    case "link_opened":
      session.sessionStatus = "link_opened";
      break;
    case "consent_accepted":
      session.sessionStatus = "consent_accepted";
      break;
    case "consent_declined":
      session.sessionStatus = "abandoned";
      session.completedAt = eventRecord.timestamp;
      break;
    case "setup_started":
      session.sessionStatus = "setup_in_progress";
      break;
    case "setup_completed":
      session.sessionStatus = "ready_to_start";
      break;
    case "session_started":
      session.sessionStatus = "recording_in_progress";
      session.startedAt ??= eventRecord.timestamp;
      break;
    case "recording_started":
      session.recordingStatus = "active";
      session.microphonePermission = "granted";
      session.screenPermission = "granted";
      break;
    case "recording_stopped":
      session.recordingStatus = "stopped";
      session.uploadStatus = "pending";
      break;
    case "recording_failed":
      session.recordingStatus = "failed";
      session.sessionStatus = "failed";
      session.completedAt = eventRecord.timestamp;
      break;
    case "step_entered":
      session.currentStepId = eventRecord.stepId ?? session.currentStepId;
      break;
    case "step_exited":
      if (session.currentStepId === eventRecord.stepId) {
        session.currentStepId = null;
      }
      break;
    case "session_completed":
      // `uploading` is the right answer only when there is an upload to wait
      // for. A survey records nothing, so its uploadStatus never leaves
      // `not_started` and the session sat in `uploading` forever - which also
      // gated the analytics write, so a finished survey produced no
      // session_completed row at all and the researcher's view showed answers
      // with no completions. `not_started` means nothing was ever begun, so
      // there is nothing outstanding to wait on.
      session.sessionStatus =
        session.uploadStatus === "complete" || session.uploadStatus === "not_started"
          ? "completed"
          : "uploading";
      session.completedAt = eventRecord.timestamp;
      session.currentStepId = null;
      break;
    case "upload_started":
      session.uploadStatus = "in_progress";
      session.sessionStatus = "uploading";
      break;
    case "upload_completed":
      session.uploadStatus = "complete";
      session.sessionStatus = "completed";
      break;
    case "upload_failed":
      session.uploadStatus = "failed";
      session.sessionStatus = "failed";
      break;
    case "transcript_queued":
      session.transcriptStatus = "queued";
      break;
    case "transcript_started":
      session.transcriptStatus = "processing";
      break;
    case "transcript_completed":
      session.transcriptStatus = "complete";
      break;
    case "transcript_failed":
      session.transcriptStatus = "failed";
      break;
    case "session_abandoned":
      session.sessionStatus = "abandoned";
      session.completedAt = eventRecord.timestamp;
      session.currentStepId = null;
      break;
    case "session_failed":
      session.sessionStatus = "failed";
      session.completedAt = eventRecord.timestamp;
      break;
    case "response_submitted":
    default:
      break;
  }
}

export function resolveSessionSortTimestamp(session: RuntimeSessionRecord) {
  const candidate =
    session.completedAt ??
    session.startedAt ??
    session.events[session.events.length - 1]?.timestamp ??
    "1970-01-01T00:00:00.000Z";

  return new Date(candidate).getTime();
}

export function buildRuntimeAttemptSessionId(
  logicalSessionId: string,
  attemptNumber: number
) {
  if (attemptNumber <= 1) {
    return logicalSessionId;
  }

  return `${logicalSessionId}--attempt-${String(attemptNumber).padStart(3, "0")}`;
}

export function findRuntimeSessionAttempts(
  store: RuntimeStore,
  logicalSessionId: string
) {
  return Object.values(store.sessions)
    .filter((session) => session.logicalSessionId === logicalSessionId)
    .sort((left, right) => {
      if (left.attemptNumber !== right.attemptNumber) {
        return right.attemptNumber - left.attemptNumber;
      }

      const leftTimestamp = resolveSessionSortTimestamp(left);
      const rightTimestamp = resolveSessionSortTimestamp(right);

      return rightTimestamp - leftTimestamp;
    });
}

export function findLatestRuntimeSessionAttempt(
  store: RuntimeStore,
  logicalSessionId: string
) {
  return findRuntimeSessionAttempts(store, logicalSessionId)[0];
}

export function findRuntimeSessionAttemptByNumber(
  store: RuntimeStore,
  logicalSessionId: string,
  attemptNumber: number
) {
  return findRuntimeSessionAttempts(store, logicalSessionId).find(
    (session) => session.attemptNumber === attemptNumber
  );
}

export function resolveRuntimeSession(
  store: RuntimeStore,
  sessionIdOrLogicalSessionId: string,
  input?: {
    attemptNumber?: number;
  }
) {
  if (input?.attemptNumber) {
    return (
      findRuntimeSessionAttemptByNumber(
        store,
        sessionIdOrLogicalSessionId,
        input.attemptNumber
      ) ?? null
    );
  }

  const latestAttempt = findLatestRuntimeSessionAttempt(
    store,
    sessionIdOrLogicalSessionId
  );

  if (latestAttempt) {
    return latestAttempt;
  }

  return store.sessions[sessionIdOrLogicalSessionId] ?? null;
}

export function cloneRuntimeSession(session: RuntimeSessionRecord) {
  return JSON.parse(JSON.stringify(session)) as RuntimeSessionRecord;
}

export function pushInternalEvent(
  session: RuntimeSessionRecord,
  eventType: RuntimeEventRecord["eventType"],
  metadata?: Record<string, unknown>
) {
  const eventRecord: RuntimeEventRecord = {
    id: crypto.randomUUID(),
    sessionId: session.sessionId,
    eventType,
    timestamp: new Date().toISOString(),
    metadata
  };

  session.events.push(eventRecord);
  applyDerivedStatusFromEvent(session, eventRecord);
}
