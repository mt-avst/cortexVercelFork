import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";

const execFileAsync = promisify(execFile);
const migrateScript = path.resolve(__dirname, "../../../scripts/firsthand-migrate.mjs");

/** Rejects after `ms` so a real collision fails this test BY NAME (a timeout
 * assertion) instead of hanging the suite forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms - likely blocked on a colliding lock`)), ms)
    ),
  ]);
}

/**
 * THE STRUCTURAL NON-COLLISION cto/AdaptaLabs#159's WHOLE DESIGN RESTS ON,
 * PROVEN AGAINST REAL POSTGRES RATHER THAN ASSUMED.
 *
 * `runSerializedForMintPair` (runtime-database.ts) takes
 * `pg_advisory_xact_lock` in its TWO-INT form. `sessions.ts` already takes an
 * UNRELATED opportunity-only lock in the SINGLE-BIGINT form
 * (`pg_advisory_xact_lock(hashtextextended($1::text, 0))`, cto/AdaptaLabs#128).
 * Both pools resolve the same database, and advisory locks are
 * database-scoped, not table- or schema-scoped - so if the two forms shared
 * one keyspace, a mint for opportunity X could block on, or be blocked by, an
 * unrelated booking-side lock for the same X, for no reason either lock's own
 * docs would explain.
 *
 * Postgres tags the two forms as structurally distinct lock instances
 * (different `objsubid`: 1 for the single-bigint form, 2 for the two-int
 * form), which is what makes them GUARANTEED never to collide regardless of
 * hash input - not merely unlikely to, on the strength of the hash
 * arithmetic. This test takes both forms, over the SAME literal key, in ONE
 * transaction, and reads `pg_locks` back to prove Postgres really does grant
 * both rather than treating the second as a no-op re-acquisition of the
 * first.
 *
 * A LITERAL key (`424242`), not `hashtext(...)` over a real opportunity id,
 * deliberately: this test is about the two LOCK FORMS never colliding
 * structurally, not about a particular hash outcome. Using the runtime
 * lock's own key derivation here would only prove today's inputs don't
 * happen to collide, which is a weaker and more accident-prone claim than
 * the one actually being relied on.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;

describe.skipIf(skipDbTests)(
  "the mint-pair lock (#159) and the booking-side opportunity lock (#128) never collide",
  () => {
    beforeAll(async () => {
      postgres = await startTestPostgres("mint-pair-lock-non-collision");
      const pgModule = await import("pg");
      pool = new pgModule.default.Pool({ connectionString: postgres.connectionString });

      // Only the third test below needs the firsthand schema (it calls the
      // real runSerializedForMintPair, which verifies the schema on
      // checkout) - the first two work against pg_locks alone.
      await execFileAsync("node", [migrateScript], {
        env: { ...process.env, DATABASE_URL: postgres.connectionString },
        timeout: 60_000,
      });
    }, 120_000);

    afterAll(async () => {
      await pool?.end().catch(() => {});
      await postgres?.stop();
    });

    it("grants the single-bigint form (#128) and the two-int form (#159) simultaneously, tagged with different objsubid", async () => {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // sessions.ts's own form (#128): one 64-bit key.
        await client.query("SELECT pg_advisory_xact_lock(424242::bigint)");
        // runtime-database.ts's own form (#159): two 32-bit keys.
        await client.query("SELECT pg_advisory_xact_lock(0, 424242)");

        const locks = await client.query<{
          locktype: string;
          objsubid: number;
          granted: boolean;
        }>(
          `
            SELECT locktype, objsubid, granted
            FROM pg_locks
            WHERE locktype = 'advisory' AND pid = pg_backend_pid()
            ORDER BY objsubid
          `
        );

        // Two DISTINCT lock instances, not one lock re-granted twice - the
        // whole point of picking a form that cannot collide rather than
        // trying to prove two differently-keyed uses of the SAME form never
        // will.
        expect(locks.rows).toHaveLength(2);
        expect(locks.rows.every((row) => row.locktype === "advisory")).toBe(true);
        expect(locks.rows.every((row) => row.granted === true)).toBe(true);
        expect(locks.rows.map((row) => row.objsubid)).toEqual([1, 2]);

        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    /**
     * The control: if BOTH forms were somehow issued as the single-bigint
     * form (the mutation this test is a regression guard against), Postgres
     * would grant the SAME lock instance twice and `pg_locks` would show one
     * row, not two - so a version of this test that could not tell "1 row"
     * from "2 rows" apart would be worthless. Proven directly: re-acquiring
     * the identical single-bigint lock a second time in the same transaction
     * is a no-op grant against the SAME held lock, still exactly one row.
     */
    it("control: re-acquiring the SAME single-bigint lock twice still reads back as ONE row", async () => {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(424242::bigint)");
        await client.query("SELECT pg_advisory_xact_lock(424242::bigint)");

        const locks = await client.query<{ objsubid: number }>(
          `
            SELECT objsubid
            FROM pg_locks
            WHERE locktype = 'advisory' AND pid = pg_backend_pid()
          `
        );

        expect(locks.rows).toHaveLength(1);
        expect(locks.rows[0].objsubid).toBe(1);

        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    /**
     * THE PRODUCTION CODE, not just the two SQL forms in isolation: calls the
     * REAL `runSerializedForMintPair` (cto/AdaptaLabs#159) while a SEPARATE
     * connection holds `sessions.ts`'s REAL #128 lock
     * (`pg_advisory_xact_lock(hashtextextended($1::text, 0))`) for the SAME
     * opportunity id. If the two forms shared a keyspace, `runSerializedForMintPair`
     * would block waiting for #128's lock to release - which it never does
     * here, deliberately, until after the assertion - so a bounded timeout on
     * the mint call is what turns a collision into a named test failure
     * instead of a hang. `DATABASE_URL` is pointed at this suite's own
     * ephemeral Postgres before the dynamic import, matching how
     * `mint-serializes-concurrent-bursts-postgres.test.ts` wires up the same
     * runtime pool against a test instance.
     */
    it("runSerializedForMintPair does not block on sessions.ts's own #128 lock for the same opportunity id", async () => {
      const opportunityId = "opp-non-collision-159";
      const previousDatabaseUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = postgres.connectionString;

      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        // sessions.ts's REAL #128 lock, same form, same key, held open.
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
          opportunityId,
        ]);

        const { runSerializedForMintPair } = await import("../runtime-database");

        const result = await withTimeout(
          runSerializedForMintPair(opportunityId, "participant-non-collision-159", async () => "ran"),
          5_000,
          "runSerializedForMintPair"
        );

        expect(result).toBe("ran");
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
        if (previousDatabaseUrl === undefined) {
          delete process.env.DATABASE_URL;
        } else {
          process.env.DATABASE_URL = previousDatabaseUrl;
        }
      }
    }, 15_000);
  }
);
