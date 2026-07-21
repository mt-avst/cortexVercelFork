import { z } from "zod";

import { buildSignedAssetMediaUrl } from "./integration-auth";
import type {
  ParticipantResponseRecord,
  RecordingAssetRecord,
  RuntimeSessionRecord,
  TranscriptRecord
} from "./runtime-records";
import { sessionLifecycleStates, transcriptStates } from "./state-model";

const outputStepResponseSchema = z.object({
  text: z.string().nullable(),
  selected_option: z.string().nullable(),
  saved_at: z.string().datetime()
});

const outputStepSchema = z.object({
  step_id: z.string().min(1),
  order: z.number().int().positive(),
  type: z.string().min(1),
  prompt: z.string().min(1),
  response: outputStepResponseSchema.nullable()
});

const outputTranscriptSegmentSchema = z.object({
  id: z.string().min(1),
  step_id: z.string().min(1).nullable(),
  speaker: z.enum(["system", "participant"]),
  speaker_label: z.string().min(1),
  text: z.string().min(1),
  timestamp: z.string().datetime()
});

const outputTranscriptSchema = z.object({
  body: z.string().min(1),
  created_at: z.string().datetime(),
  source: z.string().min(1),
  segments: z.array(outputTranscriptSegmentSchema).min(1)
});

const outputAssetSchema = z.object({
  asset_id: z.string().min(1),
  file_name: z.string().min(1),
  mime_type: z.string().min(1),
  file_size_bytes: z.number().int().nonnegative(),
  duration_seconds: z.number().nonnegative().nullable(),
  uploaded_at: z.string().datetime(),
  media_url: z.string().url().nullable()
});

const outputAttemptSchema = z.object({
  attempt_number: z.number().int().positive(),
  session_id: z.string().min(1),
  session_status: z.enum(sessionLifecycleStates),
  started_at: z.string().datetime().nullable(),
  completed_at: z.string().datetime().nullable(),
  transcript_status: z.enum(transcriptStates)
});

export const sessionOutputsSchema = z.object({
  contract_version: z.literal("1.0"),
  session: z.object({
    session_id: z.string().min(1),
    logical_session_id: z.string().min(1),
    attempt_number: z.number().int().positive(),
    study_id: z.string().min(1),
    study_title: z.string().min(1),
    participant: z.object({
      participant_id: z.string().min(1),
      display_name: z.string().min(1)
    }),
    session_status: z.enum(sessionLifecycleStates),
    started_at: z.string().datetime().nullable(),
    completed_at: z.string().datetime().nullable(),
    transcript_status: z.enum(transcriptStates),
    transcript_failure_message: z.string().nullable()
  }),
  attempts: z.array(outputAttemptSchema).min(1),
  steps: z.array(outputStepSchema),
  transcript: outputTranscriptSchema.nullable(),
  assets: z.array(outputAssetSchema)
});

export type SessionOutputs = z.infer<typeof sessionOutputsSchema>;

function findLatestResponseForStep(
  responses: ParticipantResponseRecord[],
  stepId: string
): ParticipantResponseRecord | null {
  const matching = responses.filter((response) => response.stepId === stepId);

  if (matching.length === 0) {
    return null;
  }

  return matching.reduce((latest, candidate) =>
    candidate.savedAt > latest.savedAt ? candidate : latest
  );
}

function buildSteps(
  session: RuntimeSessionRecord
): SessionOutputs["steps"] {
  const orderedSteps = [...session.steps].sort(
    (left, right) => left.order - right.order
  );

  return orderedSteps.map((step) => {
    const response = findLatestResponseForStep(session.responses, step.stepId);

    return {
      step_id: step.stepId,
      order: step.order,
      type: step.type,
      prompt: step.prompt,
      response: response
        ? {
            text: response.responsePayload.text ?? null,
            selected_option: response.responsePayload.selectedOption ?? null,
            saved_at: response.savedAt
          }
        : null
    };
  });
}

function buildTranscript(
  transcript: TranscriptRecord | null
): SessionOutputs["transcript"] {
  if (!transcript) {
    return null;
  }

  return {
    body: transcript.body,
    created_at: transcript.createdAt,
    source: transcript.source,
    segments: transcript.segments.map((segment) => ({
      id: segment.id,
      step_id: segment.stepId,
      speaker: segment.speaker,
      speaker_label: segment.speakerLabel,
      text: segment.text,
      timestamp: segment.timestamp
    }))
  };
}

export type MediaUrlContext = {
  baseUrl: string;
  secret: string;
  now?: Date;
};

export function isPlayableMimeType(mimeType: string): boolean {
  return mimeType.startsWith("video/") || mimeType.startsWith("audio/");
}

function buildAssets(
  assets: RecordingAssetRecord[],
  mediaUrl: MediaUrlContext | null
): SessionOutputs["assets"] {
  return assets.map((asset) => ({
    asset_id: asset.id,
    file_name: asset.fileName,
    mime_type: asset.mimeType,
    file_size_bytes: asset.fileSizeBytes,
    duration_seconds: asset.durationSeconds,
    uploaded_at: asset.uploadedAt,
    // Only mint a playable URL when we can both sign it and the asset is audio/video.
    // Anything else falls back to metadata-only (media_url: null) in the reviewer UI.
    media_url:
      mediaUrl && isPlayableMimeType(asset.mimeType)
        ? buildSignedAssetMediaUrl({
            baseUrl: mediaUrl.baseUrl,
            sessionId: asset.sessionId,
            assetId: asset.id,
            secret: mediaUrl.secret,
            now: mediaUrl.now
          })
        : null
  }));
}

function buildAttempts(
  attempts: RuntimeSessionRecord[]
): SessionOutputs["attempts"] {
  return [...attempts]
    .sort((left, right) => right.attemptNumber - left.attemptNumber)
    .map((attempt) => ({
      attempt_number: attempt.attemptNumber,
      session_id: attempt.sessionId,
      session_status: attempt.sessionStatus,
      started_at: attempt.startedAt,
      completed_at: attempt.completedAt,
      transcript_status: attempt.transcriptStatus
    }));
}

export function buildSessionOutputs(
  session: RuntimeSessionRecord,
  attempts: RuntimeSessionRecord[],
  options?: { mediaUrl?: MediaUrlContext | null }
): SessionOutputs {
  return {
    contract_version: "1.0",
    session: {
      session_id: session.sessionId,
      logical_session_id: session.logicalSessionId,
      attempt_number: session.attemptNumber,
      study_id: session.studyId,
      study_title: session.studyTitle,
      participant: {
        participant_id: session.participantId,
        display_name: session.participantDisplayName
      },
      session_status: session.sessionStatus,
      started_at: session.startedAt,
      completed_at: session.completedAt,
      transcript_status: session.transcriptStatus,
      transcript_failure_message: session.transcriptFailureMessage
    },
    attempts: buildAttempts(attempts),
    steps: buildSteps(session),
    transcript: buildTranscript(session.transcript),
    assets: buildAssets(session.assets, options?.mediaUrl ?? null)
  };
}
