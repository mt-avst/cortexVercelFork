import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const connectMock = vi.fn();
const poolConstructorMock = vi.fn(() => ({
  connect: connectMock
}));

vi.mock("pg", () => ({
  Pool: poolConstructorMock
}));

type MockClient = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

const baseStep = {
  step_id: "step_001",
  order: 1,
  type: "instruction" as const,
  prompt: "Talk through the page out loud.",
  is_required: true,
  helper_text: "Be specific",
  target_url: "/demo-target/checkout"
};

const choiceStep = {
  step_id: "step_002",
  order: 2,
  type: "single_choice" as const,
  prompt: "Would you sponsor a spike?",
  is_required: true,
  options: ["Yes", "Maybe", "No"]
};

const endStep = {
  step_id: "step_end",
  order: 3,
  type: "end" as const,
  prompt: "Thanks for taking part."
};

describe("studies repository", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://firsthand:firsthand@localhost:5432/firsthand";
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
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

  it("returns an empty list when persistence is not configured", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;

    const studiesRepository = await import("./studies-repository");

    await expect(studiesRepository.listStudies()).resolves.toEqual([]);
    expect(studiesRepository.isStudiesPersistenceConfigured()).toBe(false);
  });

  it("inserts a study and its steps in a single transaction", async () => {
    const verificationClient = createMockClient({ missingRelations: [] });
    const operationClient = createMockClient({ missingRelations: [] });

    operationClient.query.mockImplementation(async (sql: string) => {
      if (sql === "SET search_path TO firsthand, public") {
        return { rowCount: null, rows: [] };
      }

      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rowCount: null, rows: [] };
      }

      if (sql.includes("INSERT INTO studies")) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("INSERT INTO study_steps")) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("FROM studies")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "study_abc",
              title: "Sample",
              intro_text: "Intro",
              consent_text: "Consent",
              brand_name: "Adaptavist",
              estimated_duration_minutes: 15,
              locale: "en-GB",
              status: "draft",
              created_at: "2026-06-08T00:00:00.000Z",
              updated_at: "2026-06-08T00:00:00.000Z"
            }
          ]
        };
      }

      if (sql.includes("FROM study_steps")) {
        return {
          rowCount: 3,
          rows: [
            {
              id: "step_001",
              study_id: "study_abc",
              step_order: 1,
              type: "instruction",
              prompt: "Talk through the page out loud.",
              target_url: "/demo-target/checkout",
              helper_text: "Be specific",
              is_required: true,
              options: null
            },
            {
              id: "step_002",
              study_id: "study_abc",
              step_order: 2,
              type: "single_choice",
              prompt: "Would you sponsor a spike?",
              target_url: null,
              helper_text: null,
              is_required: true,
              options: ["Yes", "Maybe", "No"]
            },
            {
              id: "step_end",
              study_id: "study_abc",
              step_order: 3,
              type: "end",
              prompt: "Thanks for taking part.",
              target_url: null,
              helper_text: null,
              is_required: false,
              options: null
            }
          ]
        };
      }

      throw new Error(`Unexpected query in test: ${sql}`);
    });

    connectMock
      .mockResolvedValueOnce(verificationClient)
      .mockResolvedValueOnce(operationClient);

    const studiesRepository = await import("./studies-repository");

    const result = await studiesRepository.createStudy({
      id: "study_abc",
      title: "Sample",
      intro_text: "Intro",
      consent_text: "Consent",
      brand_name: "Adaptavist",
      estimated_duration_minutes: 15,
      locale: "en-GB",
      steps: [baseStep, choiceStep, endStep]
    });

    expect(result.study.id).toBe("study_abc");
    expect(result.study.status).toBe("draft");
    expect(result.steps).toHaveLength(3);
    expect(result.steps[1].options).toEqual(["Yes", "Maybe", "No"]);

    const studyInserts = operationClient.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO studies")
    );
    const stepInserts = operationClient.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO study_steps")
    );

    expect(studyInserts).toHaveLength(1);
    expect(stepInserts).toHaveLength(3);
    expect(
      operationClient.query.mock.calls.some((call) => call[0] === "BEGIN")
    ).toBe(true);
    expect(
      operationClient.query.mock.calls.some((call) => call[0] === "COMMIT")
    ).toBe(true);
  });

  it("rejects steps that fail integrity rules before touching the database", async () => {
    const studiesRepository = await import("./studies-repository");

    await expect(
      studiesRepository.createStudy({
        title: "Broken",
        intro_text: "Intro",
        consent_text: "Consent",
        steps: [
          baseStep,
          {
            ...baseStep,
            order: 2
          }
        ]
      })
    ).rejects.toThrow(/Duplicate step_id/);

    await expect(
      studiesRepository.createStudy({
        title: "Broken",
        intro_text: "Intro",
        consent_text: "Consent",
        steps: [
          {
            step_id: "step_only",
            order: 1,
            type: "single_choice",
            prompt: "Pick one",
            options: ["Only one"]
          }
        ]
      })
    ).rejects.toThrow(/at least two options/);

    expect(connectMock).not.toHaveBeenCalled();
  });

  it("rolls back when an underlying insert fails", async () => {
    const verificationClient = createMockClient({ missingRelations: [] });
    const operationClient = createMockClient({ missingRelations: [] });
    let stepInsertAttempts = 0;

    operationClient.query.mockImplementation(async (sql: string) => {
      if (sql === "SET search_path TO firsthand, public") {
        return { rowCount: null, rows: [] };
      }

      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }

      if (sql.includes("INSERT INTO studies")) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("INSERT INTO study_steps")) {
        stepInsertAttempts += 1;
        throw new Error("duplicate key value violates unique constraint");
      }

      throw new Error(`Unexpected query in test: ${sql}`);
    });

    connectMock
      .mockResolvedValueOnce(verificationClient)
      .mockResolvedValueOnce(operationClient);

    const studiesRepository = await import("./studies-repository");

    await expect(
      studiesRepository.createStudy({
        id: "study_abc",
        title: "Sample",
        intro_text: "Intro",
        consent_text: "Consent",
        steps: [baseStep, endStep]
      })
    ).rejects.toThrow(/duplicate key/);

    expect(stepInsertAttempts).toBeGreaterThan(0);
    expect(
      operationClient.query.mock.calls.some((call) => call[0] === "ROLLBACK")
    ).toBe(true);
  });
});

function createMockClient(input: { missingRelations: string[] }): MockClient {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === "SET search_path TO firsthand, public") {
      return {
        rowCount: null,
        rows: []
      };
    }

    if (sql.includes("SELECT relation_path, to_regclass(relation_path) AS regclass")) {
      const relationPaths = (params?.[0] as string[]) ?? [];

      return {
        rowCount: relationPaths.length,
        rows: relationPaths.map((relationPath) => ({
          relation_path: relationPath,
          regclass: input.missingRelations.includes(relationPath) ? null : relationPath
        }))
      };
    }

    throw new Error(`Unexpected query in test: ${sql}`);
  });

  return {
    query,
    release: vi.fn()
  };
}
