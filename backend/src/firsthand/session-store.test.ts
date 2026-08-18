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

/** Omits expires_at entirely, which no fixture in this file used to do. */
function payloadWithoutExpiry() {
  const payload = validPayload();
  delete (payload.session as { expires_at?: string }).expires_at;
  return payload;
}

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

  /**
   * A token with no stated lifetime is a bearer token that never expires - the
   * one kind of capability that should never exist by accident. This used to
   * return `ok`, and no fixture in this file omitted the field, which is
   * exactly why it went unnoticed.
   */
  it("refuses a session whose payload states no expiry at all", async () => {
    mockRow(payloadWithoutExpiry());
    const result = await loadParticipantSession("fh_token");
    expect(result.kind).toBe("expired");
  });

  it("tells the participant it expired rather than failing obscurely", async () => {
    mockRow(payloadWithoutExpiry());
    const result = await loadParticipantSession("fh_token");
    if (result.kind === "ok") throw new Error("expected a refusal");
    // BOTH, because the message travels with the branch rather than with the
    // kind: swapping this return to invalid_contract leaves the wording
    // untouched, so a message-only assertion cannot see it. The kind is what
    // the binding middleware maps to 410 rather than 422.
    expect(result.kind).toBe("expired");
    // Not invalid_contract: the payload is well-formed, it just cannot say when
    // it stops being valid. The participant gets the ordinary expiry message.
    expect(result.message).toMatch(/expired/i);
  });

  it("returns invalid_contract for a malformed stored payload", async () => {
    mockRow({ contract_version: "1.0", nonsense: true });
    const result = await loadParticipantSession("fh_token");
    expect(result.kind).toBe("invalid_contract");
  });
});
