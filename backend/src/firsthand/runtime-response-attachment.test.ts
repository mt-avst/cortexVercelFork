import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const connectMock = vi.fn();
const onMock = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({ connect: connectMock, on: onMock }))
}));

/**
 * How a stored answer is attached to the question it was given against.
 *
 * This is the highest-consequence code in F2 and it had NO test that could
 * fail - a review gate found that, and every mutation it listed is asserted
 * here. `runtime-answer-immutability.test.ts` touches the same function but
 * only through two substring checks ("did an INSERT happen", "did a DELETE
 * happen"), which stay green while the row being written names the wrong step,
 * carries no prompt, or destroys a detached answer on the way past.
 *
 * Driven against a mocked pg rather than a real database, so what is asserted
 * is the statement and its parameters. That is the honest limit of these: they
 * pin what is SENT, not what Postgres does with it.
 *
 * That limit had teeth. Every test here passed while the statement wrote a row
 * 0015's CHECK refuses - study_id bound to the session while step_id resolved
 * to NULL - which aborted the whole session save and lost the participant's
 * progress. No assertion over SQL text could have caught it, because the text
 * was the text these tests were written against.
 *
 * So `runtime-response-attachment-postgres.test.ts` now runs the same paths
 * against a real Postgres with 0015 applied, and it is the one that proves
 * behaviour. Keep the consequence-level assertions there and the shape-level
 * ones here; when the two disagree, the database is right.
 */
describe("attaching a participant's answer to a step", () => {
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

  /**
   * The wording the PARTICIPANT was shown, and it is deliberately not the
   * wording the current study carries.
   *
   * `session.steps` is a snapshot taken when the session was seeded, so the two
   * diverge the moment a researcher rewords a question. A write that read the
   * prompt from the study instead would store the new wording against an answer
   * given to the old one - which is the mis-description `step_prompt` exists to
   * prevent, and a fixture where the two matched could not tell them apart.
   */
  const PROMPT_AS_SHOWN = "How easy was that, as this participant was asked it?";
  const PROMPT_NOW = "How easy was that?";

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
        step_id: "study_survey_alpha",
        order: 1,
        type: "rating" as const,
        prompt: PROMPT_NOW,
        config: { scale_max: 5 }
      }
    ]
  });

  const sessionRow = () => ({
    session_id: "session_1",
    logical_session_id: "session_1",
    attempt_number: 1,
    token: "fh_token",
    study_id: "study_survey",
    study_title: "Pulse",
    participant_id: "user-42",
    participant_display_name: "User 42",
    session_status: "in_progress",
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
    steps: [
      {
        stepId: "study_survey_alpha",
        order: 1,
        type: "rating",
        prompt: PROMPT_AS_SHOWN
      }
    ],
    created_at: "2026-08-17T00:00:00.000Z",
    updated_at: "2026-08-17T00:00:00.000Z"
  });

  type Call = { sql: string; params: unknown[] };

  const wire = () => {
    const calls: Call[] = [];

    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql: sql.trim(), params: params ?? [] });

        if (sql.startsWith("SET search_path TO firsthand")) return { rowCount: null, rows: [] };
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
          return { rowCount: 1, rows: [sessionRow()] };
        }
        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn()
    };

    connectMock.mockResolvedValue(client);
    return { calls };
  };

  const answer = {
    type: "response" as const,
    stepId: "study_survey_alpha",
    stepType: "rating" as const,
    responsePayload: { rating: 5 }
  };

  const answerOnce = async () => {
    const { calls } = wire();
    const repository = await import("./runtime-repository-postgres");

    await repository.applyRuntimeMutation(payload(), answer);

    return calls;
  };

  const find = (calls: Call[], needle: string) =>
    calls.filter((call) => call.sql.includes(needle));

  it("resolves the step against the table rather than trusting the record", async () => {
    // A bare `$4` here is the mutation that matters: every participant save
    // would then fail with a foreign-key violation the moment a researcher
    // removed that question, losing the participant's progress rather than
    // detaching one answer.
    const [insert] = find(await answerOnce(), "INSERT INTO participant_responses");

    expect(insert.sql).toContain("FROM study_steps ss");
    expect(insert.sql).toContain("ss.study_id = $3 AND ss.id = $4");
    // The lock the foreign key takes for itself. Without it the lookup reads
    // one snapshot and the constraint check reads another, and a concurrent
    // delete between them aborts the whole session write.
    expect(insert.sql).toContain("FOR KEY SHARE");
  });

  it("takes both the study and the step from that one looked-up row", async () => {
    // Not a stylistic preference about CTEs. 0015's CHECK makes BOTH columns
    // null the only legal detached state, so passing the session's own study id
    // straight into the column while step_id falls out of the lookup writes a
    // half-detached row the database refuses - aborting the entire session save
    // for exactly the case the lookup exists to survive.
    //
    // The real-Postgres companion (runtime-response-attachment-postgres.test.ts)
    // is what proves the consequence; this pins the shape so the two columns
    // cannot drift back to separate sources.
    const [insert] = find(await answerOnce(), "INSERT INTO participant_responses");

    expect(insert.sql).toContain("(SELECT study_id FROM attached_step)");
    expect(insert.sql).toContain("(SELECT id FROM attached_step)");
    // $3 and $4 now scope the lookup rather than being stored directly, which
    // is what keeps one study's answer from borrowing another study's step.
    expect(insert.params[2]).toBe("study_survey");
    expect(insert.params[3]).toBe("study_survey_alpha");
  });

  it("records the wording this participant was shown, not the study's current wording", async () => {
    const [insert] = find(await answerOnce(), "INSERT INTO participant_responses");

    expect(insert.params[4]).toBe(PROMPT_AS_SHOWN);
    expect(insert.params[4]).not.toBe(PROMPT_NOW);
  });

  it("does not destroy an answer whose question has been removed", async () => {
    // `DELETE FROM participant_responses WHERE session_id = $1` alone - the
    // pre-F2 statement - erases every detached row on the next ordinary save,
    // which is exactly the loss ON DELETE SET NULL was chosen to avoid. The
    // filter is the only thing standing between a researcher's edit and a
    // participant's answer.
    const [remove] = find(await answerOnce(), "DELETE FROM participant_responses");

    expect(remove.sql).toContain("step_id IS NOT NULL");
  });

  it("does not read a detached answer back into the live session", async () => {
    // The record requires a step id on every response, and there is no live
    // step for a detached one to belong to. Reading it back would fail the
    // runtime shape; it also has to agree with the DELETE above, or the row is
    // read, then not rewritten, and lost.
    const [read] = find(await answerOnce(), "FROM participant_responses");

    expect(read.sql).toContain("step_id IS NOT NULL");
  });

  it("writes the study, the step and the prompt as separate columns", async () => {
    // Dropping a column from the list is silent: `removed_questions` simply
    // never populates, and every other assertion in this file still passes if
    // it only checks the parameters it happens to name.
    const [insert] = find(await answerOnce(), "INSERT INTO participant_responses");

    for (const column of ["study_id", "step_id", "step_prompt"]) {
      expect(insert.sql).toContain(column);
    }
  });
});
