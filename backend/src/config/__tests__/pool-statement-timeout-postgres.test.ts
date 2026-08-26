import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";

/**
 * THE STATEMENT BOUND ACTUALLY FIRES (cto/AdaptaLabs#40).
 *
 * pool.test.ts next door pins the NUMBERS as literals on the always-on jest
 * gate. It cannot prove they do anything: `options` is a string handed to pg,
 * and asserting a string was passed is not asserting a statement gets cancelled.
 * This file is the other half, and it needs a real server because
 * `statement_timeout` is enforced BY THE SERVER.
 *
 * IT DOES NOT WAIT 120 SECONDS. Two properties, tested apart:
 *
 *   1. the REAL app pool's connections carry the bound - read back from the
 *      server through the live pool, so deleting `options` from config/index.ts
 *      fails here by name;
 *   2. a bound of that shape genuinely CANCELS - demonstrated at 1.5s on a
 *      throwaway pool, with a control proving the cancellation comes from the
 *      option and not from something ambient.
 *
 * Neither arm derives its expectation from POOL_STATEMENT_TIMEOUT_MS. Arm 1
 * asserts the literal "2min", which is how Postgres renders 120000ms - measured,
 * not assumed.
 *
 * EVERY ARM IS BOUNDED. A test of a timeout that hangs is a CI job timeout with
 * no failing test name, which is the exact regression shape #40 is about. The
 * sleeps are 30s against a 1.5s bound and the vitest timeouts are 20s, so a
 * bound that stops working fails by name long before anything hangs.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let appPool: pg.Pool;

describe.skipIf(skipDbTests)("backend pool statement bound against real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("pool-statement-timeout");

    // BEFORE importing ../../config: the pool reads DATABASE_URL once, at import.
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-statement-timeout-constant-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();

    const { pool } = await import("../../config");
    appPool = pool;
  }, 180_000);

  afterAll(async () => {
    await appPool?.end().catch(() => {});
    await postgres?.stop();
    delete process.env.DATABASE_URL;
  });

  it("gives every connection from the REAL app pool a 2 minute statement bound", async () => {
    // Read back from the server, not from the config object, so this covers the
    // whole path: constant -> startup packet -> applied setting.
    //
    // It runs AFTER runMigrations(), which is deliberate. A session-level
    // `SET statement_timeout = 0` on a pooled connection LEAKS to every later
    // checkout of it - measured - so a future migration that raises the bound
    // and forgets to RESET would silently disarm the whole thing. That shows up
    // here as "0" rather than as nothing at all.
    const { rows } = await appPool.query("SHOW statement_timeout");
    expect(rows[0].statement_timeout).toBe("2min");
  }, 20_000);

  it("cancels a statement that outruns the bound, with SQLSTATE 57014", async () => {
    // 1.5s stands in for the 120s the app uses. The MECHANISM is what needs a
    // server; the NUMBER is pinned in pool.test.ts, which runs everywhere.
    const bounded = new pg.Pool({
      connectionString: postgres.connectionString,
      options: "-c statement_timeout=1500",
    });
    try {
      const started = Date.now();
      // A 30s sleep against a 1.5s bound: if the bound is gone this rejects on
      // the 20s test timeout with a name, rather than hanging the runner.
      await expect(bounded.query("SELECT pg_sleep(30)")).rejects.toMatchObject({
        code: "57014",
      });
      expect(Date.now() - started).toBeLessThan(10_000);

      // The connection is genuinely RELEASED, not left poisoned - which is the
      // point of bounding on the server rather than abandoning a promise. A
      // cancel that killed the connection would trade one leak for another.
      const after = await bounded.query("SELECT 1 AS ok");
      expect(after.rows[0].ok).toBe(1);
    } finally {
      await bounded.end();
    }
  }, 20_000);

  it("CONTROL: the same statement completes on a pool with no bound", async () => {
    // Without this the arm above passes just as well if pg_sleep were rejected
    // for some unrelated reason - a missing function, a permissions error, a
    // server that hangs up. It proves the cancellation is caused by the option.
    const unbounded = new pg.Pool({ connectionString: postgres.connectionString });
    try {
      const started = Date.now();
      // Resolving at all is the assertion: the arm above rejects this same
      // statement. The elapsed check stops a server that returned instantly -
      // a stubbed or rewritten pg_sleep - reading as a successful long wait.
      await unbounded.query("SELECT pg_sleep(3)");
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    } finally {
      await unbounded.end();
    }
  }, 20_000);

  it("CONTROL: the client-side bound fires when the server does not answer in time", async () => {
    // query_timeout covers the failure statement_timeout structurally cannot: a
    // server that never replies. #40's own probe was that shape - a pool.query
    // stubbed never to settle - so without this arm the fix would not address
    // the evidence that raised it.
    //
    // No `options` here, so the server is happily running the sleep and simply
    // has not answered. From the client that is indistinguishable from silence.
    const impatient = new pg.Pool({
      connectionString: postgres.connectionString,
      query_timeout: 1500,
    });
    try {
      const started = Date.now();
      await expect(impatient.query("SELECT pg_sleep(30)")).rejects.toThrow(/timeout/i);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await impatient.end();
    }
  }, 20_000);
});
