// The runtime event vocabulary the participant browser emits. This is the
// client-side subset of FirstHand's runtime-records contract - only the event
// type union is needed here; the persisted record/mutation zod schemas live in
// the backend (`backend/src/firsthand/runtime-records.ts`).
export const runtimeEventTypes = [
  "link_opened",
  "consent_accepted",
  "consent_declined",
  "setup_started",
  "setup_completed",
  "session_started",
  "recording_started",
  "recording_stopped",
  "recording_failed",
  "step_entered",
  "response_submitted",
  "step_exited",
  "upload_started",
  "upload_completed",
  "upload_failed",
  "transcript_queued",
  "transcript_started",
  "transcript_completed",
  "transcript_failed",
  "session_completed",
  "session_failed",
  "session_abandoned"
] as const;

export type RuntimeEventType = (typeof runtimeEventTypes)[number];
