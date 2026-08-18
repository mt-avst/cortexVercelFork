import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const connectMock = vi.fn();
const onMock = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({ connect: connectMock, on: onMock }))
}));

/**
 * An answer must stop being editable once the session is over.
 *
 * `persistRuntimeSession` stores responses by deleting every row for the
 * session and reinserting the current set, so a later submission does not
 * supersede the earlier answer - it ERASES it, leaving nothing that records
 * that the answer ever differed. A researcher who reads their results twice
 * could see two different findings with nothing between them saying why. That
 * is a problem about whether a finding can be trusted, not merely about a row.
 *
 * These drive the real repository against a mocked pg so they exercise the
 * decision where it is actually made: inside the transaction, after the row is
 * locked FOR UPDATE. A route-level check would read the status in a separate
 * statement, and two submissions arriving together would both read
 * "not finished" and both write.
 */
describe("answers cannot be rewritten after the session finishes", () => {
  beforeEach(() => {
    process.env.DATABASE_URL =
      "postgres://firsthand:firsthand@localhost:5432/firsthand";
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete (globalThis as typeof globalThis & { __firsthandRuntimePool?: unknown })
      .__firsthandRuntimePool;
    delete (
      globalThis as typeof globalThis & { __firsthandRuntimeVerification?: unknown }
    ).__firsthandRuntimeVerification;
    vi.clearAllMocks();
    vi.resetModules();
  });

  const payload = () => ({
    contract_version: "1.0" as const,
    study: {
      id: "study_survey",
      title: "Pulse",
      intro_text: "Intro",
      consent_text: "Consent",
      kind: "survey" as const
    },
    participant: { participant_id: "user-42", display_name: "User 42" },
    session: {
      session_id: "session_1",
      session_token: "fh_token",
      study_id: "study_survey",
      participant_id: "user-42"
    },
    steps: [
      {
        step_id: "study_survey_step_1",
        order: 1,
        type: "rating" as const,
        prompt: "How easy was that?",
        config: { scale_max: 5 }
      }
    ]
  });

  const sessionRow = (sessionStatus: string) => ({
    session_id: "session_1",
    logical_session_id: "session_1",
    attempt_number: 1,
    token: "fh_token",
    study_id: "study_survey",
    study_title: "Pulse",
    participant_id: "user-42",
    participant_display_name: "User 42",
    session_status: sessionStatus,
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
  });

  /** Records every statement so the test can assert on what was NOT run. */
  const wire = (sessionStatus: string) => {
    const statements: string[] = [];

    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        statements.push(sql.trim());

        if (sql === "SET search_path TO firsthand") return { rowCount: null, rows: [] };
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rowCount: null, rows: [] };
        }
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
        if (sql.includes("FROM runtime_sessions")) {
          return { rowCount: 1, rows: [sessionRow(sessionStatus)] };
        }
        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn()
    };

    connectMock.mockResolvedValue(client);
    return { statements };
  };

  const answer = {
    type: "response" as const,
    stepId: "study_survey_step_1",
    stepType: "rating" as const,
    responsePayload: { rating: 5 }
  };

  const wrote = (statements: string[]) =>
    statements.some((sql) => sql.includes("INSERT INTO participant_responses"));
  const erased = (statements: string[]) =>
    statements.some((sql) => sql.includes("DELETE FROM participant_responses"));

  it.each(["completed", "abandoned", "failed"])(
    "refuses an answer to a %s session with a 409",
    async (sessionStatus) => {
      wire(sessionStatus);
      const repository = await import("./runtime-repository-postgres");

      await expect(
        repository.applyRuntimeMutationPostgres(payload(), answer)
      ).rejects.toMatchObject({ statusCode: 409 });
    }
  );

  it("erases nothing when it refuses", async () => {
    const { statements } = wire("completed");
    const repository = await import("./runtime-repository-postgres");

    await expect(
      repository.applyRuntimeMutationPostgres(payload(), answer)
    ).rejects.toThrow();

    // The DELETE is the whole reason this guard exists: it is what would have
    // removed the earlier answer with nothing recording that it changed.
    expect(erased(statements)).toBe(false);
    expect(wrote(statements)).toBe(false);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("still accepts an answer while the session is live", async () => {
    const { statements } = wire("consent_accepted");
    const repository = await import("./runtime-repository-postgres");

    await repository.applyRuntimeMutationPostgres(payload(), answer);

    expect(wrote(statements)).toBe(true);
    expect(statements).toContain("COMMIT");
  });

  /**
   * `uploading` is not a finished state for a recorded session - the tasks are
   * done and the video is still going up. Refusing writes during it would be a
   * new failure mode on a live recording, for no gain.
   */
  it("still accepts an answer while a recording uploads", async () => {
    const { statements } = wire("uploading");
    const repository = await import("./runtime-repository-postgres");

    await repository.applyRuntimeMutationPostgres(payload(), answer);

    expect(wrote(statements)).toBe(true);
  });

  /**
   * Events must keep working after the session ends, or the terminal states
   * become unreachable: `session_completed` is itself an event, and so are the
   * abandonment and failure events that produce these statuses.
   */
  it.each(["session_completed", "session_abandoned", "session_failed"])(
    "still accepts the %s event on a finished session",
    async (eventType) => {
      const { statements } = wire("completed");
      const repository = await import("./runtime-repository-postgres");

      await repository.applyRuntimeMutationPostgres(payload(), {
        type: "event",
        eventType: eventType as "session_completed"
      });

      expect(statements).toContain("COMMIT");
    }
  );
});
