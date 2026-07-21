import {
  sessionPayloadSchema,
  type SessionPayload
} from "../../../shared/firsthand/contract";
import {
  isPostgresRuntimeConfigured,
  withRuntimeDatabaseClient
} from "./runtime-database";

// Loads a participant SessionPayload by its opaque bearer token. This is the
// internalised, DB-only equivalent of FirstHand's src/lib/session-store.ts:
// the hardcoded demo payloads and the filesystem/demo-session branches are NOT
// ported (throwaway prototype infra) — a unified-product session always exists
// as a row in firsthand.runtime_sessions, minted in-process by session-create
// (B3b). The returned payload's session.participant_id is the sole source of
// truth for the token->user binding enforced by the participant runtime routes
// (B4 / H3): the caller checks it against req.user.id.

type SessionSuccess = {
  kind: "ok";
  payload: SessionPayload;
};

type SessionFailure = {
  kind: "not_found" | "expired" | "invalid_contract";
  message: string;
};

export type SessionLoadResult = SessionSuccess | SessionFailure;

export async function loadParticipantSession(
  token: string
): Promise<SessionLoadResult> {
  if (!token || !isPostgresRuntimeConfigured()) {
    return notFound();
  }

  const dbPayload = await loadSessionPayloadFromDatabase(token);

  if (!dbPayload) {
    return notFound();
  }

  return interpretRawPayload(dbPayload);
}

function interpretRawPayload(rawPayload: unknown): SessionLoadResult {
  const parsedPayload = sessionPayloadSchema.safeParse(rawPayload);

  if (!parsedPayload.success) {
    return {
      kind: "invalid_contract",
      message:
        "This session could not be opened because the study payload is malformed."
    };
  }

  if (isExpired(parsedPayload.data)) {
    return {
      kind: "expired",
      message:
        "This session link has expired. Please contact the research team for a new invitation."
    };
  }

  return {
    kind: "ok",
    payload: parsedPayload.data
  };
}

async function loadSessionPayloadFromDatabase(
  token: string
): Promise<unknown | null> {
  return withRuntimeDatabaseClient(async (client) => {
    const result = await client.query<{ session_payload: unknown }>(
      `
        SELECT session_payload
        FROM runtime_sessions
        WHERE token = $1 AND session_payload IS NOT NULL
        ORDER BY attempt_number DESC, updated_at DESC
        LIMIT 1
      `,
      [token]
    );

    return result.rows[0]?.session_payload ?? null;
  });
}

function isExpired(payload: SessionPayload) {
  if (!payload.session.expires_at) {
    return false;
  }

  return new Date(payload.session.expires_at).getTime() < Date.now();
}

function notFound(): SessionFailure {
  return {
    kind: "not_found",
    message:
      "This session link is invalid or no longer available. Please contact the research team that sent it."
  };
}
