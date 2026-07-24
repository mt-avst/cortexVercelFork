import type { Pool, PoolClient } from 'pg';
import { logger } from './logger';

/**
 * Marks a pool that already has listeners attached, so a module evaluated
 * twice (jest's registry resets, or a re-import) cannot stack duplicates.
 */
const POOL_ERROR_LOGGING_ATTACHED = Symbol.for('cortex.poolErrorLoggingAttached');

type GuardedPool = Pool & { [POOL_ERROR_LOGGING_ATTACHED]?: boolean };

/**
 * Builds the log context for a client error.
 *
 * Deliberately projects named fields instead of passing the raw error through.
 * `pg-pool` sets `err.client = client` as an own enumerable property before it
 * emits, and the logger JSON-stringifies whatever context it is given, so
 * passing the error itself writes the client's `connectionParameters` - user,
 * database, host, port - and its `secretKey` (the backend cancel key) into log
 * aggregation. The password survives that, because `pg` defines it
 * non-enumerable, but the rest does not, and `config/index.ts` goes to the
 * trouble of never logging the connection URL for precisely that reason.
 *
 * Projecting is also strictly more useful: `message` and `stack` are
 * non-enumerable on `Error`, so serialising the raw object emits neither.
 */
function buildErrorContext(error: Error | undefined, poolName: string) {
  return {
    poolName,
    errorMessage: error?.message,
    errorDetails: {
      name: error?.name,
      // 57P01 is admin shutdown, the signature of an RDS failover or a manual
      // pg_terminate_backend - worth keeping to correlate against RDS events.
      code: (error as { code?: string } | undefined)?.code,
      stack: error?.stack,
    },
  };
}

/**
 * Keeps a database connection error from terminating the process.
 *
 * `pg` clients are EventEmitters, and Node throws when one emits `error` with
 * no listener registered. A dropped connection is therefore a hard process
 * exit unless something is listening, which on a single-replica backend is a
 * full outage.
 *
 * The event this exists for is an RDS failover: it drops every connection at
 * once, and AWS performs OS and engine patching on a Multi-AZ instance BY
 * failing over, so this is routine maintenance rather than only an incident.
 *
 * Two distinct paths need covering, because `pg-pool` moves the listener
 * around as clients are checked in and out:
 *
 * 1. **Idle clients.** `pg-pool` attaches its own idle listener and re-emits
 *    the error on the Pool, so a listener on the Pool covers these.
 * 2. **Checked-out clients.** `pg-pool` REMOVES the client's error listener on
 *    checkout (`pg-pool/index.js`, in the acquire path) and only restores it
 *    on release. A client that is checked out but not mid-query therefore has
 *    no listener at all, and its errors never reach the Pool. That window is
 *    real production shape here: `withRuntimeDatabaseClient` holds one client
 *    across a whole BEGIN/COMMIT transaction, so every gap between statements
 *    is exposed. This is why the `acquire`/`release` pair below exists - a
 *    Pool-only listener leaves the failover crash path open.
 *
 * Errors raised while a query is actually in flight are unaffected either way:
 * they reject that query and surface through the caller's own error handling.
 *
 * Logging is the whole remedy. On the idle path `pg-pool` evicts the failed
 * client before it emits, so the pool is immediately reusable and the next
 * checkout opens a fresh connection against the promoted instance. A
 * checked-out client instead keeps its pool slot until the caller releases it,
 * and is evicted at that point by the `_queryable` check in pg-pool's release
 * path - so the slot is reclaimed either way. `pg`'s own README example
 * calls `process.exit(-1)` here; that is right for the short-lived one-shot
 * scripts in `backend/src/db/**` and `scripts/**`, which are deliberately left
 * unguarded, but for a long-running API it converts a recoverable blip into
 * the outage this exists to prevent.
 *
 * NOTE the trade that follows from not exiting: a crash was previously the
 * only signal that reached Kubernetes, and `/health` does not touch the
 * database. A durably dead pool now leaves the pod Ready while requests fail,
 * so alerting on these log lines is what replaces the crash.
 */
export function attachPoolErrorLogging(pool: Pool, poolName: string): Pool {
  const guarded = pool as GuardedPool;

  if (guarded[POOL_ERROR_LOGGING_ATTACHED]) {
    return pool;
  }

  guarded[POOL_ERROR_LOGGING_ATTACHED] = true;

  // Path 1: idle clients, re-emitted on the Pool by pg-pool.
  pool.on('error', (error: Error) => {
    logger.error('Unexpected error on idle database client', buildErrorContext(error, poolName));
  });

  // Path 2: checked-out clients, which pg-pool leaves with no listener.
  // Attached on acquire and removed on release so idle errors are not logged
  // twice. Neither swap leaves a gap: pg-pool emits `acquire` before it removes
  // its idle listener, and restores that listener before it emits `release`.
  const checkedOutErrorListener = (error: Error) => {
    logger.error(
      'Unexpected error on checked-out database client',
      buildErrorContext(error, poolName)
    );
  };

  // Assumes one `release` per `acquire` per client, which holds for both pools
  // here. pg-pool's maxLifetimeSeconds path can acquire a client without
  // popping it from the idle set; neither pool sets that option, and it stays
  // balanced in practice, but revisit this pair if anyone enables it.
  pool.on('acquire', (client: PoolClient) => {
    client.on('error', checkedOutErrorListener);
  });

  pool.on('release', (_error: Error | undefined, client: PoolClient) => {
    client.removeListener('error', checkedOutErrorListener);
  });

  return pool;
}
