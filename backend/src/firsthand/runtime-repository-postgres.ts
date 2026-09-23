
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
  createRuntimeSessionRecord,
  pushInternalEvent,
  resolveSessionSortTimestamp
} from "./runtime-session-model";
import {
  deleteStoredObject,
  storeTranscriptArtifact
} from "./object-storage";
import { withRuntimeDatabaseClient } from "./runtime-database";
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

/**
 * `existingClient` (cto/AdaptaLabs#159) is additive only: every existing
 * no-argument caller (both `firsthand-session.ts` call sites) is unaffected,
 * byte-for-byte - this still checks out its own client and owns its own
 * `BEGIN`/`COMMIT`/`ROLLBACK` exactly as before.
 *
 * Given an `existingClient`, this does NOT open a transaction or check out a
 * connection at all: it runs `ensureRuntimeSessionRow` directly on the
 * caller's client and returns without a `COMMIT`. That client's transaction -
 * and whatever `BEGIN` and lock started it - is the caller's to finish. A
 * nested `BEGIN` here on an already-open transaction would only warn and stay
 * in the outer one, but the `COMMIT` this function used to issue would still
 * commit (and release the caller's advisory lock) early, before the rest of
 * the caller's own transaction runs - so the client-accepting path skips both
 * rather than relying on Postgres to ignore the inner `BEGIN`.
 */
export async function seedRuntimeSession(
  payload: SessionPayload,
  existingClient?: PoolClient
) {
  if (existingClient) {
    await ensureRuntimeSessionRow(existingClient, payload);
    const session = await getLatestRuntimeSessionForLogicalSessionId(
      existingClient,
      payload.session.session_id
    );

    if (!session) {
      throw new Error("Runtime session could not be loaded after seeding.");
    }

    return session;
  }

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

export async function createFreshRuntimeAttempt(payload: SessionPayload) {
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

export async function applyRuntimeMutation(
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

export async function resetRuntimeSession(payload: SessionPayload) {
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
 * creates a runtime_sessions row, and the results aggregation COUNTED one
 * respondent per session - so an ordinary employee pressing Start repeatedly
 * could move a poll's numbers as far as they liked, with each fake respondent
 * indistinguishable from a real one. Proven end to end before this existed:
 * three extra mints took a rating question from 3 respondents to 6.
 *
 * PAST TENSE ON PURPOSE. The aggregation counts one respondent per
 * PARTICIPANT now, not per session - `respondentKey` in survey-results.ts,
 * cto/AdaptaLabs#129. That is a second line of defence over the same defect
 * rather than a replacement for this function: the per-question tallies
 * still count one answer ROW as one answer (cto/AdaptaLabs#152), so repeated
 * mints would still move a question's own numbers even with the respondent
 * headline holding at one.
 *
 * That is a survey problem specifically. Sixty junk recorded sessions are
 * obvious to whoever reviews them; sixty junk poll votes are just a number.
 *
 * Returns the most recent, so a participant who abandoned a survey and came
 * back resumes rather than starting again - which is also why the completed
 * case is answered here rather than filtered out: the route needs to tell the
 * two apart.
 *
 * `sessionNotExpired` (cto/AdaptaLabs#129, LOW-8) is the second half of that
 * same "tell them apart" job: whether the session's own token is still live,
 * for `isInFlightRuntimeSession` to combine with `sessionStatus`. Read from
 * `session_payload->'session'->>'expires_at'` - the JSONB PAYLOAD - rather
 * than the `runtime_sessions.expires_at` ROW COLUMN. The column is written
 * once at INSERT and never revisited by anything afterwards; session-store.ts
 * (`isExpired`) documents a real case where the column and the payload
 * disagreed and settled on the payload as the authoritative copy for this
 * exact question. Reading the column here would be a SECOND, looser
 * definition of the same fact, exactly the kind of drift this function exists
 * to prevent. Compared against `NOW()` - the DATABASE clock, matching
 * `loadMintableOpportunity`'s `has_closed`, so neither an app server's drift
 * nor a mismatched read/write path can move the boundary. A payload with no
 * `expires_at` at all (pre-dates the field) reads as expired, matching
 * `isExpired`'s fail-closed default: a token with no stated lifetime is
 * refused, not honoured forever.
 *
 * THE TWO COPIES OF THAT DEFINITION DO NOT AGREE ON A CORRUPT VALUE, and it
 * is worth saying so rather than claiming one authoritative copy with no
 * looser twin (cto/AdaptaLabs#129, LOW-5). Measured, not remembered:
 *
 *   - HERE, a value that is not a timestamp used to RAISE. `->>` hands back
 *     whatever text is stored and `::timestamptz` refused it - re-measured
 *     across postgres 15.19 AND 17.11, identically on both, for six forms
 *     spanning all four SQLSTATEs the cast can raise: "not-a-date", an empty
 *     string, `12345` (22007), the well-shaped but out-of-range
 *     `2026-02-31T00:00:00.000Z` (22008), `2026-09-21T10:00:00.000+99:00`
 *     (22009) and `2026-09-21T10:00:00 Nowhere/Land` (22023). The mint route
 *     calls this outside any try, so that was a 500 where the participant
 *     previously resumed; the detail read caught it and degraded to no trace.
 *     One row, two answers. `try_timestamptz` (migration 0016) now answers
 *     NULL for all six, so a corrupt payload reads as EXPIRED - fail closed,
 *     the same direction as the absent-value case above.
 *   - THERE, `isExpired` would read the same value as NOT expired:
 *     `new Date("not-a-date").getTime()` is NaN and `NaN < Date.now()` is
 *     false. That divergence is not reachable on the live path, because
 *     `sessionPayloadSchema` types `expires_at` as `z.string().datetime()`
 *     and `interpretRawPayload` refuses the whole payload as
 *     `invalid_contract` first - also fail closed, so the OUTCOMES agree even
 *     though the two expressions do not. Measured on zod 3.25.76 rather than
 *     assumed from the regex: it rejects all SIX malformed forms above,
 *     including `2026-02-31T00:00:00.000Z`, whose shape a `\d{2}` day pattern
 *     would have admitted. The guarantee rests on the schema, not on
 *     `isExpired`, which is the part a reader should know before relaxing
 *     that field.
 *
 * `IS TRUE`, NOT A BARE COMPARISON, and it is load-bearing rather than
 * decorative. `try_timestamptz` answers NULL for both a payload with no
 * `expires_at` and a corrupt one, and `NULL > NOW()` is SQL NULL, not false -
 * so without it this projection returns NULL for exactly the two cases the
 * fail-closed design is about. `session_not_expired: boolean` above would
 * then be a lie about the runtime row, `isInFlightRuntimeSession` would hand
 * back that NULL unchanged, and the participant detail read would ship
 * `completion.inProgress: null` in its JSON to a frontend that tests the flag
 * for `true`. It reads as false today by accident of falsiness, one `===`
 * away from not. Pinned by name in opportunity-detail-resume-postgres.test.ts
 * by `reports inProgress as boolean false rather than null when the session
 * carries no expiry`, which is the only test in either DB suite that can see
 * this word: dropping it left all 40 green before that test existed.
 */
/**
 * `existingClient` (cto/AdaptaLabs#159) is additive: omit it and this checks
 * out its own client exactly as before, for the existing no-lock callers
 * (`opportunities.ts`'s participant-detail read, `survey-results.ts`).
 * Passed one, it queries directly on it instead - the caller is expected to
 * already hold whatever transaction/lock this read needs to run inside, most
 * often `runSerializedForMintPair`'s advisory-locked transaction.
 */
export async function findParticipantSessionForOpportunity(
  input: {
    opportunityId: string;
    participantId: string;
  },
  existingClient?: PoolClient
): Promise<{
  token: string;
  sessionStatus: string;
  completedAt: string | null;
  sessionNotExpired: boolean;
} | null> {
  const query = async (client: PoolClient) => {
    const result = await client.query<{
      token: string;
      session_status: string;
      completed_at: Date | null;
      session_not_expired: boolean;
    }>(
      `
        SELECT token, session_status, completed_at,
               (
                 try_timestamptz(session_payload->'session'->>'expires_at') > NOW()
                 IS TRUE
               ) AS session_not_expired
        FROM runtime_sessions
        WHERE opportunity_id = $1
          AND participant_id = $2
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [input.opportunityId, input.participantId]
    );

    const row = result.rows[0];
    return row
      ? {
          token: row.token,
          sessionStatus: row.session_status,
          completedAt: row.completed_at ? row.completed_at.toISOString() : null,
          sessionNotExpired: row.session_not_expired
        }
      : null;
  };

  return existingClient
    ? query(existingClient)
    : withRuntimeDatabaseClient(query);
}

/**
 * Whether this participant holds ANY session for this opportunity, in one of
 * the given (terminal-unanswered) statuses, that already carries a stored
 * answer (cto/AdaptaLabs#155, review pass 1 HIGH-1 and HIGH-2).
 *
 * NOT folded into `findParticipantSessionForOpportunity` above, which reads
 * only the single most recent row (`ORDER BY created_at DESC LIMIT 1`) - that
 * was the HIGH-2 gap. A participant who mints, answers, and abandons more
 * than once holds SEVERAL terminal-unanswered rows for the same opportunity;
 * checking only the latest one lets an answer-free abandonment on top of an
 * answer-carrying one underneath it slip a fresh mint through, sequentially
 * (mint, answer, abandon, mint again without answering, abandon again, mint a
 * third time - the second abandonment is what the latest-row read sees, and
 * it is clean) or concurrently (several mints in flight, the newest of which
 * happens to be the one left unanswered when all of them are abandoned).
 * Proven end to end on the unwidened version of this check: three rounds of
 * three parallel mints produced six answer-carrying abandoned sessions.
 * `EXISTS` over every row for the pair, not the latest one, is what closes
 * the SEQUENTIAL half of that gap.
 *
 * NOT status `'abandoned'` alone, which was the HIGH-1 gap: `POST
 * /api/firsthand/session/:token/runtime` (firsthand-session.ts) accepts
 * `session_failed` and `upload_failed` on a survey session exactly as it
 * accepts `session_abandoned`, and both land the session on `failed`
 * (`applyDerivedStatusFromEvent`, runtime-session-model.ts) - a state
 * `FINISHED_SESSION_STATES` above treats identically to `abandoned` for
 * write-immutability, but the first version of this check did not. Passed as
 * a parameter (`terminalUnansweredStates`) rather than imported directly, so
 * this repository file does not reach up into `state-model.ts`'s
 * `terminalUnansweredRuntimeStates` for its own definition of "which statuses
 * count" - the caller (the mint route) owns that policy; this function only
 * owns how to ask Postgres the question once the caller has decided it.
 *
 * DOES NOT CLOSE THE RACE TO ZERO, AND IT IS NOT A ONE-OFF LEAK - see the
 * `ponytail:` comment at the mint route call site for the measured shape
 * (a repeatable per-window gap, not a single bounded burst) and the upgrade
 * path. What this DOES close is the sequential case entirely: once any
 * session for the pair carries an answer, every later single-mint-at-a-time
 * attempt is refused, proven end to end.
 */
/**
 * `existingClient` (cto/AdaptaLabs#159) is additive - see
 * `findParticipantSessionForOpportunity`'s docblock just above for what that
 * means and why.
 */
export async function hasAnswerCarryingTerminalSession(
  input: {
    opportunityId: string;
    participantId: string;
    terminalUnansweredStates: readonly string[];
  },
  existingClient?: PoolClient
): Promise<boolean> {
  const query = async (client: PoolClient) => {
    const result = await client.query<{ has_answer_carrying_terminal_session: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM runtime_sessions
          WHERE opportunity_id = $1
            AND participant_id = $2
            AND session_status = ANY($3::text[])
            AND EXISTS (
              SELECT 1 FROM participant_responses
              WHERE participant_responses.session_id = runtime_sessions.session_id
            )
        ) AS has_answer_carrying_terminal_session
      `,
      [input.opportunityId, input.participantId, input.terminalUnansweredStates]
    );

    return result.rows[0]?.has_answer_carrying_terminal_session ?? false;
  };

  return existingClient
    ? query(existingClient)
    : withRuntimeDatabaseClient(query);
}

/**
 * The most recent runtime session this participant holds for each of the given
 * opportunities, if any. Batched by `ANY(...)` so a listing of N opportunities
 * costs one query, not N - the same shape as the sessions batch in
 * `GET /api/opportunities`.
 *
 * Returns the raw `sessionStatus` rather than a boolean: whether a status counts
 * as "answered" is a policy the caller decides through `isAnsweredRuntimeStatus`,
 * so the two cannot drift from the mint gate that asks the same question.
 * `DISTINCT ON (opportunity_id) ... ORDER BY created_at DESC` keeps the latest
 * attempt per opportunity, matching `findParticipantSessionForOpportunity`.
 */
export async function findParticipantCompletionsForOpportunities(input: {
  participantId: string;
  opportunityIds: readonly string[];
}): Promise<
  Array<{ opportunityId: string; sessionStatus: string; completedAt: string | null }>
> {
  if (input.opportunityIds.length === 0) {
    return [];
  }

  return withRuntimeDatabaseClient(async (client) => {
    const result = await client.query<{
      opportunity_id: string;
      session_status: string;
      completed_at: Date | null;
    }>(
      `
        SELECT DISTINCT ON (opportunity_id)
               opportunity_id, session_status, completed_at
        FROM runtime_sessions
        WHERE participant_id = $1
          AND opportunity_id = ANY($2::text[])
        ORDER BY opportunity_id, created_at DESC
      `,
      [input.participantId, [...input.opportunityIds]]
    );

    return result.rows.map((row) => ({
      opportunityId: row.opportunity_id,
      sessionStatus: row.session_status,
      completedAt: row.completed_at ? row.completed_at.toISOString() : null
    }));
  });
}

export async function getRuntimeSession(
  sessionId: string,
  input?: {
    attemptNumber?: number;
  }
) {
  return withRuntimeDatabaseClient((client) =>
    getRuntimeSessionByReference(client, sessionId, input)
  );
}

export async function listRuntimeSessionAttempts(logicalSessionId: string) {
  return withRuntimeDatabaseClient((client) =>
    listRuntimeSessionAttemptsByLogicalSessionId(client, logicalSessionId)
  );
}

export async function listRuntimeSessionsForStudy(input: {
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

async function getRuntimeAssetDirect(
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

export async function getRuntimeAsset(
  sessionId: string,
  assetId: string
): Promise<RecordingAssetRecord | null> {
  const direct = await getRuntimeAssetDirect(sessionId, assetId);

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

export async function resolvePendingRecordingUpload(input: {
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

export async function queueTranscriptGeneration(sessionId: string) {
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

export async function processTranscriptGeneration(sessionId: string) {
  const claimedSession = await claimTranscriptSessionPostgres({
    sessionId
  });

  if (!claimedSession) {
    throw new Error("Runtime session could not be loaded for transcript processing.");
  }

  return completeClaimedTranscriptSessionPostgres(claimedSession);
}

export async function processQueuedTranscriptJobs(limit: number) {
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

/**
 * The stale-upload reaper, in two phases, and the split is load-bearing.
 *
 * The database work claims and deletes the rows; the S3 deletes happen AFTER
 * the connection has gone back. They used to run inside the checkout, so this
 * job held a runtime connection across up to ten S3 round trips with its
 * transaction already committed - pure network latency, on a five-connection
 * pool shared with live participants.
 *
 * That was merely wasteful before the admission cap and is not any more. This
 * runs unclassified, therefore admin, therefore capped at two - and
 * `runFirstHandMaintenance` starts both its jobs under `Promise.all`, so at
 * 03:00 the whole admin budget could sit idle on S3 while an author waited out
 * their admission timeout and got a 503.
 *
 * The rows are deleted before the objects, which is the safe order: an S3
 * delete that fails leaves an orphaned object and no row, and an orphaned
 * object costs storage. The other order risks deleting a live participant's
 * recording and keeping the row that says it exists.
 */
export async function processPendingRecordingUploadCleanup(limit: number) {
  const safeLimit = normalizeTranscriptProcessingLimit(limit);

  const pendingUploads = await withRuntimeDatabaseClient(async (client) => {
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

      const claimed = staleCandidates.rows.map(mapPendingRecordingUploadRow);

      if (claimed.length === 0) {
        await client.query("COMMIT");
        return claimed;
      }

      await client.query(
        `
          DELETE FROM pending_recording_uploads
          WHERE id = ANY($1::text[])
        `,
        [claimed.map((pendingUpload) => pendingUpload.id)]
      );

      await client.query("COMMIT");

      return claimed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  if (pendingUploads.length === 0) {
    return {
      idle: true,
      processedCount: 0,
      deletedCount: 0,
      deletedPaths: [] as string[]
    };
  }

  // Outside the checkout. Each of these is an S3 round trip and none of them
  // needs the database.
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
