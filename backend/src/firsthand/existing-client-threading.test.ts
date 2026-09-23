import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const connectMock = vi.fn();
const onMock = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({ connect: connectMock, on: onMock }))
}));

/**
 * `existingClient` (cto/AdaptaLabs#159) is what makes `runSerializedForMintPair`
 * mean anything: a caller already holding its advisory-locked transaction has
 * to be able to make `findParticipantSessionForOpportunity`,
 * `hasAnswerCarryingTerminalSession` and `seedRuntimeSession` run ON that
 * client, not open a second, unrelated checkout of their own that would race
 * the very lock the caller is holding.
 *
 * Getting either branch backwards is silent. Omitting a checkout when no
 * client is supplied breaks every pre-existing no-lock caller
 * (`opportunities.ts`'s participant-detail read, `survey-results.ts`,
 * `firsthand-session.ts`'s two `createSession`-adjacent call sites) - they
 * would either throw on a client they never checked out, or silently share
 * one across unrelated requests. Opening a checkout anyway when a client IS
 * supplied defeats the lock: a second, unlocked connection racing the first
 * is cto/AdaptaLabs#159's bug again, just moved one level down and no longer
 * visible to the burst test that proves the route-level fix.
 *
 * Driven against a mocked `pg`, exactly like the neighbouring
 * `runtime-database.test.ts` and `runtime-response-attachment.test.ts`: what
 * is pinned here is CHECKOUT/RELEASE and BEGIN/COMMIT bookkeeping, not
 * Postgres behaviour - `mint-serializes-concurrent-bursts-postgres.test.ts`
 * is the real-database proof that the consequence (one row per burst) holds.
 */

function resetRuntimeDatabaseGlobals(): void {
  delete process.env.DATABASE_URL;
  delete (globalThis as typeof globalThis & { __firsthandRuntimePool?: unknown })
    .__firsthandRuntimePool;
  delete (
    globalThis as typeof globalThis & { __firsthandRuntimeVerification?: unknown }
  ).__firsthandRuntimeVerification;
}

/** A client that answers every query this file's functions can issue against it. */
function createFakeClient() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql: sql.trim(), params: params ?? [] });

      if (sql.startsWith("SET search_path TO firsthand")) return { rowCount: null, rows: [] };
      if (sql.includes("SELECT relation_path, to_regclass(relation_path) AS regclass")) {
        const relationPaths = (params?.[0] as string[]) ?? [];
        return {
          rowCount: relationPaths.length,
          rows: relationPaths.map((relationPath) => ({
            relation_path: relationPath,
            regclass: relationPath
          }))
        };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      if (sql.includes("has_answer_carrying_terminal_session")) {
        return { rowCount: 1, rows: [{ has_answer_carrying_terminal_session: false }] };
      }
      // findParticipantSessionForOpportunity's own read: "no existing session".
      return { rowCount: 0, rows: [] };
    }),
    release: vi.fn()
  };
  return { client, calls };
}

/**
 * The one dummy row `seedRuntimeSession`'s own path needs back, shaped like
 * `runtime_sessions` - copied from `runtime-session-opportunity.test.ts`'s
 * equivalent fixture, which exercises the exact same insert-then-reload path.
 */
function createSeedWireClient() {
  const inserts: { sql: string; params: unknown[] }[] = [];
  const calls: { sql: string; params: unknown[] }[] = [];

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql: sql.trim(), params: params ?? [] });

      if (sql.startsWith("SET search_path TO firsthand")) return { rowCount: null, rows: [] };
      if (sql.includes("SELECT relation_path, to_regclass(relation_path) AS regclass")) {
        const relationPaths = (params?.[0] as string[]) ?? [];
        return {
          rowCount: relationPaths.length,
          rows: relationPaths.map((relationPath) => ({
            relation_path: relationPath,
            regclass: relationPath
          }))
        };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      if (sql.includes("INSERT INTO runtime_sessions")) {
        inserts.push({ sql, params: params ?? [] });
        return { rowCount: 1, rows: [{ session_id: "session_1" }] };
      }
      if (sql.includes("FROM runtime_sessions") && inserts.length > 0) {
        return {
          rowCount: 1,
          rows: [
            {
              session_id: "session_1",
              logical_session_id: "session_1",
              attempt_number: 1,
              token: "fh_token",
              study_id: "study_abc",
              study_title: "Study",
              participant_id: "user-42",
              participant_display_name: "User 42",
              session_status: "created",
              transcript_status: "not_requested",
              microphone_permission: "not_requested",
              screen_permission: "not_requested",
              recording_status: "not_started",
              upload_status: "not_started",
              current_step_id: null,
              started_at: null,
              completed_at: null,
              transcript: null,
              transcript_failure_message: null,
              steps: [],
              created_at: "2026-08-17T00:00:00.000Z",
              updated_at: "2026-08-17T00:00:00.000Z"
            }
          ]
        };
      }
      return { rowCount: 0, rows: [] };
    }),
    release: vi.fn()
  };

  return { client, calls };
}

const seedPayload = () => ({
  contract_version: "1.0" as const,
  study: {
    id: "study_abc",
    title: "Study",
    intro_text: "Intro",
    consent_text: "Consent"
  },
  participant: {
    participant_id: "user-42",
    display_name: "User 42"
  },
  session: {
    session_id: "session_1",
    session_token: "fh_token",
    study_id: "study_abc",
    participant_id: "user-42"
  },
  steps: [
    {
      step_id: "study_abc_step_1",
      order: 1,
      type: "nps" as const,
      prompt: "Would you recommend it?"
    }
  ]
});

describe("existingClient threading (cto/AdaptaLabs#159)", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://firsthand:firsthand@localhost:5432/firsthand";
  });

  afterEach(() => {
    resetRuntimeDatabaseGlobals();
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("findParticipantSessionForOpportunity", () => {
    it("checks out and releases its own connection when no existingClient is supplied", async () => {
      const { client: verificationClient } = createFakeClient();
      connectMock.mockResolvedValue(verificationClient);

      const repo = await import("./runtime-repository-postgres");
      const db = await import("./runtime-database");
      // Pre-warm schema verification off the measured window - it always
      // checks out its own connection regardless of existingClient, and is
      // not what this test is about.
      await db.ensureRuntimeDatabase();
      connectMock.mockClear();

      const { client: pooledClient } = createFakeClient();
      connectMock.mockResolvedValue(pooledClient);

      await repo.findParticipantSessionForOpportunity({
        opportunityId: "opp-1",
        participantId: "user-1"
      });

      expect(connectMock).toHaveBeenCalledTimes(1);
      expect(pooledClient.release).toHaveBeenCalledTimes(1);
    });

    it("runs on the supplied client and checks out no connection of its own", async () => {
      const { client: verificationClient } = createFakeClient();
      connectMock.mockResolvedValue(verificationClient);

      const repo = await import("./runtime-repository-postgres");
      const db = await import("./runtime-database");
      // Pre-warm schema verification off the measured window - it always
      // checks out its own connection regardless of existingClient, and is
      // not what this test is about.
      await db.ensureRuntimeDatabase();
      connectMock.mockClear();

      const { client: suppliedClient, calls } = createFakeClient();
      await repo.findParticipantSessionForOpportunity(
        { opportunityId: "opp-1", participantId: "user-1" },
        suppliedClient as never
      );

      expect(connectMock).not.toHaveBeenCalled();
      expect(suppliedClient.release).not.toHaveBeenCalled();
      // Ran a real read on the supplied client - not a silent no-op.
      expect(calls.some((call) => call.sql.includes("FROM runtime_sessions"))).toBe(true);
    });
  });

  describe("hasAnswerCarryingTerminalSession", () => {
    const input = {
      opportunityId: "opp-1",
      participantId: "user-1",
      terminalUnansweredStates: ["abandoned", "failed"]
    };

    it("checks out and releases its own connection when no existingClient is supplied", async () => {
      const { client: verificationClient } = createFakeClient();
      connectMock.mockResolvedValue(verificationClient);

      const repo = await import("./runtime-repository-postgres");
      const db = await import("./runtime-database");
      await db.ensureRuntimeDatabase();
      connectMock.mockClear();

      const { client: pooledClient } = createFakeClient();
      connectMock.mockResolvedValue(pooledClient);

      await repo.hasAnswerCarryingTerminalSession(input);

      expect(connectMock).toHaveBeenCalledTimes(1);
      expect(pooledClient.release).toHaveBeenCalledTimes(1);
    });

    it("runs on the supplied client and checks out no connection of its own", async () => {
      const { client: verificationClient } = createFakeClient();
      connectMock.mockResolvedValue(verificationClient);

      const repo = await import("./runtime-repository-postgres");
      const db = await import("./runtime-database");
      await db.ensureRuntimeDatabase();
      connectMock.mockClear();

      const { client: suppliedClient, calls } = createFakeClient();
      await repo.hasAnswerCarryingTerminalSession(input, suppliedClient as never);

      expect(connectMock).not.toHaveBeenCalled();
      expect(suppliedClient.release).not.toHaveBeenCalled();
      expect(
        calls.some((call) => call.sql.includes("has_answer_carrying_terminal_session"))
      ).toBe(true);
    });
  });

  describe("seedRuntimeSession", () => {
    it("without existingClient: opens its own BEGIN/COMMIT on its own checked-out connection", async () => {
      const { client: verificationClient } = createFakeClient();
      connectMock.mockResolvedValue(verificationClient);

      const repo = await import("./runtime-repository-postgres");
      const db = await import("./runtime-database");
      await db.ensureRuntimeDatabase();
      connectMock.mockClear();

      const { client: pooledClient, calls } = createSeedWireClient();
      connectMock.mockResolvedValue(pooledClient);

      await repo.seedRuntimeSession(seedPayload());

      expect(connectMock).toHaveBeenCalledTimes(1);
      expect(pooledClient.release).toHaveBeenCalledTimes(1);
      const statements = calls.map((call) => call.sql);
      expect(statements).toContain("BEGIN");
      expect(statements).toContain("COMMIT");
    });

    it("with existingClient: runs on the supplied client and issues no BEGIN or COMMIT of its own", async () => {
      const { client: verificationClient } = createFakeClient();
      connectMock.mockResolvedValue(verificationClient);

      const repo = await import("./runtime-repository-postgres");
      const db = await import("./runtime-database");
      await db.ensureRuntimeDatabase();
      connectMock.mockClear();

      const { client: suppliedClient, calls } = createSeedWireClient();
      await repo.seedRuntimeSession(seedPayload(), suppliedClient as never);

      expect(connectMock).not.toHaveBeenCalled();
      expect(suppliedClient.release).not.toHaveBeenCalled();
      const statements = calls.map((call) => call.sql);
      // The load-bearing negative assertion: a nested BEGIN on an
      // already-open transaction would only warn, but the COMMIT this
      // function used to issue unconditionally would commit - and release
      // the CALLER's advisory lock - early.
      expect(statements).not.toContain("BEGIN");
      expect(statements).not.toContain("COMMIT");
      // And it still did real work on that client, not a silent no-op.
      expect(statements.some((sql) => sql.includes("INSERT INTO runtime_sessions"))).toBe(true);
    });
  });
});
