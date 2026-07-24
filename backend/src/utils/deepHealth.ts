/**
 * Deep health check
 *
 * `GET /health` is deliberately static: it answers while the process is alive
 * and says nothing about the database. That is the right shape for the
 * Kubernetes probes on a single-replica deployment - see the readiness probe
 * note in `.kubera/playground-backend.yaml`.
 *
 * This module backs the separate `/api/health` endpoint, which does touch the
 * pool, so a durably dead database is reportable rather than being something
 * only the application's own 503s reveal. Issue #3.
 */

import type { Pool } from 'pg';
import { logger } from './logger';

/** Independent cap, well inside the pool's own connectionTimeoutMillis of 10s. */
export const DEEP_HEALTH_TIMEOUT_MS = 2_000;

/**
 * How long a verdict is reused. This is what makes the endpoint's database
 * cost constant rather than proportional to request rate - see
 * createDatabaseHealthProbe.
 */
export const DEEP_HEALTH_CACHE_MS = 1_000;

export interface DatabaseHealth {
  healthy: boolean;
  /** Coarse reason only. Never carries driver text - this is served publicly. */
  reason?: 'timeout' | 'error';
  latencyMs: number;
}

/**
 * Runs `SELECT 1` against the pool, bounded by its own timeout.
 *
 * Never rejects, including when `pool.query` throws synchronously: a health
 * check that throws is a health check that takes the process with it.
 */
export const checkDatabaseHealth = async (
  pool: Pick<Pool, 'query'>,
  timeoutMs: number = DEEP_HEALTH_TIMEOUT_MS
): Promise<DatabaseHealth> => {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  try {
    // Promise.race subscribes to every promise it is handed, so when the
    // timeout wins, the probe's later rejection still has race's own handler
    // attached and cannot surface as an unhandled rejection - which Node
    // terminates the process for, and which would mean this check crashed the
    // backend during exactly the outage it exists to report.
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('deep health check timed out'));
        }, timeoutMs);
        // A health check must not hold the event loop open.
        timer.unref?.();
      }),
    ]);
    return { healthy: true, latencyMs: Date.now() - started };
  } catch (error) {
    // Taken from which promise won, not from elapsed time: a driver error
    // that happens to surface near the deadline is still an error, and this
    // is the field an operator triages on.
    const reason = timedOut ? 'timeout' : 'error';
    const latencyMs = Date.now() - started;
    // Driver detail goes to the log, never to the response body.
    logger.error('Deep health check failed', {
      reason,
      latencyMs,
      errorDetails: {
        name: (error as Error)?.name,
        message: (error as Error)?.message,
        code: (error as { code?: string })?.code,
      },
    });
    return { healthy: false, reason, latencyMs };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Wraps the check so that concurrent callers share one probe and a verdict is
 * briefly reused.
 *
 * This is the endpoint's safety property, not an optimisation. The timeout
 * above abandons the promise but cannot cancel the query, and `pg` holds the
 * pooled client until the query actually settles - which, when a failover
 * blackholes an established connection rather than resetting it, is the TCP
 * retransmission timeout: minutes. Without this, each request would pin
 * another client from a pool whose max is pg's default of 10, so an
 * unauthenticated caller could exhaust connection acquisition during exactly
 * the outage the endpoint reports on, and readiness deliberately will not
 * restart the pod out of it. With it, at most one probe is ever in flight.
 *
 * Deliberately probes the MAIN pool rather than a private one: a dedicated
 * pool would report that the database is reachable while saying nothing about
 * the pool the issue is actually about.
 */
export const createDatabaseHealthProbe = (
  pool: Pick<Pool, 'query'>,
  {
    timeoutMs = DEEP_HEALTH_TIMEOUT_MS,
    cacheMs = DEEP_HEALTH_CACHE_MS,
  }: { timeoutMs?: number; cacheMs?: number } = {}
): (() => Promise<DatabaseHealth>) => {
  let inFlight: Promise<DatabaseHealth> | null = null;
  let cached: { at: number; value: DatabaseHealth } | null = null;

  return async (): Promise<DatabaseHealth> => {
    if (cached && Date.now() - cached.at < cacheMs) {
      return cached.value;
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = checkDatabaseHealth(pool, timeoutMs)
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };
};
