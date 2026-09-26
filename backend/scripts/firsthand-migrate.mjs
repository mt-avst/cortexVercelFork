import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { applyDbTls } from "./db-tls.mjs";

const { Pool } = pg;

const FIRSTHAND_SCHEMA = "firsthand";
const MIGRATIONS_TABLE = `${FIRSTHAND_SCHEMA}.schema_migrations`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDirectory = path.resolve(__dirname, "../db/firsthand-migrations");

// Deploy-time migrations ALWAYS target this deployment's own RDS - the same
// database the initContainer's `npm run migrate && npm run seed` just wrote
// to. The precedence below mirrors backend/src/config/databaseUrl.ts
// (DATABASE_URL || POSTGRES_URL || POSTGRESQL_URL || DB_URL, where DB_URL is
// what Kubera's RDS machinery injects via the ExternalSecret) so this runner
// can never resolve to a different database than migrate+seed did.
//
// This runner's job is to create and maintain the `firsthand` schema in
// Cortex's own RDS. (The FIRSTHAND_DATABASE_URL bridge to FirstHand's source
// RDS, and the anti-source guard that protected that source from stray DDL,
// were removed 2026-08-11 when the source RDS was decommissioned - FirstHand
// repo MR !2. Note the runtime pool deliberately reads a narrower var set
// than this runner: no POSTGRESQL_URL - see runtime-database.ts.)
// On Vercel only the two variables the Neon integration injects count, the
// same rule as backend/src/config/databaseUrl.ts (NEON_URL_KEYS), so migrations
// can never land on a different database than the app reads.
const CONNECTION_SOURCES = process.env.VERCEL
  ? [
      ["DATABASE_URL", "DATABASE_URL (Neon)"],
      ["POSTGRES_URL", "POSTGRES_URL (Neon)"]
    ]
  : [
      ["DATABASE_URL", "DATABASE_URL"],
      ["POSTGRES_URL", "POSTGRES_URL"],
      ["POSTGRESQL_URL", "POSTGRESQL_URL"],
      ["DB_URL", "DB_URL (Kubera injected)"]
    ];

const resolvedConnection = CONNECTION_SOURCES.map(([envName, label]) => ({
  label,
  url: process.env[envName]?.trim() || null
})).find((candidate) => candidate.url);

if (!resolvedConnection) {
  console.error(
    `[firsthand-migrate] FirstHand migrations require one of ${CONNECTION_SOURCES.map(([name]) => name).join(", ")} to be set.`
  );
  process.exit(1);
}

const databaseUrl = resolvedConnection.url;

// The init container log is the only debugging surface in the cluster - name
// the source var (never the value) so a wrong-env failure is diagnosable
// from the log alone.
console.info(`[firsthand-migrate] connection source: ${resolvedConnection.label}`);

// RDS postgres 15+ defaults rds.force_ssl on, and the RDS CA genuinely is not
// in Node's default trust store - those roots are private and self-signed - so
// this needs a CA supplied rather than a flag flipped. See db-tls.mjs, and
// dbTls.ts for why verification is opt-in via DB_TLS_VERIFY.
//
// This is the deploy initContainer, which is exactly why it is not on by
// default: a certificate that does not verify here CrashLoops the pod rather
// than degrading quietly.
const tls = applyDbTls(databaseUrl, process.env, "firsthand-migrate");

const pool = new Pool({
  connectionString: tls.connectionString,
  max: 1,
  // Fail loudly instead of hanging until Kubernetes kills the init container.
  connectionTimeoutMillis: 10_000,
  ssl: tls.ssl
});

try {
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((entry) => entry.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  const client = await pool.connect();

  // A migration that says something has to be able to be heard.
  //
  // node-postgres surfaces a Postgres NOTICE as a `notice` event and DROPS it
  // when nothing is listening, so a `RAISE NOTICE` in a migration file reached
  // nobody. 0015 deletes rows and raises the count as its only audit record;
  // without this line that record did not exist, and the initContainer log -
  // the sole debugging surface in the cluster - would have shown the migration
  // applying and nothing about what it removed.
  client.on("notice", (notice) => {
    console.info(`[firsthand-migrate] ${notice.message}`);
  });

  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${FIRSTHAND_SCHEMA}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const appliedMigrationsResult = await client.query(
      `
        SELECT name, checksum
        FROM ${MIGRATIONS_TABLE}
        ORDER BY name ASC
      `
    );
    const appliedMigrations = new Map(
      appliedMigrationsResult.rows.map((row) => [row.name, row.checksum])
    );

    let appliedCount = 0;

    for (const migrationFile of migrationFiles) {
      const migrationPath = path.join(migrationsDirectory, migrationFile);
      const migrationSql = await readFile(migrationPath, "utf8");
      const checksum = createHash("sha256").update(migrationSql).digest("hex");
      const recordedChecksum = appliedMigrations.get(migrationFile);

      if (recordedChecksum && recordedChecksum !== checksum) {
        throw new Error(
          `Migration ${migrationFile} was already applied with a different checksum.`
        );
      }

      if (recordedChecksum) {
        continue;
      }

      console.log(`[firsthand-migrate] Applying ${migrationFile}...`);
      await client.query("BEGIN");

      try {
        await client.query(migrationSql);
        await client.query(
          `
            INSERT INTO ${MIGRATIONS_TABLE} (name, checksum)
            VALUES ($1, $2)
          `,
          [migrationFile, checksum]
        );
        await client.query("COMMIT");
        appliedCount += 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    if (appliedCount === 0) {
      console.log("[firsthand-migrate] FirstHand migrations are already up to date.");
    } else {
      console.log(`[firsthand-migrate] Applied ${appliedCount} FirstHand migration(s).`);
    }
  } finally {
    client.release();
  }
} catch (error) {
  // The init container log is the only deploy-time diagnostic - make the
  // failure findable by prefix. pg error messages may name host:port (never
  // credentials); that is deliberate, it is the debugging surface.
  console.error(
    `[firsthand-migrate] FAILED: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
