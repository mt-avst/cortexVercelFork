
import { Pool, type PoolClient } from "pg";

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
  // Phase C cutover (2026-07-22, executed): the firsthand runtime now lives in
  // THIS deployment's own RDS. FIRSTHAND_DATABASE_URL - the Phase B bridge
  // that pointed this pool at FirstHand's live RDS while the data still lived
  // there - is deliberately NOT read any more; the migrated copy in Cortex's
  // RDS is authoritative. The env var may still be present in the pod
  // (secret-store removal is post-retention hygiene): it must stay unread.
  // ROLLBACK for the retention window = git-revert this commit, which points
  // the pool back at the untouched FirstHand source RDS.
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

function requiresRdsSsl(databaseUrl: string) {
  try {
    const url = new URL(databaseUrl);
    if (url.searchParams.has("sslmode")) {
      return false;
    }
    return url.hostname.endsWith(".rds.amazonaws.com");
  } catch {
    return false;
  }
}

export function getRuntimePoolConfig(databaseUrl: string) {
  return {
    connectionString: databaseUrl,
    max: 5,
    // pg waits forever by default; in the migrate initContainer an
    // unreachable database would hang silently until Kubernetes kills it.
    connectionTimeoutMillis: 10_000,
    // RDS postgres 15+ parameter-group families default rds.force_ssl to on,
    // and the RDS CA is not in Node's trust store, so a bare DB_URL needs
    // encrypt-without-verify. An explicit ?sslmode= in the URL wins.
    ...(requiresRdsSsl(databaseUrl) ? { ssl: { rejectUnauthorized: false } } : {})
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
    globalRuntimeDatabase.__firsthandRuntimePool = new Pool(
      getRuntimePoolConfig(databaseUrl)
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
