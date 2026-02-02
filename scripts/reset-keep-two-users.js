#!/usr/bin/env node
/**
 * Reset DB: remove all users except Nick Fine and Greta Baisch; delete all studies (bookings, sessions, opportunities).
 * Usage: node scripts/reset-keep-two-users.js
 * Or: DATABASE_URL="your-url" node scripts/reset-keep-two-users.js
 * Requires DATABASE_URL or POSTGRES_URL in env (e.g. from .env or vercel env pull).
 */

const { Pool } = require('pg');

const KEEP_USER_NAMES = ['Nick Fine', 'Greta Baisch'];

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

const pool = new Pool({
  connectionString: cleanUrl,
  ssl: { rejectUnauthorized: false },
});

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
