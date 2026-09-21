export const sessionLifecycleStates = [
  "created",
  "link_opened",
  "consent_accepted",
  "setup_in_progress",
  "ready_to_start",
  "recording_in_progress",
  "uploading",
  "completed",
  "abandoned",
  "failed"
] as const;

export const microphonePermissionStates = [
  "not_requested",
  "requesting",
  "granted",
  "denied",
  "unavailable"
] as const;

export const screenPermissionStates = [
  "not_requested",
  "requesting",
  "granted",
  "denied",
  "cancelled",
  "unavailable"
] as const;

export const recordingStates = [
  "not_started",
  "starting",
  "active",
  "stopping",
  "stopped",
  "failed"
] as const;

export const uploadStates = [
  "not_started",
  "pending",
  "in_progress",
  "complete",
  "failed"
] as const;

export const transcriptStates = [
  "not_requested",
  "queued",
  "processing",
  "complete",
  "failed"
] as const;

/**
 * The runtime statuses that mean the participant has ANSWERED and the run is
 * closed to a fresh attempt: a completed session, or one whose recording is
 * still uploading. Native surveys never upload, but the status set is shared
 * with recorded runs, so the gate must cover both.
 *
 * Pinned here as the single source for the "already answered" question, which
 * three call sites ask independently and must never disagree on:
 *   - the survey-session mint gate, which refuses a second attempt (409);
 *   - the participant detail read, which surfaces the completion trace;
 *   - the participant listing read, which marks the home row Completed.
 * A test pins the exact membership as a literal (state-model.test.ts).
 */
export const answeredRuntimeStates = ["completed", "uploading"] as const;

export function isAnsweredRuntimeStatus(status: string): boolean {
  return (answeredRuntimeStates as readonly string[]).includes(status);
}

/**
 * The runtime statuses that mean the participant's session died WITHOUT
 * being answered: `abandoned` (the participant walked away) and `failed`
 * (the runtime gave up). Neither has a transition back to `completed` -
 * `applyRuntimeMutationToSession` carries none - so a session in either of
 * these is not a candidate to resume, only a fact that a previous attempt did
 * not finish.
 *
 * Distinct from `answeredRuntimeStates`: those are DONE (refuse a fresh
 * attempt outright, 409); these are DEAD (a fresh attempt is exactly right,
 * the same as if the participant had never started). See
 * `isInFlightRuntimeSession`, which is neither of these plus the expiry check
 * no status value carries.
 */
export const terminalUnansweredRuntimeStates = ["abandoned", "failed"] as const;

/**
 * Whether a runtime session is a live, resumable, IN-FLIGHT attempt
 * (cto/AdaptaLabs#129, LOW-8): not yet answered, not dead (terminal without
 * ever being answered), and not past its own session token's expiry.
 *
 * The single definition every caller that needs to tell "still going" from
 * "a dead link" shares, so none of them can drift from each other:
 *   - the survey-session mint route's resume lookup, which now returns the
 *     existing session_url only for one of these, rather than for ANY
 *     unanswered row whatever its age or status;
 *   - the participant detail read's `completion.inProgress`, and the
 *     closed-study 200-vs-410 decision that reads it.
 * Both reach it through `findParticipantSessionForOpportunity`, the one query
 * that produces `sessionNotExpired` - see that function's docblock for why
 * the flag is read from the session's PAYLOAD rather than the
 * `runtime_sessions.expires_at` ROW COLUMN.
 *
 * Before this existed, ANY unanswered row - an abandoned session from months
 * ago, one whose 24-hour token expired the day it was minted - was handed
 * back as the same "resume" link forever, and the participant behind it could
 * never mint a fresh attempt either.
 */
export function isInFlightRuntimeSession(input: {
  sessionStatus: string;
  sessionNotExpired: boolean;
}): boolean {
  if (isAnsweredRuntimeStatus(input.sessionStatus)) {
    return false;
  }
  if ((terminalUnansweredRuntimeStates as readonly string[]).includes(input.sessionStatus)) {
    return false;
  }
  return input.sessionNotExpired;
}

export type SessionLifecycleState = (typeof sessionLifecycleStates)[number];
export type MicrophonePermissionState =
  (typeof microphonePermissionStates)[number];
export type ScreenPermissionState = (typeof screenPermissionStates)[number];
export type RecordingState = (typeof recordingStates)[number];
export type UploadState = (typeof uploadStates)[number];
export type TranscriptState = (typeof transcriptStates)[number];

export type RuntimeStateSnapshot = {
  session_status: SessionLifecycleState;
  microphone_permission: MicrophonePermissionState;
  screen_permission: ScreenPermissionState;
  recording_status: RecordingState;
  upload_status: UploadState;
  transcript_status: TranscriptState;
  session_access: "token_link";
};

export const initialRuntimeState: RuntimeStateSnapshot = {
  session_status: "link_opened",
  microphone_permission: "not_requested",
  screen_permission: "not_requested",
  recording_status: "not_started",
  upload_status: "not_started",
  transcript_status: "not_requested",
  session_access: "token_link"
};
