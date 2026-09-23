import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";

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
  }
);
