import {
  processPendingRecordingUploadCleanup,
  processQueuedTranscriptJobs
} from './runtime-repository-postgres';
import { logger } from '../utils/logger';

// Folds FirstHand's maintenance cron into Cortex. FirstHand ran a daily job
// (vercel.json `/api/internal/maintenance`, and the in-process
// maintenance-scheduler on Kubera) that drained three queues. Two of them move
// here: the transcript backstop (finalize already generates transcripts inline
// best-effort, so this only reprocesses jobs left `queued` by a transient
// failure) and the stale-upload reaper. The third, the outbound HMAC callback
// outbox, has been removed entirely: internalised sessions carry no callback_url
// so nothing was ever enqueued, and the HMAC delivery hop is now retired.

const DEFAULT_TRANSCRIPT_LIMIT = 5;
const DEFAULT_UPLOAD_CLEANUP_LIMIT = 20;

export type MaintenanceSummary = {
  transcript: unknown;
  uploadCleanup: unknown;
};

export type MaintenanceDeps = {
  processTranscripts?: (limit: number) => Promise<unknown>;
  processUploadCleanup?: (limit: number) => Promise<unknown>;
  transcriptLimit?: number;
  uploadCleanupLimit?: number;
};

async function runIsolated(
  label: string,
  job: () => Promise<unknown>
): Promise<unknown> {
  try {
    return await job();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[firsthand] ${label} maintenance failed`, { error: message });
    return { error: message };
  }
}

/**
 * Run the FirstHand maintenance jobs once. Best-effort and crash-proof: each job
 * is isolated so one failing never stops the other, and the runner itself never
 * throws — a cron tick must not take the process down. Jobs are injectable for
 * testing; production uses the runtime-repository implementations.
 */
export async function runFirstHandMaintenance(
  deps: MaintenanceDeps = {}
): Promise<MaintenanceSummary> {
  const processTranscripts = deps.processTranscripts ?? processQueuedTranscriptJobs;
  const processUploadCleanup =
    deps.processUploadCleanup ?? processPendingRecordingUploadCleanup;
  const transcriptLimit = deps.transcriptLimit ?? DEFAULT_TRANSCRIPT_LIMIT;
  const uploadCleanupLimit = deps.uploadCleanupLimit ?? DEFAULT_UPLOAD_CLEANUP_LIMIT;

  const [transcript, uploadCleanup] = await Promise.all([
    runIsolated('transcript', () => processTranscripts(transcriptLimit)),
    runIsolated('upload-cleanup', () => processUploadCleanup(uploadCleanupLimit))
  ]);

  const summary: MaintenanceSummary = { transcript, uploadCleanup };
  logger.info('[firsthand] maintenance run complete', { ...summary });
  return summary;
}
