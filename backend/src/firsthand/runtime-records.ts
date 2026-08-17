import { z } from "zod";

import { stepTypeSchema } from "../../../shared/firsthand/contract";
import { surveyAnswerSchema } from "../../../shared/firsthand/survey-answers";
import {
  sessionLifecycleStates,
  transcriptStates
} from "./state-model";

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

export const runtimeEventTypeSchema = z.enum(runtimeEventTypes);

// The shared schema is the single description of an answer's shape - the
// client type and this record schema both derive from it, so the two cannot
// drift apart again. (They did: the survey feature taught the client to send
// `selectedOptions` and `rating` while this schema still knew only the
// recorded flow's two fields, and zod's default key-stripping turned every
// multi_choice, rating and nps answer into `{}` on write - accepted with 200,
// stored empty, unrecoverable.)
export const responsePayloadSchema = surveyAnswerSchema;

export const runtimeEventRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  stepId: z.string().min(1).optional(),
  eventType: runtimeEventTypeSchema,
  timestamp: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const participantResponseRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  stepId: z.string().min(1),
  stepType: stepTypeSchema,
  responsePayload: responsePayloadSchema.strict(),
  savedAt: z.string().datetime()
});

export const recordingPermissionStateSchema = z.enum([
  "not_requested",
  "requesting",
  "granted",
  "denied",
  "cancelled",
  "unavailable"
]);

export const assetStorageProviderSchema = z.enum([
  "filesystem",
  "vercel_blob",
  "s3"
]);

export const recordingAssetRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  fileSizeBytes: z.number().int().nonnegative(),
  durationSeconds: z.number().nonnegative().nullable(),
  storageProvider: assetStorageProviderSchema.default("filesystem"),
  relativePath: z.string().min(1),
  uploadedAt: z.string().datetime(),
  objectUrl: z.string().url().optional()
});

export const pendingRecordingUploadRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  token: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  storageProvider: assetStorageProviderSchema,
  relativePath: z.string().min(1),
  createdAt: z.string().datetime(),
  validUntil: z.string().datetime()
});

export const transcriptSegmentRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  stepId: z.string().min(1).nullable(),
  speaker: z.enum(["system", "participant"]),
  speakerLabel: z.string().min(1),
  text: z.string().min(1),
  timestamp: z.string().datetime()
});

export const transcriptRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  body: z.string().min(1),
  createdAt: z.string().datetime(),
  source: z.enum(["prototype_generated"]),
  storageProvider: assetStorageProviderSchema.optional(),
  artifactPath: z.string().min(1).optional(),
  artifactUrl: z.string().url().optional(),
  segments: z.array(transcriptSegmentRecordSchema).min(1)
});

export const runtimeSessionRecordSchema = z
  .object({
    sessionId: z.string().min(1),
    logicalSessionId: z.string().min(1).optional(),
    attemptNumber: z.number().int().positive().optional(),
    token: z.string().min(1),
    studyId: z.string().min(1),
    studyTitle: z.string().min(1),
    participantId: z.string().min(1),
    participantDisplayName: z.string().min(1),
    sessionStatus: z.enum(sessionLifecycleStates),
    transcriptStatus: z.enum(transcriptStates),
    microphonePermission: recordingPermissionStateSchema,
    screenPermission: recordingPermissionStateSchema,
    recordingStatus: z.enum([
      "not_started",
      "starting",
      "active",
      "stopping",
      "stopped",
      "failed"
    ]),
    uploadStatus: z.enum([
      "not_started",
      "pending",
      "in_progress",
      "complete",
      "failed"
    ]),
    currentStepId: z.string().min(1).nullable(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    transcript: transcriptRecordSchema.nullable(),
    transcriptFailureMessage: z.string().nullable(),
    steps: z
      .array(
        z.object({
          stepId: z.string().min(1),
          order: z.number().int().positive(),
          type: stepTypeSchema,
          prompt: z.string().min(1)
        })
      )
      .min(1),
    events: z.array(runtimeEventRecordSchema),
    responses: z.array(participantResponseRecordSchema),
    assets: z.array(recordingAssetRecordSchema)
  })
  .transform((session) => ({
    ...session,
    attemptNumber: session.attemptNumber ?? 1,
    logicalSessionId: session.logicalSessionId ?? session.sessionId
  }));

export const callbackDeliveryRecordSchema = z.object({
  deliveryId: z.string().min(1),
  callbackUrl: z.string().url(),
  body: z.string().min(1),
  event: z.string().min(1),
  logicalSessionId: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string().datetime(),
  lastError: z.string().nullable().default(null),
  deliveredAt: z.string().datetime().nullable().default(null),
  abandonedAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime()
});

export const runtimeStoreSchema = z.object({
  pendingRecordingUploads: z
    .array(pendingRecordingUploadRecordSchema)
    .default([]),
  callbackOutbox: z.array(callbackDeliveryRecordSchema).default([]),
  sessions: z.record(z.string(), runtimeSessionRecordSchema)
});

export const runtimeMutationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("event"),
    eventType: runtimeEventTypeSchema,
    stepId: z.string().min(1).optional(),
    timestamp: z.string().datetime().optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({
    type: z.literal("response"),
    stepId: z.string().min(1),
    stepType: stepTypeSchema,
    // Strict at the mutation boundary only: an unknown key in a submission is
    // client/schema drift and must 422, not be silently stripped. Stored
    // records stay lenient so a historical row with an extra key still loads.
    responsePayload: responsePayloadSchema.strict(),
    savedAt: z.string().datetime().optional()
  }),
  z.object({
    type: z.literal("recording_state"),
    microphonePermission: recordingPermissionStateSchema.optional(),
    screenPermission: recordingPermissionStateSchema.optional(),
    recordingStatus: z
      .enum(["not_started", "starting", "active", "stopping", "stopped", "failed"])
      .optional(),
    uploadStatus: z
      .enum(["not_started", "pending", "in_progress", "complete", "failed"])
      .optional()
  })
]);

export type RuntimeEventType = (typeof runtimeEventTypes)[number];
export type RuntimeEventRecord = z.infer<typeof runtimeEventRecordSchema>;
export type ParticipantResponseRecord = z.infer<
  typeof participantResponseRecordSchema
>;
export type RecordingAssetRecord = z.infer<typeof recordingAssetRecordSchema>;
export type PendingRecordingUploadRecord = z.infer<
  typeof pendingRecordingUploadRecordSchema
>;
export type TranscriptSegmentRecord = z.infer<typeof transcriptSegmentRecordSchema>;
export type TranscriptRecord = z.infer<typeof transcriptRecordSchema>;
export type RuntimeSessionRecord = z.infer<typeof runtimeSessionRecordSchema>;
export type CallbackDeliveryRecord = z.infer<
  typeof callbackDeliveryRecordSchema
>;
export type RuntimeStore = z.infer<typeof runtimeStoreSchema>;
export type RuntimeMutation = z.infer<typeof runtimeMutationSchema>;
