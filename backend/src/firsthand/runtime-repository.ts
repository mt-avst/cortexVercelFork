import type { SessionPayload } from "../../../shared/firsthand/contract";
import type {
  PendingRecordingUploadRecord,
  RecordingAssetRecord,
  RuntimeMutation,
  RuntimeSessionRecord
} from "./runtime-records";
import {
  applyRuntimeMutationPostgres,
  createFreshRuntimeAttemptPostgres,
  findParticipantCompletionsForOpportunitiesPostgres,
  findParticipantSessionForOpportunityPostgres,
  getRuntimeAssetPostgres,
  getRuntimeSessionPostgres,
  listRuntimeSessionAttemptsPostgres,
  listRuntimeSessionsForStudyPostgres,
  enqueueCallbackDeliveryPostgres,
  processDueCallbackDeliveriesPostgres,
  processPendingRecordingUploadCleanupPostgres,
  processTranscriptGenerationPostgres,
  processQueuedTranscriptJobsPostgres,
  resetRuntimeSessionPostgres,
  registerPendingRecordingUploadPostgres,
  resolvePendingRecordingUploadPostgres,
  queueTranscriptGenerationPostgres,
  saveUploadedRecordingAssetPostgres,
  seedRuntimeSessionPostgres
} from "./runtime-repository-postgres";
import type { EnqueueCallbackDeliveryInput } from "./callback-delivery";

// The unified product persists the firsthand runtime in postgres only. FirstHand's
// filesystem-legacy persistence path is excised in the merge (external-first: the
// pool points at FirstHand's live RDS, then Cortex's RDS after Phase C), so this
// facade dispatches straight to the postgres implementation.

export async function seedRuntimeSession(payload: SessionPayload) {
  return seedRuntimeSessionPostgres(payload);
}

export async function createFreshRuntimeAttempt(payload: SessionPayload) {
  return createFreshRuntimeAttemptPostgres(payload);
}

export async function applyRuntimeMutation(
  payload: SessionPayload,
  mutation: RuntimeMutation,
  input?: {
    attemptNumber?: number;
  }
) {
  return applyRuntimeMutationPostgres(payload, mutation, input);
}

export async function resetRuntimeSession(payload: SessionPayload) {
  return resetRuntimeSessionPostgres(payload);
}

export async function findParticipantSessionForOpportunity(input: {
  opportunityId: string;
  participantId: string;
}) {
  return findParticipantSessionForOpportunityPostgres(input);
}

export async function findParticipantCompletionsForOpportunities(input: {
  participantId: string;
  opportunityIds: readonly string[];
}) {
  return findParticipantCompletionsForOpportunitiesPostgres(input);
}

export async function getRuntimeSession(
  sessionId: string,
  input?: {
    attemptNumber?: number;
  }
) {
  return getRuntimeSessionPostgres(sessionId, input);
}

export async function listRuntimeSessionAttempts(logicalSessionId: string) {
  return listRuntimeSessionAttemptsPostgres(logicalSessionId);
}

export async function listRuntimeSessionsForStudy(input: {
  studyId: string;
  sessionStatus?: RuntimeSessionRecord["sessionStatus"] | "all";
  transcriptStatus?: RuntimeSessionRecord["transcriptStatus"] | "all";
}) {
  return listRuntimeSessionsForStudyPostgres(input);
}

export async function getRuntimeAsset(
  sessionId: string,
  assetId: string
): Promise<RecordingAssetRecord | null> {
  const direct = await getRuntimeAssetPostgres(sessionId, assetId);

  return direct ?? findAssetAcrossAttempts(sessionId, assetId);
}

// Attempt 1's own sessionId is also the logical session id, so resolving that id lands on
// the latest attempt and an older attempt's recording looks missing. Reviewers can open any
// attempt, so search the whole attempt history before reporting the asset as gone. The
// caller's signature binds the assetId and the search never leaves this logical session, so
// this widens reach across attempts of one session only.
async function findAssetAcrossAttempts(
  sessionId: string,
  assetId: string
): Promise<RecordingAssetRecord | null> {
  const session = await getRuntimeSession(sessionId);

  if (!session) {
    return null;
  }

  const attempts = await listRuntimeSessionAttempts(session.logicalSessionId);

  for (const attempt of attempts) {
    const asset = attempt.assets.find((item) => item.id === assetId);

    if (asset) {
      return asset;
    }
  }

  return null;
}

export async function saveUploadedRecordingAsset(input: {
  payload: SessionPayload;
  attemptNumber?: number;
  sessionId?: string;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  durationSeconds: number | null;
  objectUrl?: string;
  relativePath: string;
  storageProvider: RecordingAssetRecord["storageProvider"];
}) {
  return saveUploadedRecordingAssetPostgres(input);
}

export async function registerPendingRecordingUpload(
  payload: SessionPayload,
  input: {
    attemptNumber?: number;
    fileName: string;
    mimeType: string;
    relativePath: string;
    storageProvider: PendingRecordingUploadRecord["storageProvider"];
    validUntil: string;
  }
) {
  return registerPendingRecordingUploadPostgres(payload, input);
}

export async function resolvePendingRecordingUpload(input: {
  relativePath: string;
  storageProvider: PendingRecordingUploadRecord["storageProvider"];
}) {
  return resolvePendingRecordingUploadPostgres(input);
}

export async function queueTranscriptGeneration(sessionId: string) {
  return queueTranscriptGenerationPostgres(sessionId);
}

export async function processTranscriptGeneration(sessionId: string) {
  return processTranscriptGenerationPostgres(sessionId);
}

export async function processQueuedTranscriptJobs(limit = 1) {
  return processQueuedTranscriptJobsPostgres(limit);
}

export async function processPendingRecordingUploadCleanup(limit = 10) {
  return processPendingRecordingUploadCleanupPostgres(limit);
}

export async function enqueueCallbackDelivery(input: EnqueueCallbackDeliveryInput) {
  return enqueueCallbackDeliveryPostgres(input);
}

export async function processDueCallbackDeliveries(limit = 20) {
  return processDueCallbackDeliveriesPostgres(limit);
}
