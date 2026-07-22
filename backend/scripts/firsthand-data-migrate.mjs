// Phase C data migration: copy the `firsthand` schema from FirstHand's live
// RDS (source) into this deployment's own RDS (target).
//
// SAFETY MODEL - read before touching:
// - DRY RUN is the default. Without FIRSTHAND_DATA_MIGRATE_EXECUTE="1" this
//   script only ever runs read-only queries against the migration data on
//   both sides. The single write a dry run performs is its own report row
//   into the TARGET's public.firsthand_migration_reports (see reportLines
//   below) - never the source, never any firsthand schema.
// - The source is NEVER written to, in any mode. The only source access is
//   read-only queries and pg_dump (a reader by construction).
// - The execute path DROPs the target's `firsthand` schema first (it holds
//   only what C1's checksummed runner created, or a previous copy) and
//   restores the dump in a single transaction with ON_ERROR_STOP, so a
//   failure leaves no partial state - the next deploy's runner recreates the
//   empty schema and the job can simply re-run.
// - Target identity is verified by DATABASE CONTENT, not just host: the
//   target must contain Cortex's own public.opportunities relation and must
//   NOT be the source host (belt and braces against a DNS-alias route - the
//   C1 security-audit residual).
// - Connection URLs and credentials are never printed, and never appear in
//   any process argv: pg_dump and psql receive their connection details
//   exclusively via libpq env vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/...)
//   in their own child environments. psql runs VERBOSITY=terse so an error
//   can never echo row content (participant PII) into the pod log.
// - Failures log one prefixed FAILED line and exit non-zero via
//   process.exitCode (never process.exit mid-stream), so the line always
//   flushes and the pg clients always close.
//
// Runs as a chart Job (ArgoCD PostSync hook) in the backend image, which
// carries postgresql17-client (see backend/Dockerfile, Phase-C temporary).
// The PostSync hook re-runs on every sync, so dry-run mode is what stays
// enabled between deliberate runs; the job block is removed once C3 is done.

import { spawn } from "node:child_process";

import pg from "pg";

const { Client } = pg;

const FIRSTHAND_TABLES = [
  "schema_migrations",
  "studies",
  "study_steps",
  "runtime_sessions",
  "runtime_events",
  "participant_responses",
  "recording_assets",
  "pending_recording_uploads",
  "callback_outbox"
];

// Same precedence as backend/src/config/databaseUrl.ts and
// scripts/firsthand-migrate.mjs - the target is always THIS deployment's RDS.
// Deliberately a strict subset of resolveDatabaseUrl: the host-part fallback
// (DB_HOST/POSTGRES_HOST/PGHOST) is not mirrored here, matching the sibling
// runner - Kubera injects a full DB_URL.
const CONNECTION_SOURCES = [
  ["DATABASE_URL", "DATABASE_URL"],
  ["POSTGRES_URL", "POSTGRES_URL"],
  ["POSTGRESQL_URL", "POSTGRESQL_URL"],
  ["DB_URL", "DB_URL (Kubera injected)"]
];

class MigrationFailure extends Error {}

// Every log line is also buffered into a report that gets written to the
// TARGET database's public.firsthand_migration_reports at the end of the run
// (best-effort, superadmin-gated route serves it - pod logs are not reachable
// without cluster access). This is the one deliberate exception to "no writes
// in dry-run": a single report row in Cortex's own public schema, never the
// source, never any firsthand schema.
const reportLines = [];
const log = (message) => {
  console.log(`[firsthand-data-migrate] ${message}`);
  reportLines.push(message);
};
const fail = (message) => {
  throw new MigrationFailure(message);
};

function hostIdentity(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || "5432"}`;
  } catch {
    return null;
  }
}

function databaseName(url) {
  try {
    return new URL(url).pathname.replace(/^\//, "") || null;
  } catch {
    return null;
  }
}

function requiresRdsSsl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("sslmode")) {
      return false;
    }
    return parsed.hostname.endsWith(".rds.amazonaws.com");
  } catch {
    return false;
  }
}

function makeClient(url) {
  return new Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    ...(requiresRdsSsl(url) ? { ssl: { rejectUnauthorized: false } } : {})
  });
}

async function sideReport(client, sideName) {
  const version = (await client.query("SELECT version()")).rows[0].version;
  const database = (await client.query("SELECT current_database() AS db")).rows[0].db;
  log(`${sideName}: database "${database}" - ${version.split(",")[0]}`);

  const report = { database, tables: new Map() };
  for (const table of FIRSTHAND_TABLES) {
    const regclass = (
      await client.query("SELECT to_regclass($1) AS r", [`firsthand.${table}`])
    ).rows[0].r;
    if (!regclass) {
      log(`${sideName}: firsthand.${table} ABSENT`);
      report.tables.set(table, null);
      continue;
    }
    const count = Number(
      (await client.query(`SELECT count(*) AS c FROM firsthand.${table}`)).rows[0].c
    );
    log(`${sideName}: firsthand.${table} rows=${count}`);
    report.tables.set(table, count);
  }
  return report;
}

async function ledgerRows(client) {
  const result = await client.query(
    "SELECT name, checksum FROM firsthand.schema_migrations ORDER BY name ASC"
  );
  return result.rows;
}

async function sessionSpotChecks(client) {
  const result = await client.query(`
    SELECT session_id,
           md5(coalesce(session_payload::text, '')) AS payload_md5,
           md5(steps::text) AS steps_md5
    FROM firsthand.runtime_sessions
    ORDER BY updated_at DESC, session_id DESC
    LIMIT 3
  `);
  return result.rows;
}

// libpq env for a child process, from a connection URL. Credentials travel
// ONLY in the child's environment - never in argv (invisible to ps) and
// never in our logs. sslmode in the URL is honoured via PGSSLMODE.
function libpqEnv(url) {
  const parsed = new URL(url);
  const env = {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "postgres",
    PGCONNECT_TIMEOUT: "10"
  };
  if (parsed.username) {
    env.PGUSER = decodeURIComponent(parsed.username);
  }
  if (parsed.password) {
    env.PGPASSWORD = decodeURIComponent(parsed.password);
  }
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode) {
    env.PGSSLMODE = sslmode;
  }
  return env;
}

// pg_dump (source) piped in-process into psql (target). No shell involved:
// both exit codes are checked explicitly, and each child gets only its own
// side's credentials. psql runs VERBOSITY=terse so a failure (for example a
// COPY error) reports severity and message only - never DETAIL/CONTEXT row
// content, which for runtime_sessions would be participant PII.
function runDumpRestore(srcUrl, tgtUrl) {
  return new Promise((resolve, reject) => {
    const dump = spawn(
      "pg_dump",
      ["--schema=firsthand", "--no-owner", "--no-privileges"],
      { env: { ...libpqEnv(srcUrl), PATH: process.env.PATH }, stdio: ["ignore", "pipe", "inherit"] }
    );
    const restore = spawn(
      "psql",
      ["--single-transaction", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=terse", "-q"],
      { env: { ...libpqEnv(tgtUrl), PATH: process.env.PATH }, stdio: ["pipe", "inherit", "inherit"] }
    );

    dump.stdout.pipe(restore.stdin);

    let dumpExit = null;
    let restoreExit = null;
    const settle = () => {
      if (dumpExit === null || restoreExit === null) {
        return;
      }
      if (dumpExit === 0 && restoreExit === 0) {
        resolve();
      } else {
        reject(new Error(`dump/restore failed (pg_dump exited ${dumpExit}, psql exited ${restoreExit})`));
      }
    };
    dump.on("error", reject);
    restore.on("error", reject);
    dump.on("exit", (code) => {
      dumpExit = code ?? -1;
      if (dumpExit !== 0) {
        // A dead dump can reach psql as a clean EOF, which --single-transaction
        // may COMMIT - the real safety is that we fail the run on dumpExit
        // regardless, and the next execute run DROPs and re-copies. Destroying
        // stdin here just hurries psql along.
        restore.stdin.destroy();
      }
      settle();
    });
    restore.on("exit", (code) => {
      restoreExit = code ?? -1;
      settle();
    });
  });
}

let source = null;
let target = null;
const executeMode = process.env.FIRSTHAND_DATA_MIGRATE_EXECUTE?.trim() === "1";

try {

  const sourceUrl = process.env.FIRSTHAND_DATABASE_URL?.trim() || null;
  if (!sourceUrl) {
    fail(
      "FIRSTHAND_DATABASE_URL is not set - there is no migration source. " +
        "(After cutover this script has no purpose; remove the job block.)"
    );
  }

  const resolvedTarget = CONNECTION_SOURCES.map(([envName, label]) => ({
    label,
    url: process.env[envName]?.trim() || null
  })).find((candidate) => candidate.url);
  if (!resolvedTarget) {
    fail("No target database URL set (DATABASE_URL/POSTGRES_URL/POSTGRESQL_URL/DB_URL).");
  }

  const sourceHost = hostIdentity(sourceUrl);
  const targetHost = hostIdentity(resolvedTarget.url);
  if (!sourceHost || !targetHost) {
    fail("Could not parse one of the connection URLs (host check impossible).");
  }
  if (sourceHost === targetHost) {
    fail(
      `source (FIRSTHAND_DATABASE_URL) and target (${resolvedTarget.label}) resolve to the same host - refusing.`
    );
  }

  log(`mode: ${executeMode ? "EXECUTE" : "DRY RUN (read-only; set FIRSTHAND_DATA_MIGRATE_EXECUTE=1 to copy)"}`);
  log(`target resolved from: ${resolvedTarget.label}`);

  source = makeClient(sourceUrl);
  target = makeClient(resolvedTarget.url);
  await source.connect();
  await target.connect();

  // Identity guards (content-based, per the C1 security-audit residual).
  const targetIsCortex = (
    await target.query("SELECT to_regclass('public.opportunities') AS r")
  ).rows[0].r;
  if (!targetIsCortex) {
    fail(
      "target does not contain public.opportunities - it does not look like the Cortex application database. Refusing."
    );
  }
  const sourceHasLedger = (
    await source.query("SELECT to_regclass('firsthand.schema_migrations') AS r")
  ).rows[0].r;
  if (!sourceHasLedger) {
    fail("source has no firsthand.schema_migrations - it does not look like the FirstHand database. Refusing.");
  }
  const sourceDb = databaseName(sourceUrl);
  const targetDb = databaseName(resolvedTarget.url);
  log(`identity: source db "${sourceDb}" (FirstHand ledger present), target db "${targetDb}" (Cortex relations present), hosts distinct`);

  log("--- source state ---");
  const sourceReport = await sideReport(source, "source");
  const sourceLedger = await ledgerRows(source);
  for (const row of sourceLedger) {
    log(`source ledger: ${row.name} ${row.checksum}`);
  }
  const sourceSpots = await sessionSpotChecks(source);

  log("--- target state ---");
  await sideReport(target, "target");

  if (!executeMode) {
    log("plan: DROP SCHEMA firsthand CASCADE on target; pg_dump --schema=firsthand (source) piped into psql --single-transaction (target); verify ledger row-for-row, per-table counts and session content md5s.");
    log("DRY RUN COMPLETE - no writes performed on either side.");
  } else {
    // EXECUTE. From here the TARGET is mutated. The source still is not.
    log("execute: dropping target firsthand schema (it holds only the empty C1 scaffold or a prior copy)...");
    await target.query("DROP SCHEMA IF EXISTS firsthand CASCADE");

    log("execute: streaming pg_dump into psql (single transaction, ON_ERROR_STOP, terse errors)...");
    await runDumpRestore(sourceUrl, resolvedTarget.url);

    log("--- post-restore verify ---");
    const targetReport = await sideReport(target, "target");

    const targetLedger = await ledgerRows(target);
    const ledgerMatches =
      targetLedger.length === sourceLedger.length &&
      sourceLedger.every(
        (row, index) =>
          targetLedger[index].name === row.name && targetLedger[index].checksum === row.checksum
      );
    if (!ledgerMatches) {
      fail("schema_migrations ledger mismatch between source and restored target.");
    }
    log(`verify: ledger matches row-for-row (${targetLedger.length} rows, name + checksum)`);

    for (const table of FIRSTHAND_TABLES) {
      const sourceCount = sourceReport.tables.get(table);
      const targetCount = targetReport.tables.get(table);
      if (sourceCount === null || targetCount === null || sourceCount !== targetCount) {
        fail(`row count mismatch on firsthand.${table}: source=${sourceCount} target=${targetCount}`);
      }
    }
    log("verify: per-table row counts match on all tables");

    const targetSpots = await sessionSpotChecks(target);
    for (const sourceRow of sourceSpots) {
      const targetRow = targetSpots.find((row) => row.session_id === sourceRow.session_id);
      if (
        !targetRow ||
        targetRow.payload_md5 !== sourceRow.payload_md5 ||
        targetRow.steps_md5 !== sourceRow.steps_md5
      ) {
        fail(`JSONB spot-check mismatch on runtime_sessions ${sourceRow.session_id}`);
      }
    }
    log(`verify: JSONB spot-checks match on ${sourceSpots.length} most-recent sessions`);

    log("EXECUTE COMPLETE - migration copied and verified. Source untouched.");
    log("note: counts were sampled before the copy; if the source took writes mid-run, re-run under the agreed freeze and compare again.");
  }
} catch (error) {
  const message = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
  console.error(`[firsthand-data-migrate] ${message}`);
  reportLines.push(message);
  process.exitCode = 1;
} finally {
  // Best-effort report write to the target's public schema so the run is
  // reviewable without pod-log access. Skipped when the target never
  // connected (guard failures) - an absent report plus a degraded sync is
  // itself the signal that the job failed before reaching the databases;
  // those refusal reasons are pod-log-only by design (guards run before any
  // connection). One row per sync while the job block exists; the table,
  // route and job are removed together at Phase-C teardown.
  if (target) {
    try {
      await target.query(
        "INSERT INTO public.firsthand_migration_reports (mode, success, report) VALUES ($1, $2, $3)",
        [executeMode ? "execute" : "dry-run", process.exitCode !== 1, reportLines.join("\n")]
      );
      console.log("[firsthand-data-migrate] report written to firsthand_migration_reports");
    } catch (reportError) {
      console.error(
        `[firsthand-data-migrate] report write failed: ${reportError instanceof Error ? reportError.message : String(reportError)}`
      );
    }
  }
  if (source) {
    await source.end().catch(() => {});
  }
  if (target) {
    await target.end().catch(() => {});
  }
}
