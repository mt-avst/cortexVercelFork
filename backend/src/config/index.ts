import { Pool } from 'pg';
import dotenv from 'dotenv';
import { getBackendConfig, BackendEnvironment } from '../../../shared/config/environment';
import { describeDatabaseUrlSource, resolveDatabaseUrl } from './databaseUrl';
import { applyDbTls } from './dbTls';
import { attachPoolErrorLogging } from '../utils/poolErrorLogging';

dotenv.config();

// Validate environment variables
const config: BackendEnvironment = getBackendConfig();

/**
 * THE NORMALISED ORIGIN IS WRITTEN BACK, DELIBERATELY (#59).
 *
 * zod parses a COPY of `process.env` and never writes to it, and
 * `config.CORS_ORIGIN` has only two readers - the `cors()` origin and the
 * startup log line, both in backend/src/index.ts. `process.env.CORS_ORIGIN` has
 * ELEVEN more outside tests (routes/auth.ts x6, routes/userCalendar.ts x2,
 * services/userCalendar.ts x3), every one of them a redirect target or an OAuth
 * callback URL built by string concatenation.
 *
 * The SCHEME half of #59 reaches all thirteen for free: a bad scheme stops the
 * boot, so none of them ever runs. The PADDING half did not, and the gap is not
 * theoretical - measured against real express, `res.redirect(' https://x.com ')`
 * at routes/auth.ts:300 answers `302` with
 * `location: "%20https://x.com%20"`, a relative-path redirect to a route that
 * does not exist.
 *
 * ONLY WHEN IT WAS ALREADY SET. Assigning unconditionally would put the schema
 * default into a variable nobody set, and those eleven readers are chains like
 * `process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3001'`
 * - so an unset variable resolving to the CORS default would silently change
 * which fallback wins. This narrows a value somebody wrote; it never invents one.
 *
 * ponytail: normalising the environment is a plaster over eleven readers that
 *   should be reading `config`
 *   -> #71. Routing them through the validated object is the real fix and it
 *      touches the auth routes, which is its own review. The eleven do not even
 *      agree on their own fallbacks - some to :3000, some to :3001, some to
 *      FRONTEND_URL first - so that change is a decision, not a rename.
 */
if (process.env.CORS_ORIGIN !== undefined) {
  process.env.CORS_ORIGIN = config.CORS_ORIGIN;
}

const databaseUrl = resolveDatabaseUrl(process.env);
// Never logs the URL or password itself - just which env var supplied the
// connection and whether a password was present, so a bad credential shows
// up immediately in the init container's log instead of another guess.
console.log(`[db] connection source: ${describeDatabaseUrlSource(process.env)}`);

// attachPoolErrorLogging is load-bearing, not tidying: without an `error`
// listener an error on an idle pooled connection is an unhandled EventEmitter
// error, which terminates the process. See utils/poolErrorLogging.ts.
// TLS is decided by the HOST, not by NODE_ENV. The old condition meant a
// developer or a one-off run against a remote database - NODE_ENV unset - got
// no TLS at all rather than merely an unverified connection. See dbTls.ts for
// why verification is opt-in via DB_TLS_VERIFY rather than on by default.
const dbTls = applyDbTls(databaseUrl, process.env, 'backend');

/**
 * THE CEILING ON ONE STATEMENT, ENFORCED BY THE SERVER (cto/AdaptaLabs#40).
 *
 * `connectionTimeoutMillis` below bounds ACQUIRING a connection. It does not
 * bound the query once it has one, and nothing else did either: a lock never
 * granted, a pathological plan or a partition where the socket stays open waited
 * for ever. In production that holds a connection out of a fixed-size pool until
 * something else gives up, so one stuck query becomes pool exhaustion and the
 * symptom surfaces far from the cause. In CI it is a job timeout with no failing
 * test name - the shape this repo's own testing rule tells you to bound.
 *
 * A BACKSTOP, NOT A POLICY. This number is deliberately generous. It does not
 * try to make any path fail faster; it only converts "for ever" into "named".
 * 120s is not arbitrary:
 *
 *   - it equals SERVER_REQUEST_TIMEOUT_MS (server-timeouts.ts), the point at
 *     which Express abandons the request anyway. A statement outliving that is
 *     working for a caller who has already gone;
 *   - it equals RESULTS_STATEMENT_TIMEOUT_MS (firsthand/runtime-database.ts),
 *     the longest bound already sanctioned anywhere in this repo, so it cannot
 *     be tighter than something the team has accepted;
 *   - it is under the mutation canary's RUNNER_TIMEOUT_MS of 300s, so a wedged
 *     statement there now fails an entry BY NAME instead of eating the ceiling.
 *
 * Measured headroom on the two shared-pool paths whose cost scales with data,
 * against postgres:17 on a developer machine - so a measurement of statement
 * duration, and an ESTIMATE of the margin on a production RDS:
 *
 *   - migrations + seed (the deploy initContainer runs `migrate && seed` on THIS
 *     pool): 205ms total over 78 statements, slowest single statement 8ms;
 *   - the sync-booked-counts sweep at 20,000 sessions - far above this app's
 *     scale - slowest single statement 410ms, the correlated UPDATE.
 *
 * A future migration that legitimately needs longer must raise it on its own
 * client with `SET statement_timeout = 0`, and MUST `RESET statement_timeout`
 * afterwards: measured, a session-level SET leaks to every later checkout of
 * that pooled connection, and RESET restores this value rather than the server
 * default. Left unreset it would silently disarm this bound.
 *
 * THE SURVEY CSV EXPORT, precisely - because the loose version of this claim is
 * wrong and an earlier draft of this comment shipped it. It said the export
 * "runs on a SEPARATE pool. Nothing here can reach it." The second sentence is
 * false. An export REQUEST touches this pool three times before it reaches the
 * runtime pool at all:
 *
 *   1. requireAdmin -> currentDbRole (middleware/authenticate.ts) - SELECT role
 *      FROM users WHERE id = $1;
 *   2. isDatabaseAvailable (utils/database.ts) - SELECT 1;
 *   3. loadOpportunityResultsContext (routes/opportunities.ts) - SELECT ...
 *      FROM opportunities WHERE id = $1.
 *
 * (The study route, routes/firsthand.ts, does only the first.) All three are
 * primary-key point lookups, so the CONCLUSION survives - a 120s bound cannot
 * affect them - but the reason is "every shared-pool step on that path is a
 * point lookup", not "that path does not use this pool". Those are different
 * claims and only one of them is true.
 *
 * What is genuinely elsewhere is the LONG work: surveyCsvColumns,
 * surveyCsvParticipantIds and readBatch all run through
 * withRuntimeDatabaseClient on the runtime pool, which sets its own
 * `statement_timeout` per checkout (15s default, 120s for results reads).
 * Nothing here changes those.
 *
 * AND `firsthand/` IS NOT A POOL BOUNDARY. firsthand/completion-events.ts:1
 * imports THIS pool and writes to public.opportunity_session_events with it.
 * Do not reason "the file lives under firsthand/, therefore it is on the
 * runtime pool" - the code does not enforce that and one file already breaks it.
 *
 * Both pools also resolve the same DATABASE_URL, so since the Phase C cutover
 * they are two pools against ONE server, separated by search_path and by
 * per-connection settings rather than by hardware. The timeout genuinely does
 * not cross over - this one travels in the startup packet, the runtime one is
 * re-issued per checkout - but they do contend for the same max_connections.
 *
 * The other two CSV exports ARE wholly on this pool and are unbounded reads
 * with no LIMIT. Measured at 200,000 rows, far past this app's scale:
 * GET /api/admin/export/bookings (a four-table join) 472ms, and
 * GET /api/feedback/export 247ms. So 120s is ~250x and ~485x the measured cost
 * and this bound will not fire on either. Their real ceiling is memory - both
 * materialise the whole result into one JS string - which is cto/AdaptaLabs#65,
 * not this bound.
 */
export const POOL_STATEMENT_TIMEOUT_MS = 120_000;

/**
 * The client-side belt to the server-side braces, and it covers a DIFFERENT
 * failure.
 *
 * `statement_timeout` is enforced by the server, so it cannot help when the
 * server never replies at all - a partition where the socket stays open, the
 * TCP connection healthy, and no answer ever arriving. That is the failure this
 * covers, and it is a real one.
 *
 * WHAT IT DOES NOT COVER, because an earlier draft of this comment claimed it
 * did: #40's probe stubbed `pool.query` to return a promise that never settles.
 * NEITHER bound addresses that. Measured - a pool with `query_timeout: 1500`
 * and `pool.query` stubbed that way is still pending after 4s - because
 * replacing `pool.query` replaces the very machinery that arms the timer. A
 * stubbed method is not a slow database; it is a test double with no timer in
 * it, and no pool option can reach inside one. The probe demonstrated that
 * nothing bounded the query, which was true and worth acting on. It is not
 * evidence for this option, and citing it here sent the reader to a
 * measurement that proves nothing about the line it sits next to.
 *
 * Both bounds DO reach clients from `pool.connect()`, which is what matters for
 * the batch transaction in routes/sessions.ts. Measured on such a client:
 * `Query read timeout` at 1501ms and `57014` at 1518ms.
 *
 * ABOVE the statement timeout on purpose. Measured: with query_timeout under it
 * the client gives up first and pg destroys the connection; above it, the server
 * wins every ordinary race and answers 57014 - which errorHandler already maps
 * to a retryable 503 DB_STATEMENT_TIMEOUT - and this only fires when the server
 * said nothing. Its own rejection carries no SQLSTATE (`Error: Query read
 * timeout`), so it surfaces as a 500; that is honest for a server that has
 * stopped answering, and it is bounded, which is the whole point.
 */
export const POOL_QUERY_TIMEOUT_MS = 125_000;

export const pool = attachPoolErrorLogging(
  new Pool({
    connectionString: dbTls.connectionString,
    ssl: dbTls.ssl,
    // pg's default is 0 (wait forever). Without this, an unreachable database
    // makes the very first pool.connect() call hang silently - fatal in the
    // migrate/seed initContainer, which logs nothing until this fires and
    // exits with a clear error instead of hanging until Kubernetes kills it.
    connectionTimeoutMillis: 10_000,
    // A libpq startup parameter, not a query. It travels in the startup packet,
    // so the server has applied it before the connection is ever handed out -
    // there is no window in which a checkout is unbounded, which a
    // `pool.on('connect')` issuing a SET could not promise.
    options: `-c statement_timeout=${POOL_STATEMENT_TIMEOUT_MS}`,
    query_timeout: POOL_QUERY_TIMEOUT_MS,
  }),
  'backend'
);

export { config };
