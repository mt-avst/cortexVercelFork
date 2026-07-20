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
