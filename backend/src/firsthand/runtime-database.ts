
import { Pool, type PoolClient } from "pg";

import { attachPoolErrorLogging } from "../utils/poolErrorLogging";
import { applyDbTls } from "../config/dbTls";

const FIRSTHAND_RUNTIME_SCHEMA = "firsthand";
const REQUIRED_RUNTIME_RELATIONS = [
  "schema_migrations",
  "runtime_sessions",
  "runtime_events",
  "participant_responses",
  "recording_assets",
  "pending_recording_uploads",
  "studies",
  "study_steps",
  "callback_outbox"
] as const;

type RuntimeDatabaseGlobal = typeof globalThis & {
  __firsthandRuntimePool?: Pool;
  __firsthandRuntimeVerification?: Promise<void>;
};

const globalRuntimeDatabase = globalThis as RuntimeDatabaseGlobal;

export function getRuntimeDatabaseUrl() {
  // The firsthand runtime lives in THIS deployment's own RDS (Phase C
  // cutover, 2026-07-22). The FirstHand source RDS was decommissioned in
  // 2026-08, closing the git-revert rollback path - the migrated copy here
  // is the only copy.
  //
  // DB_URL is what Kubera's RDS machinery injects: the terraform-aws-rds
  // module writes {DB_USER,DB_PASSWORD,DB_HOST,DB_PORT,DB_NAME,DB_URL} to
  // Secrets Manager at {team}/{app}/{env}/db and the chart's ExternalSecret
  // merges those keys into the pod env. It must feed the same resolver that
  // decides persistence mode: a DB_URL-only environment that flipped mode to
  // filesystem while migrations ran fine against postgres is a proven outage
  // pattern (Cortex ran mock data for a week that way).
  return (
    process.env.DATABASE_URL?.trim() ||
    process.env.POSTGRES_URL?.trim() ||
    process.env.DB_URL?.trim() ||
    null
  );
}

export function isPostgresRuntimeConfigured() {
  return Boolean(getRuntimeDatabaseUrl());
}

export function getRuntimePoolConfig(databaseUrl: string) {
  // RDS postgres 15+ parameter-group families default rds.force_ssl to on, and
  // the RDS CA is genuinely not in Node's default trust store - the roots are
  // private and self-signed - so this needs a CA supplied, not just a flag.
  // dbTls.ts holds that decision and the reason verification is opt-in.
  //
  // The old version deferred to an explicit ?sslmode= in the URL by declining
  // to set ssl at all. That override is closed ONLY WHEN DB_TLS_VERIFY IS SET,
  // which is when the TLS parameters are stripped from the string. On the
  // default path pg still applies the string over the ssl option, exactly as
  // before - the log line names any parameter that is doing so.
  const tls = applyDbTls(databaseUrl, process.env, "firsthand-runtime");
  return {
    connectionString: tls.connectionString,
    max: 5,
    // pg waits forever by default; in the migrate initContainer an
    // unreachable database would hang silently until Kubernetes kills it.
    connectionTimeoutMillis: 10_000,
    ssl: tls.ssl
  };
}

export function getRuntimeDatabasePool() {
  const databaseUrl = getRuntimeDatabaseUrl();

  if (!databaseUrl) {
    throw new Error(
      "PostgreSQL runtime persistence requires DATABASE_URL, POSTGRES_URL or DB_URL."
    );
  }

  if (!globalRuntimeDatabase.__firsthandRuntimePool) {
    // Load-bearing: without an `error` listener, an error on an idle pooled
    // connection is an unhandled EventEmitter error and terminates the
    // process. An RDS failover drops every idle connection at once, so this
    // is a routine event on a Multi-AZ instance, not only an incident one.
    // See ../utils/poolErrorLogging.ts.
    globalRuntimeDatabase.__firsthandRuntimePool = attachPoolErrorLogging(
      new Pool(getRuntimePoolConfig(databaseUrl)),
      "firsthand-runtime"
    );
  }

  return globalRuntimeDatabase.__firsthandRuntimePool;
}

export async function ensureRuntimeDatabase() {
  if (!globalRuntimeDatabase.__firsthandRuntimeVerification) {
    globalRuntimeDatabase.__firsthandRuntimeVerification = verifyRuntimeDatabase().catch(
      (error) => {
        delete globalRuntimeDatabase.__firsthandRuntimeVerification;
        throw error;
      }
    );
  }

  return globalRuntimeDatabase.__firsthandRuntimeVerification;
}

export async function withRuntimeDatabaseClient<T>(
  operation: (client: PoolClient) => Promise<T>
) {
  await ensureRuntimeDatabase();
  const client = await getRuntimeDatabasePool().connect();

  try {
    await setRuntimeSearchPath(client);
    return await operation(client);
  } finally {
    client.release();
  }
}

async function verifyRuntimeDatabase() {
  const pool = getRuntimeDatabasePool();
  const client = await pool.connect();

  try {
    await setRuntimeSearchPath(client);
    const relationPaths = REQUIRED_RUNTIME_RELATIONS.map(
      (relationName) => `${FIRSTHAND_RUNTIME_SCHEMA}.${relationName}`
    );
    const result = await client.query<{
      relation_path: string;
      regclass: string | null;
    }>(
      `
        SELECT relation_path, to_regclass(relation_path) AS regclass
        FROM unnest($1::text[]) AS relation_path
      `,
      [relationPaths]
    );
    const missingRelations = result.rows
      .filter((row) => row.regclass === null)
      .map((row) => row.relation_path);

    if (missingRelations.length > 0) {
      throw new Error(
        `FirstHand PostgreSQL schema is missing required relations: ${missingRelations.join(
          ", "
        )}. Run \`npm run db:migrate\` against the shared database before starting the app.`
      );
    }
  } finally {
    client.release();
  }
}

async function setRuntimeSearchPath(client: PoolClient) {
  // firsthand ONLY - no public. Since the Phase C cutover this pool runs on
  // Cortex's own RDS, where public holds the live application schema. With
  // public in the path, a future unqualified runtime query for a table
  // missing from the firsthand schema would silently resolve against live
  // Cortex tenant data instead of erroring. Nothing in the runtime needs
  // public: all 9 relations are verified in firsthand at startup and
  // gen_random_uuid() lives in pg_catalog.
  await client.query(`SET search_path TO ${FIRSTHAND_RUNTIME_SCHEMA}`);
}
