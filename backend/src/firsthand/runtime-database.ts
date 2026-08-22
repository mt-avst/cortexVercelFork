
import { Pool, type PoolClient } from "pg";

import { attachPoolErrorLogging } from "../utils/poolErrorLogging";
import { applyDbTls } from "../config/dbTls";
import {
  admitRuntimeCheckout,
  runHoldingRuntimeSlot,
  RUNTIME_POOL_MAX_CONNECTIONS,
  type WhenRuntimePoolBusy
} from "./runtime-pool-admission";

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
    // The number itself lives in runtime-pool-admission.ts, because the admin
    // concurrency cap is DERIVED from it. Written down here as well, the two
    // would drift the first time somebody widened the pool.
    max: RUNTIME_POOL_MAX_CONNECTIONS,
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

/**
 * How long any one statement may run before Postgres cancels it.
 *
 * A BOUND, not a budget. It is set well above anything this application
 * legitimately does, because the value of having one at all is entirely in
 * stopping the pathological case: today nothing stops a single query holding
 * one of five connections until the client gives up, and `LIMIT 200001` on the
 * results read bounds it in ROWS, which is not the same thing.
 *
 * Fifteen seconds rather than something tight, and that direction is
 * deliberate. Participants share this pool, and a timeout that ever fires on a
 * legitimate answer save would LOSE that participant's answers - trading the
 * failure this whole change exists to prevent for a different cause of the same
 * outcome. The pool's own `connectionTimeoutMillis` is already 10s, so a
 * participant who is going to fail has usually failed before this is reached.
 *
 * WHAT IT DOES NOT BOUND, stated plainly because the reasoning was too weak
 * once already: `statement_timeout` is PER STATEMENT. The runtime mutation path
 * opens a transaction and issues many statements inside it, so a checkout can
 * still hold a connection for a multiple of this. Postgres has no
 * per-transaction ceiling before 17 (`transaction_timeout`), and this database
 * is 16. A loose per-statement bound is strictly better than no bound; it is
 * not the same as a bound on occupancy, which is what the admission cap in
 * runtime-pool-admission.ts is for.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * The loose bound, for the two deliberately-unpaginated results reads.
 *
 * They are the one read here that is expected to be slow: they are unfiltered
 * by design, span every opportunity that used a study, and are capped only at
 * 200,000 rows. A tight bound would refuse a legitimate export, so they get one
 * that only fires on a query that has plainly stopped making progress. Costed
 * against a 10-a-minute ceiling on those routes and, since !201's cap, at most
 * ADMIN_CONCURRENCY_LIMIT of them in flight at once.
 */
export const RESULTS_STATEMENT_TIMEOUT_MS = 120_000;

export type RuntimeCheckoutOptions = {
  /**
   * Override the per-statement bound for this checkout. Only for work known to
   * be long AND known to be worth waiting for - see
   * RESULTS_STATEMENT_TIMEOUT_MS.
   */
  statementTimeoutMs?: number;
  /**
   * What to do when this is admin-originated work and the admission cap is
   * full. `"skip"` throws RuntimeDatabaseBusyError immediately instead of
   * queueing, and is ONLY for a caller that already has a way to say "not
   * established". Participant work ignores this: it is never capped.
   */
  whenBusy?: WhenRuntimePoolBusy;
};

export async function withRuntimeDatabaseClient<T>(
  operation: (client: PoolClient) => Promise<T>,
  options?: RuntimeCheckoutOptions
) {
  await ensureRuntimeDatabase();

  // Admission BEFORE the pool checkout, which is the whole point: queueing on
  // `pool.connect()` is exactly the thing participants must not be made to do
  // behind admin traffic.
  const admission = await admitRuntimeCheckout({ whenBusy: options?.whenBusy });

  let client: PoolClient;
  try {
    client = await getRuntimeDatabasePool().connect();
  } catch (error) {
    // A checkout that never happened must give the slot straight back. Without
    // this the cap narrows by one on every connection failure, and an RDS
    // failover - which drops every connection at once - would close it
    // permanently.
    admission.release();
    throw error;
  }

  try {
    await prepareRuntimeSession(client, options?.statementTimeoutMs);
    // Everything the operation awaits runs marked as already holding a slot,
    // so a nested checkout passes through instead of deadlocking on a cap of
    // ADMIN_CONCURRENCY_LIMIT. Siblings started outside this scope are
    // unaffected and still take a permit each.
    return await runHoldingRuntimeSlot(() => operation(client));
  } finally {
    // NESTED, not sequential, and that is the whole of it. pg throws on a
    // double release (pg-pool's `throwOnDoubleRelease`), and a bare
    // `client.release(); admission.release();` would let that exception escape
    // the finally with the admission permit still held - permanently, on a cap
    // of two. Two of those and every admin runtime checkout in the process
    // waits ten seconds and then 503s, forever, on a pool that has long since
    // recovered.
    //
    // The ORDER of the two is genuinely unobservable: both run in one
    // synchronous block and a waiter resumes on a microtask, so a mutation
    // swapping them survives the whole suite. It was the COUPLING that
    // mattered, and an earlier version of this comment argued only about the
    // order - which is how a real hazard got written up as a non-issue.
    try {
      client.release();
    } finally {
      admission.release();
    }
  }
}

async function verifyRuntimeDatabase() {
  const pool = getRuntimeDatabasePool();
  const client = await pool.connect();

  try {
    await prepareRuntimeSession(client);
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

/**
 * The two session settings every checkout starts from, in one round trip.
 *
 * SESSION-LEVEL `SET`, NOT `SET LOCAL`, and that is a correction rather than a
 * preference. `SET LOCAL` applies to the surrounding transaction and these
 * queries mostly run with no explicit transaction at all - outside one,
 * Postgres accepts it, emits `WARNING: SET LOCAL can only be used in
 * transaction blocks`, and applies nothing. It would have looked exactly like a
 * working timeout.
 *
 * Session-level on a POOLED connection is safe here only because it is
 * re-issued on every checkout, exactly as `search_path` already was: the value
 * a connection carries is always the one this checkout asked for, never the one
 * the last borrower left behind. Set before any `BEGIN` the operation opens, so
 * the transaction inherits it, and `SET` outside a transaction is not undone by
 * a later `ROLLBACK`.
 *
 * Both statements go in one `query` call - node-pg uses the simple query
 * protocol when no parameter array is passed, which accepts several statements
 * - so the bound costs no extra round trip. The timeout cannot be a bound
 * parameter for the same reason `search_path` cannot: `SET` does not take one.
 * It is therefore forced through `Math.round` on a number this module owns, and
 * no caller-supplied string can reach it.
 */
async function prepareRuntimeSession(
  client: PoolClient,
  statementTimeoutMs?: number
) {
  // firsthand ONLY - no public. Since the Phase C cutover this pool runs on
  // Cortex's own RDS, where public holds the live application schema. With
  // public in the path, a future unqualified runtime query for a table
  // missing from the firsthand schema would silently resolve against live
  // Cortex tenant data instead of erroring. Nothing in the runtime needs
  // public: all 9 relations are verified in firsthand at startup and
  // gen_random_uuid() lives in pg_catalog.
  await client.query(
    `SET search_path TO ${FIRSTHAND_RUNTIME_SCHEMA}; ` +
      `SET statement_timeout TO ${statementTimeoutOf(statementTimeoutMs)}`
  );
}

/**
 * A whole positive number of milliseconds, always.
 *
 * `SET statement_timeout TO 0` disables the timeout, and a fractional or
 * non-finite value is a syntax error that would fail every checkout - so the
 * floor is 1 and anything unusable falls back to the default rather than
 * reaching Postgres.
 */
function statementTimeoutOf(statementTimeoutMs?: number): number {
  if (statementTimeoutMs === undefined || !Number.isFinite(statementTimeoutMs)) {
    return DEFAULT_STATEMENT_TIMEOUT_MS;
  }

  return Math.max(1, Math.round(statementTimeoutMs));
}
