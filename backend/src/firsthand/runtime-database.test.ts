import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const connectMock = vi.fn();
// `on` is part of the mock because the runtime pool now registers an `error`
// listener at construction: without a listener, an error on an idle pooled
// connection is an unhandled EventEmitter error and kills the process.
const onMock = vi.fn();
const poolConstructorMock = vi.fn(() => ({
  connect: connectMock,
  on: onMock
}));

vi.mock("pg", () => ({
  Pool: poolConstructorMock
}));

/**
 * What pg would actually connect with. `pg` is mocked in this file, so this
 * reaches for the real module - the Pool config alone cannot answer the
 * question, because pg merges the parsed connection string over the ssl option.
 */
async function effectiveSsl(poolConfig: unknown) {
  const actualPg = await vi.importActual<typeof import("pg")>("pg");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (new actualPg.Client(poolConfig as any) as any).connectionParameters.ssl;
}

/**
 * What every checkout of the runtime pool starts with.
 *
 * Written out in full rather than composed from the module's own constant: a
 * test that rebuilt the string from `DEFAULT_STATEMENT_TIMEOUT_MS` would go on
 * passing if that value were changed to something that disables the timeout,
 * which is the one change here that must not pass silently.
 */
const RUNTIME_SESSION_PREPARATION =
  "SET search_path TO firsthand; SET statement_timeout TO 15000";

describe("runtime database verification", () => {
  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.DB_URL;
    delete process.env.DB_TLS_VERIFY;
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
      RUNTIME_SESSION_PREPARATION
    );
    expect(operationClient.query).toHaveBeenCalledWith(
      RUNTIME_SESSION_PREPARATION
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

  it("resolves only DATABASE_URL, POSTGRES_URL and DB_URL - legacy vars are not in the chain", async () => {
    // Pin: the hand-rolled precedence chain has already produced one outage in
    // this codebase, and the retired FIRSTHAND_DATABASE_URL secret can linger
    // in the pod env until AWS-side hygiene deletes it. A legacy var must
    // never influence resolution - it now names a destroyed host.
    process.env.FIRSTHAND_DATABASE_URL =
      "postgresql://decommissioned-source.example.invalid:5432/postgres";
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

  it("does not use TLS for a local host such as docker postgres", async () => {
    process.env.DATABASE_URL = "postgres://firsthand:firsthand@localhost:5432/firsthand";
    connectMock.mockResolvedValue(createMockClient({ missingRelations: [] }));

    const runtimeDatabase = await import("./runtime-database");
    runtimeDatabase.getRuntimeDatabasePool();

    // This used to assert `ssl` was UNDEFINED. It is now explicitly `false`,
    // which is a deliberate change: leaving it undefined lets pg fall back to
    // readSSLConfigFromEnvironment(), so a stray PGSSLMODE in the environment
    // could turn TLS on against a plaintext local postgres and break dev with
    // no signal. The decision is made in one place now.
    const poolConfig = (
      poolConstructorMock.mock.calls as unknown as Array<[{ ssl?: unknown }]>
    )[0]?.[0];
    expect(poolConfig?.ssl).toBe(false);
    expect(await effectiveSsl(poolConfig)).toBe(false);
  });

  it("registers an error listener on the runtime pool so a failover cannot kill the process", async () => {
    process.env.DATABASE_URL = "postgres://firsthand:firsthand@localhost:5432/firsthand";
    connectMock.mockResolvedValue(createMockClient({ missingRelations: [] }));

    const runtimeDatabase = await import("./runtime-database");
    runtimeDatabase.getRuntimeDatabasePool();

    // An RDS failover drops every idle connection at once. pg re-emits those
    // on the Pool, and Node throws on an `error` event with no listener, so
    // the absence of this registration is a hard process exit.
    expect(onMock).toHaveBeenCalledWith("error", expect.any(Function));

    // This is the pool carrying withRuntimeDatabaseClient transactions, so it
    // is exactly where the checked-out window matters: pg strips a client's
    // own error listener while it is checked out, and the acquire/release pair
    // is what covers the gaps between statements in a BEGIN/COMMIT.
    expect(onMock).toHaveBeenCalledWith("acquire", expect.any(Function));
    expect(onMock).toHaveBeenCalledWith("release", expect.any(Function));
  });

  it("attaches the error listener once even when the pool is fetched repeatedly", async () => {
    process.env.DATABASE_URL = "postgres://firsthand:firsthand@localhost:5432/firsthand";
    connectMock.mockResolvedValue(createMockClient({ missingRelations: [] }));

    const runtimeDatabase = await import("./runtime-database");
    runtimeDatabase.getRuntimeDatabasePool();
    runtimeDatabase.getRuntimeDatabasePool();
    runtimeDatabase.getRuntimeDatabasePool();

    expect(poolConstructorMock).toHaveBeenCalledTimes(1);
    expect(onMock.mock.calls.filter(([event]) => event === "error")).toHaveLength(1);
  });

  it("still lets an explicit sslmode in the URL win while verification is off", async () => {
    process.env.DB_URL =
      "postgresql://firsthand:secret@firsthand.abc123.us-east-1.rds.amazonaws.com:5432/postgres?sslmode=disable";
    connectMock.mockResolvedValue(createMockClient({ missingRelations: [] }));

    const runtimeDatabase = await import("./runtime-database");
    runtimeDatabase.getRuntimeDatabasePool();

    // The old assertion was that `ssl` was undefined, which is the WRONG LAYER:
    // pg merges the parsed connection string over the ssl option, so what the
    // Pool was handed never settled what it connected with. Assert the outcome
    // instead. With DB_TLS_VERIFY unset the string still wins, so behaviour is
    // unchanged - see the DB_TLS_VERIFY case below for where it stops winning.
    const poolConfig = (
      poolConstructorMock.mock.calls as unknown as Array<[{ ssl?: unknown }]>
    )[0]?.[0];
    expect(await effectiveSsl(poolConfig)).toBe(false);
  });

  it("stops an sslmode in the URL winning once DB_TLS_VERIFY is set", async () => {
    process.env.DB_URL =
      "postgresql://firsthand:secret@firsthand.abc123.us-east-1.rds.amazonaws.com:5432/postgres?sslmode=disable";
    process.env.DB_TLS_VERIFY = "1";
    connectMock.mockResolvedValue(createMockClient({ missingRelations: [] }));

    const runtimeDatabase = await import("./runtime-database");
    runtimeDatabase.getRuntimeDatabasePool();

    const poolConfig = (
      poolConstructorMock.mock.calls as unknown as Array<[{ ssl?: unknown }]>
    )[0]?.[0];
    const ssl = await effectiveSsl(poolConfig);
    expect(ssl).not.toBe(false);
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toBeTruthy();
  });
});

function createMockClient(input: { missingRelations: string[] }) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    // Matched as a WHOLE STRING, not by `includes`, and that is the assertion
    // rather than a convenience. The search path and the per-statement bound
    // are issued together in one round trip, so a version that dropped the
    // bound - or emitted `SET LOCAL`, which outside a transaction sets nothing
    // at all - would still contain "SET search_path TO firsthand" and pass a
    // substring check.
    if (sql === RUNTIME_SESSION_PREPARATION) {
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
