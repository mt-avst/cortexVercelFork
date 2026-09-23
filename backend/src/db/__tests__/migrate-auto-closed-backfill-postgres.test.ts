import crypto from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";

/**
 * THE `auto_closed` COLUMN AND ITS ONE-TIME BACKFILL, AGAINST A REAL DATABASE.
 *
 * `migrate.ts` re-runs on every deploy. The column's add and its backfill
 * (`true` for every row already closed, because until this shipped no UI could
 * close a study by hand) sit in one guarded DO block that runs only while the
 * column is absent. The failure this file exists to catch is the obvious
 * "simplification" to `ADD COLUMN IF NOT EXISTS` plus an unconditional
 * `UPDATE ... WHERE status = 'closed'`: it passes every first-run check, then
 * re-marks every MANUAL close as automatic on the next deploy. Only a second
 * run over a row set false after the first can see that.
 *
 * Each test starts from a schema that is migrated and then has the column
 * DROPPED, which is exactly the shape of a production database the day this
 * ships: every other table present, this one column missing.
 *
 * Runs in CI's `test-backend-db` (`npx vitest run postgres`); the no-DB vitest
 * job skips it via FIRSTHAND_SKIP_DB_TESTS.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let runMigrations: () => Promise<void>;

/** A fixed, old timestamp the backfill must not overwrite. */
const PINNED_UPDATED_AT = "2026-01-02T03:04:05.000Z";

let ownerId: string;

async function seedStudy(status: "draft" | "published" | "closed"): Promise<string> {
  const id = crypto.randomUUID();
  // The trigger stamps updated_at only BEFORE UPDATE, so an insert keeps the
  // value given here.
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status, updated_at)
     VALUES ($1, 'poll', $2, 'Proving the auto_closed backfill', $3, $4, $5)`,
    [id, `A ${status} study`, ownerId, status, PINNED_UPDATED_AT]
  );
  return id;
}

const read = async (id: string): Promise<{ auto_closed: boolean; updated_at: Date }> => {
  const { rows } = await pool.query(
    "SELECT auto_closed, updated_at FROM opportunities WHERE id = $1",
    [id]
  );
  return rows[0] as { auto_closed: boolean; updated_at: Date };
};

describe.skipIf(skipDbTests)("the auto_closed column and its one-time backfill", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("migrate-auto-closed");

    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-migrate-auto-closed-constant-not-a-real-secret"; // gitleaks:allow
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
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations();
    // The pre-ship shape: everything migrated except this one column.
    await pool.query("ALTER TABLE opportunities DROP COLUMN IF EXISTS auto_closed");
    ownerId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', $2, 'researcher_admin')`,
      [ownerId, `owner-${ownerId}@example.com`]
    );
  }, 180_000);

  it("adds the column as boolean NOT NULL DEFAULT false", async () => {
    await runMigrations();

    const { rows } = await pool.query(
      `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'opportunities'
         AND column_name = 'auto_closed'`
    );
    expect(rows).toEqual([{ data_type: "boolean", is_nullable: "NO", column_default: "false" }]);
  });

  it("backfills true on closed rows only", async () => {
    const closed = await seedStudy("closed");
    const published = await seedStudy("published");
    const draft = await seedStudy("draft");

    await runMigrations();

    expect((await read(closed)).auto_closed).toBe(true);
    // THE CONTROL: the backfill is not "every row". A study that is not closed
    // was not closed automatically either.
    expect((await read(published)).auto_closed).toBe(false);
    expect((await read(draft)).auto_closed).toBe(false);
  });

  it("does not stamp updated_at on the rows it backfills", async () => {
    const closed = await seedStudy("closed");

    await runMigrations();

    const after = await read(closed);
    // THE CONTROL: the backfill really did touch this row.
    expect(after.auto_closed).toBe(true);
    expect(after.updated_at.toISOString()).toBe(PINNED_UPDATED_AT);
  });

  it("leaves the updated_at trigger enabled afterwards", async () => {
    const closed = await seedStudy("closed");
    await runMigrations();

    await pool.query("UPDATE opportunities SET title = 'Retitled' WHERE id = $1", [closed]);

    // A normal write after the migration is stamped as it always was.
    expect((await read(closed)).updated_at.toISOString()).not.toBe(PINNED_UPDATED_AT);
  });

  it("runs twice cleanly, and the second run changes nothing", async () => {
    const closed = await seedStudy("closed");
    const published = await seedStudy("published");

    await runMigrations();
    await expect(runMigrations()).resolves.toBeUndefined();

    expect((await read(closed)).auto_closed).toBe(true);
    expect((await read(published)).auto_closed).toBe(false);
  });

  /*
   * THE ARM THAT MATTERS MOST. After the column ships, a researcher closes a
   * study by hand and it is stored false. The next deploy re-runs this file.
   * An unguarded backfill re-marks that row true - silently turning a manual
   * close into an "Auto-closed" caption on every restart - and passes every
   * other arm above.
   */
  it("keeps a manual close false across a re-run", async () => {
    const autoClosed = await seedStudy("closed");
    await runMigrations();
    const manualClose = await seedStudy("closed");
    await pool.query("UPDATE opportunities SET auto_closed = false WHERE id = $1", [manualClose]);

    await runMigrations();

    expect((await read(manualClose)).auto_closed).toBe(false);
    // THE CONTROL: the first run's backfill is still in place.
    expect((await read(autoClosed)).auto_closed).toBe(true);
  });

  /*
   * ONLY THE RACE IS TOLERATED. The catch around the DO block used to share
   * the file's class-42 predicate, which also swallows a missing trigger
   * (42704) or a privilege error (42501): the deploy then logs a line, ships
   * without the column, and every status PATCH and both auto-close sweeps fail
   * on 42703 afterwards.
   *
   * The failure is injected INSIDE the block: a statement-level trigger that
   * raises the chosen SQLSTATE, but only for a statement whose text names
   * `auto_closed` - which is the DO block's backfill UPDATE and nothing else
   * this file runs. (Dropping `update_opportunities_updated_at` does not work
   * as the injection: the migration re-creates it a few statements earlier.)
   */
  const raiseInsideTheBackfill = async (sqlstate: string): Promise<void> => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_fail_auto_closed_backfill() RETURNS trigger AS $fn$
      BEGIN
        IF current_query() ILIKE '%auto_closed%' THEN
          RAISE EXCEPTION 'injected backfill failure' USING ERRCODE = '${sqlstate}';
        END IF;
        RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER test_fail_auto_closed_backfill
      BEFORE UPDATE ON opportunities
      FOR EACH STATEMENT EXECUTE FUNCTION test_fail_auto_closed_backfill()
    `);
  };

  const columnExists = async (): Promise<boolean> => {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'opportunities'
         AND column_name = 'auto_closed'`
    );
    return rowCount === 1;
  };

  it.each([
    // 42704 undefined_object (e.g. a missing trigger), 42501 insufficient_privilege
    ["42704"],
    ["42501"]
  ])("throws, rather than logging, a class-42 error %s raised inside the block", async (sqlstate) => {
    await raiseInsideTheBackfill(sqlstate);

    await expect(runMigrations()).rejects.toMatchObject({
      code: sqlstate,
      message: "injected backfill failure"
    });
    // The block rolled back as one statement: no half-added column.
    expect(await columnExists()).toBe(false);
  });

  // 42701 IS the race and is tolerated - but a tolerated error that leaves no
  // column must still fail the deploy. Here the injected 42701 rolls the block
  // back, so the post-block assertion is the only thing standing between this
  // and a deploy without the column.
  it("fails the migration by name when a tolerated 42701 leaves the column missing", async () => {
    await raiseInsideTheBackfill("42701");

    await expect(runMigrations()).rejects.toThrow("Migration left the auto_closed column missing");
    expect(await columnExists()).toBe(false);
  });

  // THE CONTROL for the three arms above: with the injection removed, the same
  // database migrates cleanly, so they are about the error and not a schema
  // the migration could never have handled.
  it("migrates cleanly once the injected failure is gone", async () => {
    await raiseInsideTheBackfill("42704");
    await pool.query("DROP TRIGGER test_fail_auto_closed_backfill ON opportunities");

    await expect(runMigrations()).resolves.toBeUndefined();
    expect(await columnExists()).toBe(true);
  });
});
