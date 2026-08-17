import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const connectMock = vi.fn();
const onMock = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({ connect: connectMock, on: onMock }))
}));

/**
 * The opportunity a session was started from has to reach the COLUMN, not just
 * the payload.
 *
 * `session_payload` already stores the whole payload as JSONB, so a change that
 * only reaches that would look right in every payload-level assertion while the
 * column the results gate filters on stayed NULL - and a NULL row is treated as
 * unattributable and refused to everyone but a superadmin. That failure is
 * silent and presents as "the researcher cannot see their own results".
 */
describe("runtime session rows carry their opportunity", () => {
  beforeEach(() => {
    process.env.DATABASE_URL =
      "postgres://firsthand:firsthand@localhost:5432/firsthand";
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete (globalThis as typeof globalThis & { __firsthandRuntimePool?: unknown })
      .__firsthandRuntimePool;
    delete (
      globalThis as typeof globalThis & {
        __firsthandRuntimeVerification?: unknown;
      }
    ).__firsthandRuntimeVerification;
    vi.clearAllMocks();
    vi.resetModules();
  });

  const payloadWith = (opportunityId?: string) => ({
    contract_version: "1.0" as const,
    study: {
      id: "study_abc",
      title: "Pulse",
      intro_text: "Intro",
      consent_text: "Consent"
    },
    participant: {
      participant_id: "user-42",
      display_name: "User 42",
      // Deliberately NOT the same value as opportunity_id. When they matched,
      // an assertion that the params merely CONTAIN the id passed against a
      // build that never wrote the column at all - it was matching
      // external_ref's binding. Distinct values plus a positional lookup is
      // what makes these tests bite.
      external_ref: "ref-external"
    },
    session: {
      session_id: "session_1",
      session_token: "fh_token",
      study_id: "study_abc",
      participant_id: "user-42",
      ...(opportunityId ? { opportunity_id: opportunityId } : {})
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

  const wire = () => {
    const inserts: Array<{ sql: string; params: unknown[] }> = [];

    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === "SET search_path TO firsthand") {
          return { rowCount: null, rows: [] };
        }

        if (
          sql.includes("SELECT relation_path, to_regclass(relation_path) AS regclass")
        ) {
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

        // The reload AFTER the insert has to answer a row, or the seed throws
        // "could not be loaded after seeding" - and swallowing that throw is
        // what let a broken write look like a passing test. The lookup BEFORE
        // it must stay empty, otherwise ensureRuntimeSessionRow short-circuits
        // on an existing row and never inserts at all.
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
                study_title: "Pulse",
                participant_id: "user-42",
                participant_display_name: "User 42",
                session_status: "created",
                transcript_status: "not_started",
                microphone_permission: "unknown",
                screen_permission: "unknown",
                recording_status: "idle",
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

    connectMock.mockResolvedValue(client);

    return { inserts };
  };

  /**
   * Positional, not `toContain`. The column list naming `opportunity_id` says
   * nothing about what is bound to it, and a value assertion over the whole
   * parameter array matches any other binding that happens to hold the same
   * string.
   */
  const columnIndex = (sql: string, column: string) =>
    sql
      .slice(sql.indexOf("("), sql.indexOf(") VALUES"))
      .split(",")
      .map((name) => name.replace(/[()\s]/g, ""))
      .indexOf(column);

  it("writes the opportunity id into its own column", async () => {
    const { inserts } = wire();
    const repository = await import("./runtime-repository-postgres");

    await repository.seedRuntimeSessionPostgres(payloadWith("opp-77"));

    expect(inserts).toHaveLength(1);

    const index = columnIndex(inserts[0].sql, "opportunity_id");
    expect(index).toBeGreaterThan(-1);
    expect(inserts[0].params[index]).toBe("opp-77");
  });

  /**
   * The correlation hint and the authorisation key are different fields and
   * must not be wired to each other, however identical their values look on
   * the one route that sets both today.
   */
  it("does not fill the column from the caller-facing correlation field", async () => {
    const { inserts } = wire();
    const repository = await import("./runtime-repository-postgres");

    await repository.seedRuntimeSessionPostgres(payloadWith("opp-77"));

    const index = columnIndex(inserts[0].sql, "opportunity_id");
    expect(inserts[0].params[index]).not.toBe("ref-external");
  });

  /**
   * A session with no opportunity must store NULL rather than a placeholder:
   * the results gate reads NULL as "cannot be attributed" and refuses below
   * superadmin, and any non-null stand-in would be read as a real claim.
   */
  it("writes null when the session did not come from an opportunity", async () => {
    const { inserts } = wire();
    const repository = await import("./runtime-repository-postgres");

    await repository.seedRuntimeSessionPostgres(payloadWith());

    const index = columnIndex(inserts[0].sql, "opportunity_id");

    expect(index).toBeGreaterThan(-1);
    expect(inserts[0].params[index]).toBeNull();
  });
});
