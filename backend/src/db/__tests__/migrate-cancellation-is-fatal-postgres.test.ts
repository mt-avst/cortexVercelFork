import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";

/**
 * A CANCELLED MIGRATION MUST NOT REPORT SUCCESS (cto/AdaptaLabs#40).
 *
 * Twelve blocks in migrate.ts wrap `IF NOT EXISTS` DDL in a try/catch that
 * logged "may already exist" and carried on, swallowing every error class. That
 * was survivable while nothing bounded a statement. Once #40 put a 120s
 * `statement_timeout` on this pool it became a SILENT DEPLOY FAILURE: a
 * cancelled statement logged as "may already exist", followed by
 * "Database migrations completed successfully", with the constraint absent.
 *
 * The riskiest one is real rather than theoretical - the dedup step is
 *
 *   DELETE FROM opportunity_session_events WHERE id NOT IN (SELECT DISTINCT ON ...)
 *
 * a `NOT IN` anti-join over a table that grows with every participant session
 * lifecycle event, and the `CREATE UNIQUE INDEX` that depends on it.
 *
 * FAULT INJECTION, NOT MOCKING. The migration runs against a real Postgres and
 * every statement executes for real; a proxy around the pooled client rejects
 * ONE named statement with an error object carrying a real SQLSTATE. So the
 * arms below differ from a normal run by exactly one error code, which is what
 * makes the comparison mean anything.
 *
 * WHY THE THIRD ARM MATTERS MOST. Making a migration fail on any error is easy
 * and wrong - these blocks exist to tolerate "the schema is already in this
 * shape". The 42710 arm proves the change is a NARROWING rather than a blanket
 * rethrow. Without it, `throw error` with no predicate would pass arms 1 and 2.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

/** The statement the dedup block runs first, matched on a distinctive fragment. */
const DEDUP_DELETE = "DELETE FROM opportunity_session_events";

let postgres: TestPostgres;
let pool: pg.Pool;
let runMigrations: () => Promise<void>;

/**
 * Runs the migration with the dedup DELETE rejected as `code`, and ALWAYS puts
 * `pool.connect` back.
 *
 * Patches `connect` rather than `query` because migrate.ts checks out one client
 * and runs the whole migration on it.
 *
 * THE RESTORE IS NOT TIDYING, IT IS THE DIFFERENCE BETWEEN A NAMED FAILURE AND A
 * HANG. `Pool.prototype.query` calls `this.connect(callback)` - the CALLBACK
 * form. An `async () => {...}` override ignores that argument, so the callback
 * is never invoked and every later `pool.query` waits for ever. Left installed,
 * this helper turned the arm below into a 120s test timeout instead of an
 * assertion, which is precisely the "would a test fail by name, or would the
 * suite hang?" shape #40 is about. Measured, then fixed here.
 */
async function runWithDedupDeleteFailing(code: string): Promise<unknown> {
  const realConnect = pool.connect.bind(pool);
  (pool as unknown as { connect: unknown }).connect = async () => {
    const client = await realConnect();
    const realQuery = client.query.bind(client);
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const text = String(typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text);
      if (text.includes(DEDUP_DELETE)) {
        // Shaped like a pg error: what the handler branches on is `.code`.
        return Promise.reject(Object.assign(new Error(`injected ${code}`), { code }));
      }
      return (realQuery as (...a: unknown[]) => unknown)(...args);
    };
    return client;
  };
  try {
    return await runMigrations();
  } finally {
    (pool as unknown as { connect: unknown }).connect = realConnect;
  }
}

/**
 * Reads the schema on a connection of its own, never the app pool.
 *
 * The pool is the thing under test here - it is the one being patched, and its
 * clients are the ones the migration checked out. Verifying through it would
 * mean the assertion and the defect share machinery, which is how a control
 * stops being able to see anything.
 */
async function dedupIndexExists(): Promise<boolean> {
  const verifier = new pg.Client({ connectionString: postgres.connectionString });
  await verifier.connect();
  try {
    const { rows } = await verifier.query(
      "SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'uq_session_event_dedup'"
    );
    return rows[0].n > 0;
  } finally {
    await verifier.end().catch(() => {});
  }
}

describe.skipIf(skipDbTests)("migrations refuse to report success after a cancelled statement", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("migrate-cancellation");

    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-migrate-cancellation-constant-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { pool: appPool } = await import("../../config");
    pool = appPool;
    runMigrations = (await import("../migrate")).runMigrations;
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await postgres?.stop();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    // Every arm starts from an empty schema so "the index exists" can only be
    // this run's doing. `runWithDedupDeleteFailing` restores `pool.connect`
    // itself, so this reaches an unpatched pool.
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  });

  it("CONTROL: a clean run succeeds and really creates the dedup index", async () => {
    // The arm that stops the two below passing for the wrong reason. If the
    // migration were broken outright, or never created this index at all,
    // "the index is missing after a cancellation" would be true and meaningless.
    await expect(runMigrations()).resolves.toBeUndefined();
    expect(await dedupIndexExists()).toBe(true);
  }, 120_000);

  it("throws when the dedup statement is cancelled, instead of logging and continuing", async () => {
    // THE GUARANTEE. Before this fix the call RESOLVED - measured: it printed
    // "Session event dedup index may already exist: ..." then
    // "Database migrations completed successfully", and pg_indexes held 0 rows
    // for uq_session_event_dedup. A deploy that reported success with the
    // constraint absent.
    await expect(runWithDedupDeleteFailing("57014")).rejects.toMatchObject({ code: "57014" });

    // And it is genuinely absent, so the rejection is not merely cosmetic.
    expect(await dedupIndexExists()).toBe(false);
  }, 60_000);

  it("CONTROL: still tolerates a duplicate-object error, so this is a narrowing", async () => {
    // 42710 is duplicate_object - the "already applied" outcome these blocks
    // were written for. A blanket `throw error` would fail this test by name,
    // which is exactly what should happen: it would turn every re-run of the
    // migration against an existing database into a failed deploy.
    await expect(runWithDedupDeleteFailing("42710")).resolves.toBeUndefined();
  }, 60_000);
});
