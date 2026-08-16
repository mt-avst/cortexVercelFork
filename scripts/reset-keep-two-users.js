#!/usr/bin/env node
/**
 * Reset DB: remove all users except Nick Fine and Greta Baisch; delete all studies (bookings, sessions, opportunities).
 * Usage: node scripts/reset-keep-two-users.js --yes
 * Or: DATABASE_URL="your-url" node scripts/reset-keep-two-users.js --yes
 *
 * --yes is required. This is irreversible and takes no target argument, so
 * without it the script names the database it would have emptied and stops.
 * Requires DATABASE_URL or POSTGRES_URL in env (e.g. from .env or vercel env pull).
 *
 * Against a remote database this verifies the server certificate, so it needs
 * the CA bundle:
 *   curl -o ~/.postgresql/rds-global-bundle.pem \
 *     https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
 *   export PGSSLROOTCERT=~/.postgresql/rds-global-bundle.pem
 */

const { Pool } = require('pg');

const { buildPgSslConfig } = require('./lib/pg-ssl');

const KEEP_USER_NAMES = ['Nick Fine', 'Greta Baisch'];

const CONFIRM_FLAG = '--yes';
const confirmed = process.argv.slice(2).includes(CONFIRM_FLAG);

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!databaseUrl) {
  console.error('❌ DATABASE_URL or POSTGRES_URL environment variable is not set');
  console.error('   Run: vercel env pull .env.production  (then use that file) or set DATABASE_URL');
  process.exit(1);
}

let cleanUrl = databaseUrl.trim();
if (cleanUrl.startsWith('"') || cleanUrl.startsWith("'")) {
  cleanUrl = cleanUrl.slice(1, -1);
}
if (cleanUrl.startsWith("psql '")) {
  cleanUrl = cleanUrl.replace(/^psql ['"]/, '').replace(/['"]$/, '');
}

// Verified TLS, or no connection at all. buildPgSslConfig throws with the
// remedy when it cannot verify, rather than falling back to an unverified
// connection carrying these credentials.
//
// BOTH halves of the result go to the Pool. The returned connection string has
// the TLS parameters stripped out, because pg lets the string override the ssl
// option rather than the other way round. See pg-ssl.js.
let poolConfig;
try {
  poolConfig = buildPgSslConfig(cleanUrl, process.env);
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// This script is irreversible and takes no target argument, so the only thing
// between a mistyped DATABASE_URL and an emptied production database was
// pressing return. The confirmation is a required flag rather than an
// interactive prompt: a prompt needs a TTY, which breaks the moment anyone runs
// this from a script or a non-interactive shell, and it cannot be tested
// without one.
//
// Deliberately AFTER the connection string is resolved, so the refusal can name
// the database it would have emptied - the mistake this guards against is
// usually "right command, wrong environment". Deliberately BEFORE the Pool is
// constructed, so nothing connects on the refusing path.
if (!confirmed) {
  const target = new URL(poolConfig.connectionString);
  console.error(`❌ Refusing to run without ${CONFIRM_FLAG}.\n`);
  console.error('This deletes EVERY booking, session and opportunity, and every');
  console.error(`user except: ${KEEP_USER_NAMES.join(', ')}.\n`);
  // Host, port and database only. Never the whole string - it carries the
  // password, and this message is the one most likely to be pasted into chat.
  const port = target.port ? `:${target.port}` : '';
  console.error(`Target: ${target.hostname}${port}${target.pathname}\n`);
  console.error(`Re-run with ${CONFIRM_FLAG} if that is genuinely what you want.`);
  process.exit(1);
}

const pool = new Pool(poolConfig);

async function reset() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const delBookings = await client.query('DELETE FROM bookings');
    console.log('Deleted bookings:', delBookings.rowCount ?? 0);

    const delSessions = await client.query('DELETE FROM sessions');
    console.log('Deleted sessions:', delSessions.rowCount ?? 0);

    const delOpps = await client.query('DELETE FROM opportunities');
    console.log('Deleted opportunities:', delOpps.rowCount ?? 0);

    const keepResult = await client.query(
      'SELECT id, name FROM users WHERE name ILIKE ANY($1::text[])',
      [KEEP_USER_NAMES]
    );
    const keepIds = keepResult.rows.map((r) => r.id);
    console.log('Keeping users:', keepResult.rows.map((r) => r.name).join(', ') || '(none found)');

    let deletedUsers = 0;
    if (keepIds.length > 0) {
      const delUsers = await client.query(
        'DELETE FROM users WHERE NOT (id = ANY($1::uuid[]))',
        [keepIds]
      );
      deletedUsers = delUsers.rowCount ?? 0;
    } else {
      const delUsers = await client.query('DELETE FROM users');
      deletedUsers = delUsers.rowCount ?? 0;
    }
    console.log('Deleted users:', deletedUsers);

    await client.query('COMMIT');
    console.log('\n✅ Reset complete. Only Nick Fine and Greta Baisch remain; all studies removed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

reset().catch(() => process.exit(1));
