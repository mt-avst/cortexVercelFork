import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit coverage for the DB-only session-load seam (B4). The runtime database is
// mocked; this asserts the token->payload resolution and the failure-kind
// mapping that the binding middleware turns into 404/410/422.

const { isPostgresRuntimeConfigured, withRuntimeDatabaseClient } = vi.hoisted(
  () => ({
    isPostgresRuntimeConfigured: vi.fn(),
    withRuntimeDatabaseClient: vi.fn()
  })
);

vi.mock("./runtime-database", () => ({
  isPostgresRuntimeConfigured,
  withRuntimeDatabaseClient
}));

import { loadParticipantSession } from "./session-store";

const FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

function validPayload(overrides: { expiresAt?: string } = {}) {
  return {
    contract_version: "1.0",
    study: {
      id: "study_1",
      title: "Study",
      intro_text: "intro",
      consent_text: "consent"
    },
    participant: { participant_id: "user_1" },
    session: {
      session_id: "session_1",
      session_token: "fh_token",
      study_id: "study_1",
      participant_id: "user_1",
      expires_at: overrides.expiresAt ?? FUTURE,
      single_use: true
    },
    steps: [{ step_id: "s1", order: 1, type: "end", prompt: "done" }]
  };
}

function mockRow(sessionPayload: unknown) {
  withRuntimeDatabaseClient.mockImplementation(async (op: any) =>
    op({
      query: async () => ({
        rows: sessionPayload === null ? [] : [{ session_payload: sessionPayload }]
      })
    })
  );
}

beforeEach(() => {
  isPostgresRuntimeConfigured.mockReset();
  withRuntimeDatabaseClient.mockReset();
  isPostgresRuntimeConfigured.mockReturnValue(true);
});

describe("loadParticipantSession", () => {
  it("returns not_found for an empty token without touching the database", async () => {
    const result = await loadParticipantSession("");
    expect(result.kind).toBe("not_found");
    expect(withRuntimeDatabaseClient).not.toHaveBeenCalled();
  });

  it("returns not_found when postgres runtime is not configured", async () => {
    isPostgresRuntimeConfigured.mockReturnValue(false);
    const result = await loadParticipantSession("fh_token");
    expect(result.kind).toBe("not_found");
    expect(withRuntimeDatabaseClient).not.toHaveBeenCalled();
  });

  it("returns not_found when no session row matches the token", async () => {
    mockRow(null);
    const result = await loadParticipantSession("fh_unknown");
    expect(result.kind).toBe("not_found");
  });

  it("returns ok with the parsed payload for a valid, unexpired session", async () => {
    mockRow(validPayload());
    const result = await loadParticipantSession("fh_token");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.payload.session.participant_id).toBe("user_1");
    }
  });

  it("returns expired for a session past its expires_at", async () => {
    mockRow(validPayload({ expiresAt: PAST }));
    const result = await loadParticipantSession("fh_token");
    expect(result.kind).toBe("expired");
  });

  it("returns invalid_contract for a malformed stored payload", async () => {
    mockRow({ contract_version: "1.0", nonsense: true });
    const result = await loadParticipantSession("fh_token");
    expect(result.kind).toBe("invalid_contract");
  });
});
