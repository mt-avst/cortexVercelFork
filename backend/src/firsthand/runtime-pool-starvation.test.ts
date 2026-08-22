import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The defect, reproduced: admin traffic filling a five-connection pool while a
 * participant tries to save their answers.
 *
 * This deliberately does NOT count requests. A rate limiter already counts
 * requests, and counting them is exactly why the finding stayed open - sixty
 * arrivals a minute are permitted to be sixty checkouts at t=0. So the pool
 * here is a real finite pool with a FIFO waiting queue, every flooding request
 * HOLDS its connection for the length of the assertion, and the question asked
 * is the only one that matters: did the participant get a connection while all
 * that was in flight?
 *
 * The control case is the same scenario with the flood classified as
 * participant work. Participant work is uncapped, so that is precisely how ALL
 * of this behaved before the admission gate existed - and there the
 * participant is starved. Without that pair, a green test here would be
 * consistent with a harness that could not starve anybody.
 */

const POOL_MAX = 5;

type FakeClient = {
  query: ReturnType<typeof vi.fn>;
  release: () => void;
};

/** A pool of POOL_MAX connections with a FIFO queue, and nothing else. */
class FakePool {
  public peakInUse = 0;

  private inUse = 0;

  private readonly waiting: Array<(client: FakeClient) => void> = [];

  public readonly issued: FakeClient[] = [];

  on() {
    return this;
  }

  connect(): Promise<FakeClient> {
    if (this.inUse < POOL_MAX) {
      return Promise.resolve(this.take());
    }

    return new Promise<FakeClient>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  waitingCount() {
    return this.waiting.length;
  }

  private take(): FakeClient {
    this.inUse += 1;
    this.peakInUse = Math.max(this.peakInUse, this.inUse);

    const client: FakeClient = {
      query: vi.fn(async (text: string) => {
        if (text.includes("to_regclass")) {
          return {
            rows: [
              { relation_path: "firsthand.runtime_sessions", regclass: "1" }
            ]
          };
        }
        return { rows: [] };
      }),
      release: () => {
        const next = this.waiting.shift();
        if (next) {
          next(this.take());
        }
        this.inUse -= 1;
      }
    };

    this.issued.push(client);
    return client;
  }
}

let pool: FakePool;

vi.mock("pg", () => ({
  Pool: vi.fn(() => pool)
}));

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

type RuntimeDatabaseModule = typeof import("./runtime-database");
type AdmissionModule = typeof import("./runtime-pool-admission");

async function loadModules(): Promise<{
  runtimeDatabase: RuntimeDatabaseModule;
  admission: AdmissionModule;
}> {
  const runtimeDatabase = await import("./runtime-database");
  const admission = await import("./runtime-pool-admission");
  admission.resetRuntimeAdmissionForTests();
  return { runtimeDatabase, admission };
}

/**
 * Starts `count` checkouts that take a connection and never give it back until
 * the returned `release` is called. Resolves once every one of them has either
 * taken a connection or joined a queue, so the assertion that follows is made
 * against a settled state rather than a race.
 */
function holdConnections(
  runtimeDatabase: RuntimeDatabaseModule,
  count: number,
  wrap: (operation: () => Promise<unknown>) => Promise<unknown>
) {
  let releaseAll = () => {};
  const allReleased = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });

  const started: Array<Promise<unknown>> = [];
  let holding = 0;

  for (let index = 0; index < count; index += 1) {
    started.push(
      wrap(() =>
        runtimeDatabase.withRuntimeDatabaseClient(async () => {
          holding += 1;
          await allReleased;
          return null;
        })
      ).catch(() => null)
    );
  }

  return {
    settled: Promise.resolve().then(settle).then(settle).then(settle),
    holdingCount: () => holding,
    release: async () => {
      releaseAll();
      await Promise.all(started);
    }
  };
}

beforeEach(() => {
  pool = new FakePool();
  process.env.DATABASE_URL = "postgres://firsthand:firsthand@localhost:5432/fh";
});

afterEach(async () => {
  delete process.env.DATABASE_URL;
  delete (globalThis as typeof globalThis & { __firsthandRuntimePool?: unknown })
    .__firsthandRuntimePool;
  delete (
    globalThis as typeof globalThis & { __firsthandRuntimeVerification?: unknown }
  ).__firsthandRuntimeVerification;
  vi.clearAllMocks();
  vi.resetModules();
});

describe("a participant writing while admin work floods the pool", () => {
  it("gets a connection, because admin checkouts are capped below the pool", async () => {
    const { runtimeDatabase, admission } = await loadModules();

    // Sixty, which is exactly what the router's 60-a-minute read ceiling
    // permits to arrive at once.
    const flood = holdConnections(runtimeDatabase, 60, (operation) => operation());
    await flood.settled;

    let participantRan = false;
    const participantWrite = admission.runAsParticipantWork(() =>
      runtimeDatabase.withRuntimeDatabaseClient(async () => {
        participantRan = true;
        return "saved";
      })
    );

    await expect(participantWrite).resolves.toBe("saved");
    expect(participantRan).toBe(true);

    // The cap is what did it: only ADMIN_CONCURRENCY_LIMIT of the sixty ever
    // reached the pool, so the participant was never behind a queue.
    expect(flood.holdingCount()).toBe(admission.ADMIN_CONCURRENCY_LIMIT);
    expect(pool.waitingCount()).toBe(0);

    await flood.release();
  });

  it("is starved when the same flood is uncapped, which is how this behaved before", async () => {
    const { runtimeDatabase, admission } = await loadModules();

    // The control. Participant work is uncapped by design, so classifying the
    // flood as participant work reproduces the pre-fix behaviour of every
    // caller exactly.
    const flood = holdConnections(runtimeDatabase, 60, (operation) =>
      admission.runAsParticipantWork(operation)
    );
    await flood.settled;

    let participantRan = false;
    const participantWrite = admission
      .runAsParticipantWork(() =>
        runtimeDatabase.withRuntimeDatabaseClient(async () => {
          participantRan = true;
          return "saved";
        })
      )
      .catch(() => "failed");

    await settle();
    await settle();

    // Still queued on pool.connect(). In the deployment this is where it waits
    // out connectionTimeoutMillis and the participant loses their answers.
    expect(participantRan).toBe(false);
    expect(pool.peakInUse).toBe(POOL_MAX);
    expect(pool.waitingCount()).toBeGreaterThan(0);

    await flood.release();
    await participantWrite;
  });

  it("leaves room for three of them at once, through a pool of five", async () => {
    const { runtimeDatabase, admission } = await loadModules();

    const flood = holdConnections(runtimeDatabase, 60, (operation) => operation());
    await flood.settled;

    // THREE, written as a literal rather than read from
    // PARTICIPANT_RESERVED_CONNECTIONS. Derived from the constant, this test
    // would scale itself down with any narrowing of the reservation and go on
    // passing - which is exactly what it did until a mutation run caught it.
    const participants = holdConnections(runtimeDatabase, 3, (operation) =>
      admission.runAsParticipantWork(operation)
    );
    await participants.settled;

    expect(participants.holdingCount()).toBe(3);
    expect(pool.waitingCount()).toBe(0);
    expect(pool.peakInUse).toBeLessThanOrEqual(POOL_MAX);

    await participants.release();
    await flood.release();
  });

  it("never lets admin work occupy more of the pool than its ceiling", async () => {
    const { runtimeDatabase, admission } = await loadModules();

    const flood = holdConnections(runtimeDatabase, 40, (operation) => operation());
    await flood.settled;

    // The verification checkout is released before any of these, so the peak
    // is the admin ceiling and not one more than it.
    expect(pool.peakInUse).toBeLessThanOrEqual(
      admission.ADMIN_CONCURRENCY_LIMIT
    );

    await flood.release();
  });
});

describe("a checkout nested inside another checkout", () => {
  it("does not deadlock the seam once the cap is full", async () => {
    const { runtimeDatabase, admission } = await loadModules();

    // Fill the cap with holders that are NOT the nesting one, so a nested
    // checkout that took its own permit would have to wait for a slot its own
    // caller is holding - a hang, on the pool participants share.
    const flood = holdConnections(
      runtimeDatabase,
      admission.ADMIN_CONCURRENCY_LIMIT - 1,
      (operation) => operation()
    );
    await flood.settled;

    // Asserted at the SEAM, not against runHoldingRuntimeSlot directly.
    // Testing the helper only proves the helper works; the mutation that
    // matters is `withRuntimeDatabaseClient` forgetting to use it, and that
    // one is invisible from a test that calls the helper itself.
    const nested = runtimeDatabase.withRuntimeDatabaseClient(async () =>
      runtimeDatabase.withRuntimeDatabaseClient(async () => "inner")
    );

    await expect(nested).resolves.toBe("inner");

    await flood.release();
  });
});

describe("the per-statement bound", () => {
  it("sets one on every checkout, in the same round trip as the search path", async () => {
    const { runtimeDatabase } = await loadModules();

    await runtimeDatabase.withRuntimeDatabaseClient(async () => null);
    await runtimeDatabase.withRuntimeDatabaseClient(async () => null);

    const preparations = pool.issued.map(
      (client) => client.query.mock.calls[0]?.[0] as string | undefined
    );

    // COUNTED, not merely filtered. The first version filtered the flattened
    // call list for statements starting with "SET " and asserted each of them,
    // guarding only the UNFILTERED length - so a version that issued no
    // preparation at all ran the loop zero times and passed a test titled
    // "every checkout". Every client the pool handed out must have been
    // prepared, including the startup verification one.
    expect(pool.issued.length).toBeGreaterThanOrEqual(3);
    expect(preparations).toHaveLength(pool.issued.length);
    for (const statement of preparations) {
      expect(statement).toBe(
        `SET search_path TO firsthand; SET statement_timeout TO ${runtimeDatabase.DEFAULT_STATEMENT_TIMEOUT_MS}`
      );
    }
  });

  it("holds both statement bounds at the values that were decided", async () => {
    // PINNED as literals. Every other assertion in this file reads the
    // constants back, so a mutation dropping RESULTS_STATEMENT_TIMEOUT_MS from
    // 120s to 1s survived the entire suite - and in production would have
    // cancelled every real export as a 500. The default was already pinned in
    // runtime-database.test.ts; this was the one left underived and unpinned.
    const { runtimeDatabase } = await loadModules();

    expect(runtimeDatabase.DEFAULT_STATEMENT_TIMEOUT_MS).toBe(15_000);
    expect(runtimeDatabase.RESULTS_STATEMENT_TIMEOUT_MS).toBe(120_000);
    expect(runtimeDatabase.RESULTS_STATEMENT_TIMEOUT_MS).toBeGreaterThan(
      runtimeDatabase.DEFAULT_STATEMENT_TIMEOUT_MS
    );
  });

  it("uses the loose bound when the caller asks for it", async () => {
    const { runtimeDatabase } = await loadModules();

    await runtimeDatabase.withRuntimeDatabaseClient(async () => null, {
      statementTimeoutMs: runtimeDatabase.RESULTS_STATEMENT_TIMEOUT_MS
    });

    const lastClient = pool.issued[pool.issued.length - 1];
    expect(lastClient.query).toHaveBeenCalledWith(
      `SET search_path TO firsthand; SET statement_timeout TO ${runtimeDatabase.RESULTS_STATEMENT_TIMEOUT_MS}`
    );
  });

  it("never emits SET LOCAL, which outside a transaction sets nothing at all", async () => {
    const { runtimeDatabase } = await loadModules();

    await runtimeDatabase.withRuntimeDatabaseClient(async () => null);

    const statements = pool.issued.flatMap((client) =>
      client.query.mock.calls.map((call) => String(call[0]))
    );

    expect(statements.some((text) => /SET\s+LOCAL/i.test(text))).toBe(false);
  });

  it("refuses to disable the timeout, whatever it is handed", async () => {
    const { runtimeDatabase } = await loadModules();

    for (const requested of [0, -1, Number.NaN, 0.4]) {
      await runtimeDatabase.withRuntimeDatabaseClient(async () => null, {
        statementTimeoutMs: requested
      });
    }

    const settings = pool.issued
      .flatMap((client) => client.query.mock.calls.map((call) => String(call[0])))
      .filter((text) => text.includes("statement_timeout"))
      .map((text) => Number(text.split("statement_timeout TO ")[1]));

    expect(settings).not.toHaveLength(0);
    for (const value of settings) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});

describe("giving the slot back", () => {
  it("releases it when the pool refuses the connection", async () => {
    const { runtimeDatabase, admission } = await loadModules();

    // Let the startup verification succeed, then break every checkout after
    // it: an RDS failover drops every connection at once, so this is a routine
    // event and not only an incident one.
    await runtimeDatabase.withRuntimeDatabaseClient(async () => null);
    vi.spyOn(pool, "connect").mockRejectedValue(new Error("pool is down"));

    for (let index = 0; index < admission.ADMIN_CONCURRENCY_LIMIT + 2; index += 1) {
      await expect(
        runtimeDatabase.withRuntimeDatabaseClient(async () => null)
      ).rejects.toThrow("pool is down");
    }

    // Without the release the cap would have narrowed by one per failure and
    // closed completely - permanently, on a pool that had since recovered.
    expect(admission.runtimeAdmissionStats()).toEqual({
      available: admission.ADMIN_CONCURRENCY_LIMIT,
      waiting: 0
    });
  });

  it("releases it even when returning the connection throws", async () => {
    const { runtimeDatabase, admission } = await loadModules();

    await runtimeDatabase.withRuntimeDatabaseClient(async () => null);

    // pg throws on a double release. Sequential `client.release();
    // admission.release();` lets that exception escape the finally with the
    // permit still held - permanently, on a cap of two.
    const nextClient = () => {
      const client = pool.issued[pool.issued.length - 1];
      client.release = () => {
        throw new Error("Release called more than once on the same client");
      };
    };

    await expect(
      runtimeDatabase.withRuntimeDatabaseClient(async () => {
        nextClient();
        return null;
      })
    ).rejects.toThrow(/Release called more than once/);

    expect(admission.runtimeAdmissionStats()).toEqual({
      available: admission.ADMIN_CONCURRENCY_LIMIT,
      waiting: 0
    });
  });

  it("releases it when the operation throws", async () => {
    const { runtimeDatabase, admission } = await loadModules();

    await expect(
      runtimeDatabase.withRuntimeDatabaseClient(async () => {
        throw new Error("query failed");
      })
    ).rejects.toThrow("query failed");

    expect(admission.runtimeAdmissionStats().available).toBe(
      admission.ADMIN_CONCURRENCY_LIMIT
    );
  });
});
