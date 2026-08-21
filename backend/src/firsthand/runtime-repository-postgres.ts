
import type { PoolClient } from "pg";

import type { SessionPayload } from "../../../shared/firsthand/contract";
import { ConflictError } from "../../../shared/types";
import type {
  PendingRecordingUploadRecord,
  ParticipantResponseRecord,
  RecordingAssetRecord,
  RuntimeEventRecord,
  RuntimeMutation,
  RuntimeSessionRecord
} from "./runtime-records";
import {
  applyRuntimeMutationToSession,
  buildRuntimeAttemptSessionId,
  cloneRuntimeSession,
  createRuntimeSessionAttempt,
  createRuntimeSessionRecord,
  findRuntimeSessionAttempts,
  pushInternalEvent,
  resolveSessionSortTimestamp
} from "./runtime-session-model";
import {
  deleteStoredObject,
  storeTranscriptArtifact
} from "./object-storage";
import { withRuntimeDatabaseClient } from "./runtime-database";
import {
  computeNextAttemptAtMs,
  createEmptyCallbackDeliverySummary,
  deliverSignedCallback,
  CALLBACK_DELIVERY_MAX_ATTEMPTS
} from "./callback-delivery";
import type { EnqueueCallbackDeliveryInput } from "./callback-delivery";
import { getIntegrationSharedSecret } from "./integration-auth";
import { buildPrototypeTranscript } from "./transcript-generator";

type RuntimeSessionRow = {
  session_id: string;
  logical_session_id: string;
  attempt_number: number;
  token: string;
  study_id: string;
  study_title: string;
  participant_id: string;
  participant_display_name: string;
  session_status: RuntimeSessionRecord["sessionStatus"];
  transcript_status: RuntimeSessionRecord["transcriptStatus"];
  microphone_permission: RuntimeSessionRecord["microphonePermission"];
  screen_permission: RuntimeSessionRecord["screenPermission"];
  recording_status: RuntimeSessionRecord["recordingStatus"];
  upload_status: RuntimeSessionRecord["uploadStatus"];
  current_step_id: string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  transcript: RuntimeSessionRecord["transcript"] | null;
  transcript_failure_message: string | null;
  steps: RuntimeSessionRecord["steps"];
};

type RuntimeEventRow = {
  id: string;
  session_id: string;
  step_id: string | null;
  event_type: RuntimeEventRecord["eventType"];
  timestamp: Date | string;
  metadata: RuntimeEventRecord["metadata"];
};

type ParticipantResponseRow = {
  id: string;
  session_id: string;
  step_id: string;
  step_type: ParticipantResponseRecord["stepType"];
  response_payload: ParticipantResponseRecord["responsePayload"];
  saved_at: Date | string;
};

type RecordingAssetRow = {
  id: string;
  session_id: string;
  file_name: string;
  mime_type: string;
  file_size_bytes: number | string;
  duration_seconds: number | null;
  storage_provider: RecordingAssetRecord["storageProvider"];
  relative_path: string;
  object_url: string | null;
  uploaded_at: Date | string;
};

type PendingRecordingUploadRow = {
  id: string;
  session_id: string;
  token: string;
  file_name: string;
  mime_type: string;
  storage_provider: PendingRecordingUploadRecord["storageProvider"];
  relative_path: string;
  created_at: Date | string;
  valid_until: Date | string;
};

export async function seedRuntimeSessionPostgres(payload: SessionPayload) {
  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      await ensureRuntimeSessionRow(client, payload);
      const session = await getLatestRuntimeSessionForLogicalSessionId(
        client,
        payload.session.session_id
      );

      await client.query("COMMIT");

      if (!session) {
        throw new Error("Runtime session could not be loaded after seeding.");
      }

      return session;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function createFreshRuntimeAttemptPostgres(payload: SessionPayload) {
  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      const session = await insertRuntimeSessionAttemptRow(client, payload);

      await client.query("COMMIT");
      return session;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

/**
 * Session states after which an answer may no longer be changed.
 *
 * `uploading` is deliberately NOT here. For a survey it does mean finished, and
 * the mint route treats it that way - but for a recorded session it means the
 * tasks are done and the video is still going up, and refusing writes during it
 * would be a new failure mode on a live recording for no gain.
 */
const FINISHED_SESSION_STATES = new Set(["completed", "abandoned", "failed"]);

/**
 * Refuses to rewrite an answer once the session is over.
 *
 * `persistRuntimeSession` stores responses by deleting every LIVE row for the
 * session and reinserting the current set, so a later submission does not
 * supersede the earlier answer - it ERASES it, leaving nothing that says the
 * answer ever differed. A researcher who reads their results twice could see
 * two different findings with no record of a change between them, which is a
 * problem about the trustworthiness of the finding rather than about the data.
 *
 * Enforced HERE, inside the row lock, rather than at the route. The route would
 * have to read the status in a separate statement, and two submissions arriving
 * together would both read "not finished" and both write. The `FOR UPDATE`
 * above is what makes this decision hold under concurrency - the same reason
 * the study-kind re-check in phase 4c sits inside its lock.
 *
 * Only responses. Events must still be accepted: `session_completed` itself is
 * an event, and so are the abandonment and failure events that put a session
 * into these states in the first place - refusing those would make the terminal
 * states unreachable.
 */
function refuseAnswerToFinishedSession(
  session: { sessionStatus: string },
  mutation: RuntimeMutation
): void {
  if (mutation.type !== "response") {
    return;
  }

  if (!FINISHED_SESSION_STATES.has(session.sessionStatus)) {
    return;
  }

  throw new ConflictError("This session has finished and its answers can no longer be changed.");
}

export async function applyRuntimeMutationPostgres(
  payload: SessionPayload,
  mutation: RuntimeMutation,
  input?: {
    attemptNumber?: number;
  }
) {
  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      await ensureRuntimeSessionRow(client, payload);
      const selectedSession = input?.attemptNumber
        ? await getRuntimeSessionByLogicalAttempt(
            client,
            payload.session.session_id,
            input.attemptNumber
          )
        : await getCurrentRuntimeSessionForPayload(client, payload, {
            forUpdate: true
          });
      const session =
        selectedSession && input?.attemptNumber
          ? await getRuntimeSessionForUpdate(client, selectedSession.sessionId)
          : selectedSession;

      if (!session) {
        throw new Error("Runtime session could not be loaded for mutation.");
      }

      refuseAnswerToFinishedSession(session, mutation);

      applyRuntimeMutationToSession(session, mutation);
      await persistRuntimeSession(client, session);
      await client.query("COMMIT");

      return session;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function resetRuntimeSessionPostgres(payload: SessionPayload) {
  const { cleanupTargets, session } = await withRuntimeDatabaseClient(
    async (client) => {
      await client.query("BEGIN");

      try {
        const existingSessions = await listRuntimeSessionAttemptsByLogicalSessionId(
          client,
          payload.session.session_id
        );
        const pendingUploadRows = await client.query<PendingRecordingUploadRow>(
          `
            SELECT id, session_id, token, file_name, mime_type,
                   storage_provider, relative_path, created_at, valid_until
            FROM pending_recording_uploads
            WHERE session_id = ANY(
              SELECT session_id
              FROM runtime_sessions
              WHERE logical_session_id = $1
            )
          `,
          [payload.session.session_id]
        );

        await client.query(
          `
            DELETE FROM runtime_sessions
            WHERE logical_session_id = $1
          `,
          [payload.session.session_id]
        );

        await ensureRuntimeSessionRow(client, payload);
        const session = await getLatestRuntimeSessionForLogicalSessionId(
          client,
          payload.session.session_id
        );

        await client.query("COMMIT");

        if (!session) {
          throw new Error("Runtime session could not be loaded after reset.");
        }

        return {
          cleanupTargets: collectRuntimeCleanupTargets(
            existingSessions,
            pendingUploadRows.rows.map(mapPendingRecordingUploadRow)
          ),
          session
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  );

  await deleteRuntimeCleanupTargets(cleanupTargets);

  return session;
}

/**
 * The session this participant already has for this opportunity, if any.
 *
 * Exists because minting is otherwise a multiplier on the results. Every mint
 * creates a runtime_sessions row, and the results aggregation counts one
 * respondent per session - so an ordinary employee pressing Start repeatedly
 * could move a poll's numbers as far as they liked, with each fake respondent
 * indistinguishable from a real one. Proven end to end before this existed:
 * three extra mints took a rating question from 3 respondents to 6.
 *
 * That is a survey problem specifically. Sixty junk recorded sessions are
 * obvious to whoever reviews them; sixty junk poll votes are just a number.
 *
 * Returns the most recent, so a participant who abandoned a survey and came
 * back resumes rather than starting again - which is also why the completed
 * case is answered here rather than filtered out: the route needs to tell the
 * two apart.
 */
export async function findParticipantSessionForOpportunityPostgres(input: {
  opportunityId: string;
  participantId: string;
}): Promise<{ token: string; sessionStatus: string } | null> {
  return withRuntimeDatabaseClient(async (client) => {
    const result = await client.query<{
      token: string;
      session_status: string;
    }>(
      `
        SELECT token, session_status
        FROM runtime_sessions
        WHERE opportunity_id = $1
          AND participant_id = $2
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [input.opportunityId, input.participantId]
    );

    const row = result.rows[0];
    return row ? { token: row.token, sessionStatus: row.session_status } : null;
  });
}

export async function getRuntimeSessionPostgres(
  sessionId: string,
  input?: {
    attemptNumber?: number;
  }
) {
  return withRuntimeDatabaseClient((client) =>
    getRuntimeSessionByReference(client, sessionId, input)
  );
}

export async function listRuntimeSessionAttemptsPostgres(logicalSessionId: string) {
  return withRuntimeDatabaseClient((client) =>
    listRuntimeSessionAttemptsByLogicalSessionId(client, logicalSessionId)
  );
}

export async function listRuntimeSessionsForStudyPostgres(input: {
  studyId: string;
  sessionStatus?: RuntimeSessionRecord["sessionStatus"] | "all";
  transcriptStatus?: RuntimeSessionRecord["transcriptStatus"] | "all";
}) {
  return withRuntimeDatabaseClient(async (client) => {
    const conditions = ["study_id = $1"];
    const values: Array<string> = [input.studyId];

    if (input.sessionStatus && input.sessionStatus !== "all") {
      values.push(input.sessionStatus);
      conditions.push(`session_status = $${values.length}`);
    }

    if (input.transcriptStatus && input.transcriptStatus !== "all") {
      values.push(input.transcriptStatus);
      conditions.push(`transcript_status = $${values.length}`);
    }

    const result = await client.query<{ session_id: string }>(
      `
        SELECT session_id
        FROM runtime_sessions
        WHERE ${conditions.join(" AND ")}
        ORDER BY COALESCE(completed_at, started_at, updated_at) DESC, participant_display_name ASC
      `,
      values
    );

    const sessions: Array<RuntimeSessionRecord | null> = [];

    for (const row of result.rows) {
      sessions.push(await getRuntimeSessionById(client, row.session_id));
    }

    return sessions
      .filter((session): session is RuntimeSessionRecord => session !== null)
      .sort((left, right) => {
        const leftTimestamp = resolveSessionSortTimestamp(left);
        const rightTimestamp = resolveSessionSortTimestamp(right);

        if (leftTimestamp !== rightTimestamp) {
          return rightTimestamp - leftTimestamp;
        }

        return left.participantDisplayName.localeCompare(right.participantDisplayName);
      });
  });
}

export async function getRuntimeAssetPostgres(
  sessionId: string,
  assetId: string
): Promise<RecordingAssetRecord | null> {
  return withRuntimeDatabaseClient(async (client) => {
    const result = await client.query<RecordingAssetRow>(
      `
        SELECT id, session_id, file_name, mime_type, file_size_bytes, duration_seconds,
               storage_provider, relative_path, object_url, uploaded_at
        FROM recording_assets
        WHERE session_id = $1 AND id = $2
      `,
      [sessionId, assetId]
    );
    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return mapAssetRow(row);
  });
}

export async function saveUploadedRecordingAssetPostgres(input: {
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
  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      await ensureRuntimeSessionRow(client, input.payload);
      const selectedSession = input.sessionId
        ? await getRuntimeSessionForUpdate(client, input.sessionId)
        : input.attemptNumber
          ? await getRuntimeSessionByLogicalAttempt(
              client,
              input.payload.session.session_id,
              input.attemptNumber
            )
          : await getCurrentRuntimeSessionForPayload(client, input.payload, {
              forUpdate: true
            });
      const session =
        selectedSession && input.attemptNumber && !input.sessionId
          ? await getRuntimeSessionForUpdate(client, selectedSession.sessionId)
          : selectedSession;

      if (!session) {
        throw new Error("Runtime session could not be loaded for asset persistence.");
      }

      const asset: RecordingAssetRecord = {
        id: crypto.randomUUID(),
        sessionId: session.sessionId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        fileSizeBytes: input.fileSizeBytes,
        durationSeconds: input.durationSeconds,
        storageProvider: input.storageProvider,
        relativePath: input.relativePath,
        uploadedAt: new Date().toISOString(),
        objectUrl: input.objectUrl
      };

      session.assets = [
        ...session.assets.filter(
          (existing) =>
            !(
              existing.relativePath === asset.relativePath &&
              existing.storageProvider === asset.storageProvider
            )
        ),
        asset
      ];
      session.uploadStatus = "complete";
      session.recordingStatus = "stopped";

      await persistRuntimeSession(client, session);
      await client.query("COMMIT");

      return asset;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function registerPendingRecordingUploadPostgres(
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
  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      await ensureRuntimeSessionRow(client, payload);
      const selectedSession = input.attemptNumber
        ? await getRuntimeSessionByLogicalAttempt(
            client,
            payload.session.session_id,
            input.attemptNumber
          )
        : await getCurrentRuntimeSessionForPayload(client, payload, {
            forUpdate: true
          });
      const session =
        selectedSession && input.attemptNumber
          ? await getRuntimeSessionForUpdate(client, selectedSession.sessionId)
          : selectedSession;

      if (!session) {
        throw new Error("Runtime session could not be loaded for pending upload registration.");
      }

      const pendingUpload: PendingRecordingUploadRecord = {
        id: crypto.randomUUID(),
        sessionId: session.sessionId,
        token: payload.session.session_token,
        fileName: input.fileName,
        mimeType: input.mimeType,
        storageProvider: input.storageProvider,
        relativePath: input.relativePath,
        createdAt: new Date().toISOString(),
        validUntil: input.validUntil
      };

      await client.query(
        `
          INSERT INTO pending_recording_uploads (
            id, session_id, token, file_name, mime_type,
            storage_provider, relative_path, created_at, valid_until
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (relative_path) DO UPDATE
          SET token = EXCLUDED.token,
              file_name = EXCLUDED.file_name,
              mime_type = EXCLUDED.mime_type,
              storage_provider = EXCLUDED.storage_provider,
              created_at = EXCLUDED.created_at,
              valid_until = EXCLUDED.valid_until
        `,
        [
          pendingUpload.id,
          pendingUpload.sessionId,
          pendingUpload.token,
          pendingUpload.fileName,
          pendingUpload.mimeType,
          pendingUpload.storageProvider,
          pendingUpload.relativePath,
          pendingUpload.createdAt,
          pendingUpload.validUntil
        ]
      );

      await client.query("COMMIT");
      return pendingUpload;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function resolvePendingRecordingUploadPostgres(input: {
  relativePath: string;
  storageProvider: PendingRecordingUploadRecord["storageProvider"];
}) {
  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      const result = await client.query<PendingRecordingUploadRow>(
        `
          DELETE FROM pending_recording_uploads
          WHERE relative_path = $1 AND storage_provider = $2
          RETURNING id, session_id, token, file_name, mime_type,
                    storage_provider, relative_path, created_at, valid_until
        `,
        [input.relativePath, input.storageProvider]
      );

      await client.query("COMMIT");
      const row = result.rows[0];
      return row ? mapPendingRecordingUploadRow(row) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function queueTranscriptGenerationPostgres(sessionId: string) {
  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      const session = await getRuntimeSessionForUpdate(client, sessionId);

      if (!session) {
        throw new Error("Runtime session could not be loaded for transcript queueing.");
      }

      if (session.assets.length === 0) {
        session.transcriptStatus = "failed";
        session.transcriptFailureMessage =
          "Transcript generation requires an uploaded recording asset.";
        pushInternalEvent(session, "transcript_failed", {
          reason: "missing_asset"
        });
      } else if (
        session.transcriptStatus !== "queued" &&
        session.transcriptStatus !== "processing"
      ) {
        session.transcriptStatus = "queued";
        session.transcriptFailureMessage = null;
        session.transcript = null;
        pushInternalEvent(session, "transcript_queued", {
          source: "review_request"
        });
      }

      await persistRuntimeSession(client, session);
      await client.query("COMMIT");

      return cloneRuntimeSession(session);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function processTranscriptGenerationPostgres(sessionId: string) {
  const claimedSession = await claimTranscriptSessionPostgres({
    sessionId
  });

  if (!claimedSession) {
    throw new Error("Runtime session could not be loaded for transcript processing.");
  }

  return completeClaimedTranscriptSessionPostgres(claimedSession);
}

export async function processQueuedTranscriptJobsPostgres(limit: number) {
  const safeLimit = normalizeTranscriptProcessingLimit(limit);
  const processedSessionIds: string[] = [];

  for (let index = 0; index < safeLimit; index += 1) {
    const claimedSession = await claimTranscriptSessionPostgres();

    if (!claimedSession) {
      break;
    }

    processedSessionIds.push(claimedSession.sessionId);
    await completeClaimedTranscriptSessionPostgres(claimedSession);
  }

  return {
    idle: processedSessionIds.length === 0,
    processedCount: processedSessionIds.length,
    processedSessionIds
  };
}

async function claimTranscriptSessionPostgres(input?: { sessionId?: string }) {
  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      const session = input?.sessionId
        ? await getRuntimeSessionForUpdate(client, input.sessionId)
        : await claimNextQueuedTranscriptSession(client);

      if (!session) {
        await client.query("COMMIT");
        return null;
      }

      if (session.transcriptStatus !== "queued") {
        await client.query("COMMIT");
        return cloneRuntimeSession(session);
      }

      session.transcriptStatus = "processing";
      session.transcriptFailureMessage = null;
      pushInternalEvent(session, "transcript_started", {
        source: "background_processor"
      });

      await persistRuntimeSession(client, session);
      await client.query("COMMIT");

      return cloneRuntimeSession(session);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function completeClaimedTranscriptSessionPostgres(
  claimedSession: RuntimeSessionRecord
) {
  if (claimedSession.transcriptStatus !== "processing") {
    return claimedSession;
  }

  try {
    const prototypeTranscript = buildPrototypeTranscript(claimedSession);
    const transcriptArtifact = await storeTranscriptArtifact({
      body: prototypeTranscript.body,
      sessionId: claimedSession.sessionId
    });
    const transcript = {
      ...prototypeTranscript,
      artifactPath: transcriptArtifact.artifactPath,
      artifactUrl: transcriptArtifact.artifactUrl,
      storageProvider: transcriptArtifact.storageProvider
    };

    return withRuntimeDatabaseClient(async (client) => {
      await client.query("BEGIN");

      try {
        const session = await getRuntimeSessionForUpdate(client, claimedSession.sessionId);

        if (!session) {
          throw new Error("Runtime session could not be loaded for transcript completion.");
        }

        if (
          session.transcriptStatus !== "processing" &&
          session.transcriptStatus !== "queued"
        ) {
          await client.query("COMMIT");
          return cloneRuntimeSession(session);
        }

        session.transcriptStatus = "complete";
        session.transcriptFailureMessage = null;
        session.transcript = transcript;
        pushInternalEvent(session, "transcript_completed", {
          segmentCount: transcript.segments.length,
          source: "background_processor"
        });

        await persistRuntimeSession(client, session);
        await client.query("COMMIT");

        return cloneRuntimeSession(session);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  } catch (error) {
    return withRuntimeDatabaseClient(async (client) => {
      await client.query("BEGIN");

      try {
        const session = await getRuntimeSessionForUpdate(client, claimedSession.sessionId);

        if (!session) {
          throw new Error("Runtime session could not be loaded for transcript failure handling.");
        }

        session.transcriptStatus = "failed";
        session.transcriptFailureMessage =
          error instanceof Error
            ? error.message
            : "Transcript generation failed unexpectedly.";
        pushInternalEvent(session, "transcript_failed", {
          reason: "generation_error",
          source: "background_processor"
        });

        await persistRuntimeSession(client, session);
        await client.query("COMMIT");

        return cloneRuntimeSession(session);
      } catch (rollbackError) {
        await client.query("ROLLBACK");
        throw rollbackError;
      }
    });
  }
}

export async function processPendingRecordingUploadCleanupPostgres(limit: number) {
  const safeLimit = normalizeTranscriptProcessingLimit(limit);

  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      const staleCandidates = await client.query<PendingRecordingUploadRow>(
        `
          SELECT pending.id, pending.session_id, pending.token, pending.file_name, pending.mime_type,
                 pending.storage_provider, pending.relative_path, pending.created_at, pending.valid_until
          FROM pending_recording_uploads AS pending
          WHERE pending.valid_until < NOW() - INTERVAL '15 minutes'
            AND NOT EXISTS (
              SELECT 1
              FROM recording_assets AS assets
              WHERE assets.relative_path = pending.relative_path
                AND assets.storage_provider = pending.storage_provider
            )
          ORDER BY pending.valid_until ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        `,
        [safeLimit]
      );

      const pendingUploads = staleCandidates.rows.map(mapPendingRecordingUploadRow);

      if (pendingUploads.length === 0) {
        await client.query("COMMIT");
        return {
          idle: true,
          processedCount: 0,
          deletedCount: 0,
          deletedPaths: [] as string[]
        };
      }

      await client.query(
        `
          DELETE FROM pending_recording_uploads
          WHERE id = ANY($1::text[])
        `,
        [pendingUploads.map((pendingUpload) => pendingUpload.id)]
      );

      await client.query("COMMIT");

      const deletedPaths: string[] = [];

      for (const pendingUpload of pendingUploads) {
        try {
          await deleteStoredObject({
            relativePath: pendingUpload.relativePath,
            storageProvider: pendingUpload.storageProvider
          });
          deletedPaths.push(pendingUpload.relativePath);
        } catch {
          continue;
        }
      }

      return {
        idle: false,
        processedCount: pendingUploads.length,
        deletedCount: deletedPaths.length,
        deletedPaths
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function ensureRuntimeSessionRow(client: PoolClient, payload: SessionPayload) {
  const existingSession = await getLatestRuntimeSessionForLogicalSessionId(
    client,
    payload.session.session_id
  );

  if (existingSession) {
    return existingSession;
  }

  return insertRuntimeSessionAttemptRow(client, payload);
}

async function insertRuntimeSessionAttemptRow(
  client: PoolClient,
  payload: SessionPayload
) {
  const nextAttemptNumber = await getNextAttemptNumber(
    client,
    payload.session.session_id
  );
  const record = createRuntimeSessionRecord(payload, {
    attemptNumber: nextAttemptNumber,
    sessionId: buildRuntimeAttemptSessionId(
      payload.session.session_id,
      nextAttemptNumber
    )
  });
  const inserted = await client.query<{ session_id: string }>(
    `
      INSERT INTO runtime_sessions (
        session_id, logical_session_id, attempt_number, token, study_id, study_title,
        participant_id, participant_display_name,
        session_status, transcript_status, microphone_permission, screen_permission,
        recording_status, upload_status, current_step_id, started_at, completed_at,
        transcript, transcript_failure_message, steps,
        callback_url, return_url, external_ref, participant_email,
        expires_at, session_payload, opportunity_id,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21, $22, $23, $24,
        $25, $26, $27,
        NOW(), NOW()
      )
      ON CONFLICT (session_id) DO NOTHING
      RETURNING session_id
    `,
    [
      record.sessionId,
      record.logicalSessionId,
      record.attemptNumber,
      record.token,
      record.studyId,
      record.studyTitle,
      record.participantId,
      record.participantDisplayName,
      record.sessionStatus,
      record.transcriptStatus,
      record.microphonePermission,
      record.screenPermission,
      record.recordingStatus,
      record.uploadStatus,
      record.currentStepId,
      record.startedAt,
      record.completedAt,
      record.transcript,
      record.transcriptFailureMessage,
      JSON.stringify(record.steps),
      payload.session.callback_url ?? null,
      payload.session.return_url ?? null,
      payload.participant.external_ref ?? null,
      payload.participant.email ?? null,
      payload.session.expires_at ?? null,
      JSON.stringify(payload),
      // Its own column rather than left to session_payload's JSONB. This is the
      // key the per-opportunity results gate filters and joins on, and a value
      // reachable only by digging into a JSONB blob is not one an index or an
      // authorisation check can rely on.
      payload.session.opportunity_id ?? null
    ]
  );

  if (inserted.rowCount === 1) {
    const seedEvent = record.events[0];

    await client.query(
      `
        INSERT INTO runtime_events (id, session_id, step_id, event_type, timestamp, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        seedEvent.id,
        seedEvent.sessionId,
        seedEvent.stepId ?? null,
        seedEvent.eventType,
        seedEvent.timestamp,
        seedEvent.metadata ? JSON.stringify(seedEvent.metadata) : null
      ]
    );
  }

  return record;
}

async function getRuntimeSessionById(client: PoolClient, sessionId: string) {
  const sessionRows = await client.query<RuntimeSessionRow>(
    `
      SELECT session_id, logical_session_id, attempt_number, token,
             study_id, study_title, participant_id, participant_display_name,
             session_status, transcript_status, microphone_permission, screen_permission,
             recording_status, upload_status, current_step_id, started_at, completed_at,
             transcript, transcript_failure_message, steps
      FROM runtime_sessions
      WHERE session_id = $1
    `,
    [sessionId]
  );
  const sessionRow = sessionRows.rows[0];

  if (!sessionRow) {
    return null;
  }

  const eventRows = await client.query<RuntimeEventRow>(
    `
      SELECT id, session_id, step_id, event_type, timestamp, metadata
      FROM runtime_events
      WHERE session_id = $1
      ORDER BY timestamp ASC, id ASC
    `,
    [sessionId]
  );
  // DETACHED answers are excluded from the live session, and are not lost by
  // it.
  //
  // A NULL step_id means the researcher removed the question after this
  // participant answered it (0015's ON DELETE SET NULL). The runtime record
  // requires a step id on every response - correctly, since it drives which
  // step the runner considers answered - and there is no live step for this one
  // to belong to any more.
  //
  // What keeps it is the matching filter on the DELETE in
  // `persistRuntimeSession`: a detached row is never re-read, and never
  // rewritten, so it stays exactly as the participant left it and remains
  // readable in the results view under the prompt they were shown.
  const responseRows = await client.query<ParticipantResponseRow>(
    `
      SELECT id, session_id, step_id, step_type, response_payload, saved_at
      FROM participant_responses
      WHERE session_id = $1 AND step_id IS NOT NULL
      ORDER BY step_id ASC, saved_at ASC
    `,
    [sessionId]
  );
  const assetRows = await client.query<RecordingAssetRow>(
    `
      SELECT id, session_id, file_name, mime_type, file_size_bytes, duration_seconds,
             storage_provider, relative_path, object_url, uploaded_at
      FROM recording_assets
      WHERE session_id = $1
      ORDER BY uploaded_at ASC, id ASC
    `,
    [sessionId]
  );

  return {
    sessionId: sessionRow.session_id,
    logicalSessionId: sessionRow.logical_session_id,
    attemptNumber: sessionRow.attempt_number,
    token: sessionRow.token,
    studyId: sessionRow.study_id,
    studyTitle: sessionRow.study_title,
    participantId: sessionRow.participant_id,
    participantDisplayName: sessionRow.participant_display_name,
    sessionStatus: sessionRow.session_status,
    transcriptStatus: sessionRow.transcript_status,
    microphonePermission: sessionRow.microphone_permission,
    screenPermission: sessionRow.screen_permission,
    recordingStatus: sessionRow.recording_status,
    uploadStatus: sessionRow.upload_status,
    currentStepId: sessionRow.current_step_id,
    startedAt: toIsoString(sessionRow.started_at),
    completedAt: toIsoString(sessionRow.completed_at),
    transcript: sessionRow.transcript,
    transcriptFailureMessage: sessionRow.transcript_failure_message,
    steps: sessionRow.steps,
    events: eventRows.rows.map(mapEventRow),
    responses: responseRows.rows.map(mapResponseRow),
    assets: assetRows.rows.map(mapAssetRow)
  };
}

async function getRuntimeSessionByReference(
  client: PoolClient,
  sessionIdOrLogicalSessionId: string,
  input?: {
    attemptNumber?: number;
  }
) {
  if (input?.attemptNumber) {
    return getRuntimeSessionByLogicalAttempt(
      client,
      sessionIdOrLogicalSessionId,
      input.attemptNumber
    );
  }

  const latestAttempt = await getLatestRuntimeSessionForLogicalSessionId(
    client,
    sessionIdOrLogicalSessionId
  );

  if (latestAttempt) {
    return latestAttempt;
  }

  return getRuntimeSessionById(client, sessionIdOrLogicalSessionId);
}

async function getRuntimeSessionForUpdate(client: PoolClient, sessionId: string) {
  await client.query(
    `
      SELECT session_id
      FROM runtime_sessions
      WHERE session_id = $1
      FOR UPDATE
    `,
    [sessionId]
  );

  return getRuntimeSessionById(client, sessionId);
}

async function getCurrentRuntimeSessionForPayload(
  client: PoolClient,
  payload: SessionPayload,
  input?: {
    forUpdate?: boolean;
  }
) {
  const latestAttempt = await getLatestRuntimeSessionForLogicalSessionId(
    client,
    payload.session.session_id
  );

  if (!latestAttempt) {
    return null;
  }

  if (input?.forUpdate) {
    return getRuntimeSessionForUpdate(client, latestAttempt.sessionId);
  }

  return latestAttempt;
}

async function getLatestRuntimeSessionForLogicalSessionId(
  client: PoolClient,
  logicalSessionId: string
) {
  const result = await client.query<{ session_id: string }>(
    `
      SELECT session_id
      FROM runtime_sessions
      WHERE logical_session_id = $1
      ORDER BY attempt_number DESC, COALESCE(completed_at, started_at, updated_at) DESC, session_id DESC
      LIMIT 1
    `,
    [logicalSessionId]
  );
  const sessionId = result.rows[0]?.session_id;

  if (!sessionId) {
    return null;
  }

  return getRuntimeSessionById(client, sessionId);
}

async function listRuntimeSessionAttemptsByLogicalSessionId(
  client: PoolClient,
  logicalSessionId: string
) {
  const result = await client.query<{ session_id: string }>(
    `
      SELECT session_id
      FROM runtime_sessions
      WHERE logical_session_id = $1
      ORDER BY attempt_number DESC, COALESCE(completed_at, started_at, updated_at) DESC, session_id DESC
    `,
    [logicalSessionId]
  );

  const sessions: Array<RuntimeSessionRecord | null> = [];

  for (const row of result.rows) {
    sessions.push(await getRuntimeSessionById(client, row.session_id));
  }

  return sessions.filter((session): session is RuntimeSessionRecord => session !== null);
}

async function getRuntimeSessionByLogicalAttempt(
  client: PoolClient,
  logicalSessionId: string,
  attemptNumber: number
) {
  const result = await client.query<{ session_id: string }>(
    `
      SELECT session_id
      FROM runtime_sessions
      WHERE logical_session_id = $1 AND attempt_number = $2
      LIMIT 1
    `,
    [logicalSessionId, attemptNumber]
  );
  const sessionId = result.rows[0]?.session_id;

  if (!sessionId) {
    return null;
  }

  return getRuntimeSessionById(client, sessionId);
}

async function getNextAttemptNumber(
  client: PoolClient,
  logicalSessionId: string
) {
  const result = await client.query<{ next_attempt_number: string | number }>(
    `
      SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt_number
      FROM runtime_sessions
      WHERE logical_session_id = $1
    `,
    [logicalSessionId]
  );

  return Number(result.rows[0]?.next_attempt_number ?? 1);
}

async function claimNextQueuedTranscriptSession(client: PoolClient) {
  const claimedRows = await client.query<{ session_id: string }>(
    `
      SELECT session_id
      FROM runtime_sessions
      WHERE transcript_status = 'queued'
      ORDER BY updated_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `
  );
  const sessionId = claimedRows.rows[0]?.session_id;

  if (!sessionId) {
    return null;
  }

  return getRuntimeSessionById(client, sessionId);
}

async function persistRuntimeSession(
  client: PoolClient,
  session: RuntimeSessionRecord
) {
  await client.query(
    `
      UPDATE runtime_sessions
      SET token = $2,
          study_id = $3,
          study_title = $4,
          participant_id = $5,
          participant_display_name = $6,
          session_status = $7,
          transcript_status = $8,
          microphone_permission = $9,
          screen_permission = $10,
          recording_status = $11,
          upload_status = $12,
          current_step_id = $13,
          started_at = $14,
          completed_at = $15,
          transcript = $16,
          transcript_failure_message = $17,
          steps = $18,
          updated_at = NOW()
      WHERE session_id = $1
    `,
    [
      session.sessionId,
      session.token,
      session.studyId,
      session.studyTitle,
      session.participantId,
      session.participantDisplayName,
      session.sessionStatus,
      session.transcriptStatus,
      session.microphonePermission,
      session.screenPermission,
      session.recordingStatus,
      session.uploadStatus,
      session.currentStepId,
      session.startedAt,
      session.completedAt,
      session.transcript ? JSON.stringify(session.transcript) : null,
      session.transcriptFailureMessage,
      JSON.stringify(session.steps)
    ]
  );

  await client.query("DELETE FROM runtime_events WHERE session_id = $1", [
    session.sessionId
  ]);
  // `step_id IS NOT NULL`, so a save cannot destroy an answer whose question
  // was removed. Those rows are excluded from the session record on load too,
  // so they are never in `session.responses` and cannot be reinserted - the two
  // filters are one decision and have to agree.
  await client.query(
    "DELETE FROM participant_responses WHERE session_id = $1 AND step_id IS NOT NULL",
    [session.sessionId]
  );
  await client.query("DELETE FROM recording_assets WHERE session_id = $1", [
    session.sessionId
  ]);

  for (const event of session.events) {
    await client.query(
      `
        INSERT INTO runtime_events (id, session_id, step_id, event_type, timestamp, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        event.id,
        event.sessionId,
        event.stepId ?? null,
        event.eventType,
        event.timestamp,
        event.metadata ? JSON.stringify(event.metadata) : null
      ]
    );
  }

  // The prompt each answer was given against, taken from the session's OWN step
  // list rather than from the study as it stands now. That list is the study as
  // this participant was served it, so it is the only record of what they were
  // actually asked - which is the whole point of storing it beside the answer.
  const promptByStepId = new Map(
    session.steps.map((step) => [step.stepId, step.prompt])
  );

  for (const response of session.responses) {
    await client.query(
      `
        -- The step this answer is attached to, resolved against the table
        -- rather than taken from the record, and this is load-bearing rather
        -- than defensive.
        --
        -- Every save of a session DELETEs and re-INSERTs all of its responses,
        -- and the in-memory record keeps the step id the answer was given
        -- against for the life of the session. So if a researcher removes that
        -- question in the meantime, 0015's ON DELETE SET NULL detaches the
        -- stored row - and the next save would write the dead id straight back
        -- and be refused by the foreign key, failing the whole session save and
        -- losing the participant's progress.
        --
        -- Selecting the row back means a step that still exists is attached and
        -- one that does not yields no row at all: the answer is detached rather
        -- than lost, which is exactly what SET NULL did.
        --
        -- BOTH columns come from this one row, and that is the point of hoisting
        -- it into a CTE rather than writing the lookup inline against step_id
        -- alone. 0015 carries a CHECK - (study_id IS NULL) = (step_id IS NULL)
        -- - so "detached" means BOTH columns null and nothing else is legal.
        -- Passing the session's own study_id straight through while letting only
        -- step_id fall to NULL produces exactly the half-detached row that CHECK
        -- forbids, and Postgres rejects it: the participant loses the whole save
        -- for the very reason the lookup exists to prevent. Taking the pair from
        -- one row makes the two columns null together by construction, so the
        -- invariant cannot drift the way two parallel sub-SELECTs could.
        --
        -- It does not reopen the hole the CHECK closes. study_id is read back
        -- from study_steps, not trusted from the caller, so it is non-null only
        -- when a matching step really exists - the composite foreign key still
        -- has both columns to check, and the MATCH SIMPLE escape the CHECK
        -- exists to block is still blocked.
        --
        -- FOR KEY SHARE, and it is load-bearing rather than belt-and-braces.
        -- Under READ COMMITTED a plain sub-SELECT reads its own snapshot while
        -- the foreign key's own check runs against a fresh one, so a
        -- researcher's save deleting this step in the gap between the two would
        -- turn "detach the answer" into a constraint violation that aborts the
        -- WHOLE session write - a participant losing their progress because
        -- somebody else edited the form. The lock is the same one the foreign
        -- key takes for itself, so taking it here makes the two agree instead of
        -- racing, and takes it in the same order the delete side does.
        WITH attached_step AS (
          SELECT ss.study_id, ss.id
            FROM study_steps ss
           WHERE ss.study_id = $3 AND ss.id = $4
           FOR KEY SHARE
        )
        INSERT INTO participant_responses (
          id, session_id, study_id, step_id, step_prompt, step_type,
          response_payload, saved_at
        )
        VALUES (
          $1, $2,
          (SELECT study_id FROM attached_step),
          (SELECT id FROM attached_step),
          $5, $6, $7, $8
        )
      `,
      [
        response.id,
        response.sessionId,
        session.studyId,
        response.stepId,
        promptByStepId.get(response.stepId) ?? null,
        response.stepType,
        JSON.stringify(response.responsePayload),
        response.savedAt
      ]
    );
  }

  for (const asset of session.assets) {
    await client.query(
      `
        INSERT INTO recording_assets (
          id, session_id, file_name, mime_type, file_size_bytes,
          duration_seconds, storage_provider, relative_path, object_url, uploaded_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        asset.id,
        asset.sessionId,
        asset.fileName,
        asset.mimeType,
        asset.fileSizeBytes,
        asset.durationSeconds,
        asset.storageProvider,
        asset.relativePath,
        asset.objectUrl ?? null,
        asset.uploadedAt
      ]
    );
  }
}

function mapEventRow(row: RuntimeEventRow): RuntimeEventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    stepId: row.step_id ?? undefined,
    eventType: row.event_type,
    timestamp: toRequiredIsoString(row.timestamp),
    metadata: row.metadata ?? undefined
  };
}

function mapResponseRow(row: ParticipantResponseRow): ParticipantResponseRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    stepId: row.step_id,
    stepType: row.step_type,
    responsePayload: row.response_payload,
    savedAt: toRequiredIsoString(row.saved_at)
  };
}

function mapAssetRow(row: RecordingAssetRow): RecordingAssetRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSizeBytes: Number(row.file_size_bytes),
    durationSeconds: row.duration_seconds,
    storageProvider: row.storage_provider,
    relativePath: row.relative_path,
    uploadedAt: toRequiredIsoString(row.uploaded_at),
    objectUrl: row.object_url ?? undefined
  };
}

function mapPendingRecordingUploadRow(
  row: PendingRecordingUploadRow
): PendingRecordingUploadRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    token: row.token,
    fileName: row.file_name,
    mimeType: row.mime_type,
    storageProvider: row.storage_provider,
    relativePath: row.relative_path,
    createdAt: toRequiredIsoString(row.created_at),
    validUntil: toRequiredIsoString(row.valid_until)
  };
}

function collectRuntimeCleanupTargets(
  sessions: RuntimeSessionRecord[],
  pendingUploads: PendingRecordingUploadRecord[]
) {
  const cleanupTargets = new Map<
    string,
    {
      relativePath: string;
      storageProvider: RecordingAssetRecord["storageProvider"];
    }
  >();

  for (const session of sessions) {
    if (session.transcript?.artifactPath) {
      const storageProvider = session.transcript.storageProvider ?? "filesystem";
      cleanupTargets.set(
        `${storageProvider}:${session.transcript.artifactPath}`,
        {
          relativePath: session.transcript.artifactPath,
          storageProvider
        }
      );
    }

    for (const asset of session.assets) {
      cleanupTargets.set(`${asset.storageProvider}:${asset.relativePath}`, {
        relativePath: asset.relativePath,
        storageProvider: asset.storageProvider
      });
    }
  }

  for (const pendingUpload of pendingUploads) {
    cleanupTargets.set(
      `${pendingUpload.storageProvider}:${pendingUpload.relativePath}`,
      {
        relativePath: pendingUpload.relativePath,
        storageProvider: pendingUpload.storageProvider
      }
    );
  }

  return Array.from(cleanupTargets.values());
}

async function deleteRuntimeCleanupTargets(
  cleanupTargets: Array<{
    relativePath: string;
    storageProvider: RecordingAssetRecord["storageProvider"];
  }>
) {
  await Promise.allSettled(
    cleanupTargets.map((target) =>
      deleteStoredObject({
        relativePath: target.relativePath,
        storageProvider: target.storageProvider
      })
    )
  );
}

function toIsoString(value: Date | string | null) {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}

function toRequiredIsoString(value: Date | string) {
  return new Date(value).toISOString();
}

function normalizeTranscriptProcessingLimit(limit: number) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return 1;
  }

  return Math.min(10, Math.floor(limit));
}

type CallbackOutboxRow = {
  delivery_id: string;
  callback_url: string;
  body: string;
  attempts: number;
};

export async function enqueueCallbackDeliveryPostgres(
  input: EnqueueCallbackDeliveryInput
) {
  const attempts = input.attempts ?? 1;
  const nextAttemptAt =
    input.nextAttemptAt ??
    new Date(computeNextAttemptAtMs(attempts, Date.now())).toISOString();

  return withRuntimeDatabaseClient(async (client) => {
    await client.query(
      `
        INSERT INTO callback_outbox
          (callback_url, body, event, logical_session_id, attempts, next_attempt_at, last_error)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        input.callbackUrl,
        input.body,
        input.event,
        input.logicalSessionId,
        attempts,
        nextAttemptAt,
        input.lastError ?? null
      ]
    );
  });
}

export async function processDueCallbackDeliveriesPostgres(limit: number) {
  const summary = createEmptyCallbackDeliverySummary();
  const secret = getIntegrationSharedSecret();

  if (!secret) {
    return summary;
  }

  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));

  // Claim due rows by pushing next_attempt_at forward as a lease, so a
  // crashed run cannot strand them and concurrent runs skip them.
  const claimed = await withRuntimeDatabaseClient(async (client) => {
    const result = await client.query<CallbackOutboxRow>(
      `
        UPDATE callback_outbox
        SET next_attempt_at = NOW() + INTERVAL '5 minutes'
        WHERE delivery_id IN (
          SELECT delivery_id
          FROM callback_outbox
          WHERE delivered_at IS NULL
            AND abandoned_at IS NULL
            AND next_attempt_at <= NOW()
          ORDER BY next_attempt_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING delivery_id, callback_url, body, attempts
      `,
      [safeLimit]
    );

    return result.rows;
  });

  if (claimed.length === 0) {
    return summary;
  }

  for (const row of claimed) {
    const attempts = row.attempts + 1;
    const result = await deliverSignedCallback({
      body: row.body,
      callbackUrl: row.callback_url,
      secret
    });

    summary.processed += 1;

    if (result.ok) {
      summary.delivered += 1;
      await withRuntimeDatabaseClient(async (client) => {
        await client.query(
          `
            UPDATE callback_outbox
            SET attempts = $2, delivered_at = NOW(), last_error = NULL
            WHERE delivery_id = $1
          `,
          [row.delivery_id, attempts]
        );
      });
    } else if (attempts >= CALLBACK_DELIVERY_MAX_ATTEMPTS) {
      summary.abandoned += 1;
      await withRuntimeDatabaseClient(async (client) => {
        await client.query(
          `
            UPDATE callback_outbox
            SET attempts = $2, abandoned_at = NOW(), last_error = $3
            WHERE delivery_id = $1
          `,
          [row.delivery_id, attempts, result.error]
        );
      });
    } else {
      summary.rescheduled += 1;
      const nextAttemptAt = new Date(
        computeNextAttemptAtMs(attempts, Date.now())
      ).toISOString();
      await withRuntimeDatabaseClient(async (client) => {
        await client.query(
          `
            UPDATE callback_outbox
            SET attempts = $2, next_attempt_at = $3, last_error = $4
            WHERE delivery_id = $1
          `,
          [row.delivery_id, attempts, nextAttemptAt, result.error]
        );
      });
    }
  }

  return summary;
}
