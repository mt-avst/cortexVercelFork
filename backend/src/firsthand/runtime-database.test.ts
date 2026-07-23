import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const connectMock = vi.fn();
const poolConstructorMock = vi.fn(() => ({
  connect: connectMock
}));

vi.mock("pg", () => ({
  Pool: poolConstructorMock
}));

describe("runtime database verification", () => {
  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.DB_URL;
    delete process.env.FIRSTHAND_DATABASE_URL;
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

  it("verifies the migrated firsthand schema before using postgres persistence", async () => {
    process.env.DATABASE_URL = "postgres://firsthand:firsthand@localhost:5432/firsthand";

    const verificationClient = createMockClient({
      missingRelations: []
    });
    const operationClient = createMockClient({
      missingRelations: []
    });
    connectMock
      .mockResolvedValueOnce(verificationClient)
      .mockResolvedValueOnce(operationClient);

    const runtimeDatabase = await import("./runtime-database");
    const result = await runtimeDatabase.withRuntimeDatabaseClient(async () => "ok");

    expect(result).toBe("ok");
    expect(poolConstructorMock).toHaveBeenCalledTimes(1);
    expect(verificationClient.query).toHaveBeenCalledWith(
      "SET search_path TO firsthand"
    );
    expect(operationClient.query).toHaveBeenCalledWith(
      "SET search_path TO firsthand"
    );
    expect(verificationClient.release).toHaveBeenCalledOnce();
    expect(operationClient.release).toHaveBeenCalledOnce();
  });

  it("throws a helpful error when the firsthand schema has not been migrated", async () => {
    process.env.POSTGRES_URL = "postgres://firsthand:firsthand@localhost:5432/firsthand";

    const verificationClient = createMockClient({
      missingRelations: ["firsthand.runtime_sessions", "firsthand.runtime_events"]
    });
    connectMock.mockResolvedValue(verificationClient);

    const runtimeDatabase = await import("./runtime-database");

    await expect(runtimeDatabase.ensureRuntimeDatabase()).rejects.toThrow(
      /npm run db:migrate/
    );
    await expect(runtimeDatabase.ensureRuntimeDatabase()).rejects.toThrow(
      /firsthand\.runtime_sessions/
    );
    expect(connectMock).toHaveBeenCalledTimes(2);
  });
});

describe("Kubera database environment", () => {
  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.DB_URL;
    delete process.env.FIRSTHAND_DATABASE_URL;
    delete (globalThis as typeof globalThis & { __firsthandRuntimePool?: unknown })
      .__firsthandRuntimePool;
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("accepts Kubera's injected DB_URL and flips persistence mode to postgres", async () => {
    process.env.DB_URL =
      "postgresql://firsthand:secret@firsthand.abc123.us-east-1.rds.amazonaws.com:5432/postgres";

    const runtimeDatabase = await import("./runtime-database");

    expect(runtimeDatabase.isPostgresRuntimeConfigured()).toBe(true);
    expect(runtimeDatabase.getRuntimeDatabaseUrl()).toBe(process.env.DB_URL);
  });

  it("ignores FIRSTHAND_DATABASE_URL after the Phase C cutover (rollback = git revert)", async () => {
    process.env.FIRSTHAND_DATABASE_URL =
      "postgresql://firsthand:secret@firsthand-source.abc123.us-east-1.rds.amazonaws.com:5432/postgres";
    process.env.DB_URL =
      "postgresql://cortex:secret@adaptalabs.def456.us-east-1.rds.amazonaws.com:5432/postgres";

    const runtimeDatabase = await import("./runtime-database");

    expect(runtimeDatabase.getRuntimeDatabaseUrl()).toBe(process.env.DB_URL);
  });

  it("prefers DATABASE_URL over Kubera's DB_URL when both are set", async () => {
    process.env.DATABASE_URL = "postgres://explicit:secret@localhost:5432/firsthand";
    process.env.DB_URL =
      "postgresql://firsthand:secret@firsthand.abc123.us-east-1.rds.amazonaws.com:5432/postgres";

    const runtimeDatabase = await import("./runtime-database");

    expect(runtimeDatabase.getRuntimeDatabaseUrl()).toBe(process.env.DATABASE_URL);
  });

  it("enables ssl for RDS hosts, which enforce TLS but present a CA outside Node's trust store", async () => {
    process.env.DB_URL =
      "postgresql://firsthand:secret@firsthand.abc123.us-east-1.rds.amazonaws.com:5432/postgres";
    connectMock.mockResolvedValue(createMockClient({ missingRelations: [] }));

    const runtimeDatabase = await import("./runtime-database");
    runtimeDatabase.getRuntimeDatabasePool();

    expect(poolConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10_000
      })
    );
  });

  it("does not force ssl for non-RDS hosts such as local docker postgres", async () => {
    process.env.DATABASE_URL = "postgres://firsthand:firsthand@localhost:5432/firsthand";
    connectMock.mockResolvedValue(createMockClient({ missingRelations: [] }));

    const runtimeDatabase = await import("./runtime-database");
    runtimeDatabase.getRuntimeDatabasePool();

    const poolConfig = (
      poolConstructorMock.mock.calls as unknown as Array<[{ ssl?: unknown }]>
    )[0]?.[0];
    expect(poolConfig?.ssl).toBeUndefined();
  });

  it("lets an explicit sslmode in the URL win over host-based ssl detection", async () => {
    process.env.DB_URL =
      "postgresql://firsthand:secret@firsthand.abc123.us-east-1.rds.amazonaws.com:5432/postgres?sslmode=disable";
    connectMock.mockResolvedValue(createMockClient({ missingRelations: [] }));

    const runtimeDatabase = await import("./runtime-database");
    runtimeDatabase.getRuntimeDatabasePool();

    const poolConfig = (
      poolConstructorMock.mock.calls as unknown as Array<[{ ssl?: unknown }]>
    )[0]?.[0];
    expect(poolConfig?.ssl).toBeUndefined();
  });
});

function createMockClient(input: { missingRelations: string[] }) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === "SET search_path TO firsthand") {
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
