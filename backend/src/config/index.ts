import { Pool } from 'pg';
import dotenv from 'dotenv';
import { getBackendConfig, BackendEnvironment } from '../../../shared/config/environment';
import { describeDatabaseUrlSource, resolveDatabaseUrl } from './databaseUrl';
import { applyDbTls } from './dbTls';
import { attachPoolErrorLogging } from '../utils/poolErrorLogging';

dotenv.config();

// Validate environment variables
const config: BackendEnvironment = getBackendConfig();

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

export const pool = attachPoolErrorLogging(
  new Pool({
    connectionString: dbTls.connectionString,
    ssl: dbTls.ssl,
    // pg's default is 0 (wait forever). Without this, an unreachable database
    // makes the very first pool.connect() call hang silently - fatal in the
    // migrate/seed initContainer, which logs nothing until this fires and
    // exits with a clear error instead of hanging until Kubernetes kills it.
    connectionTimeoutMillis: 10_000,
  }),
  'backend'
);

export { config };
