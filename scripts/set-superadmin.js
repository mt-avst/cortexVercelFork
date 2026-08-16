#!/usr/bin/env node
/**
 * Set superadmin role for a specific user
 * Usage: node scripts/set-superadmin.js <email>
 * Or: DATABASE_URL="your-url" node scripts/set-superadmin.js <email>
 *
 * The email is required - there is no default.
 *
 * Against RDS this verifies the server certificate, so it needs the CA bundle:
 *   curl -o ~/.postgresql/rds-global-bundle.pem \
 *     https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
 *   export PGSSLROOTCERT=~/.postgresql/rds-global-bundle.pem
 */

const { Pool } = require('pg');

const { buildPgSslConfig } = require('./lib/pg-ssl');

// No default. This grants superadmin, so a dropped or mistyped argument has to
// stop the script rather than quietly promote whoever the default named.
const email = (process.argv[2] || '').trim();
if (!email) {
  console.error('Usage: node scripts/set-superadmin.js <email>');
  console.error('Example: node scripts/set-superadmin.js someone@adaptavist.com');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!databaseUrl) {
  console.error('❌ DATABASE_URL or POSTGRES_URL environment variable is not set');
  process.exit(1);
}

// Clean up connection string
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
// option rather than the other way round - passing the original string back
// here would reopen the hole. See pg-ssl.js.
let poolConfig;
try {
  poolConfig = buildPgSslConfig(cleanUrl, process.env);
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const pool = new Pool(poolConfig);

async function setSuperadmin() {
  const client = await pool.connect();
  
  try {
    console.log(`🔄 Setting superadmin role for ${email}...\n`);

    // First, update the role constraint to include superadmin if needed
    try {
      await client.query(`
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
        ALTER TABLE users ADD CONSTRAINT users_role_check 
          CHECK (role IN ('employee', 'researcher_admin', 'superadmin'));
      `);
      console.log('✅ Updated role constraint to include superadmin');
    } catch (error) {
      // See set-superadmin.ts, which this file duplicates: not fatal, because a
      // connection that cannot ALTER the table still works against a database
      // whose constraint already allows superadmin, and the UPDATE below is the
      // real gate. The message no longer asserts a cause it has not checked,
      // and the error is no longer discarded.
      console.log(
        'ℹ️  Role constraint update did not apply:',
        error instanceof Error ? error.message : String(error)
      );
    }

    // Check if user exists
    const userResult = await client.query(
      'SELECT id, name, email, role FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      console.error(`❌ User with email ${email} not found`);
      process.exit(1);
    }

    const user = userResult.rows[0];
    console.log(`📋 Found user: ${user.name} (${user.email})`);
    console.log(`   Current role: ${user.role}`);

    // Update role to superadmin
    await client.query(
      'UPDATE users SET role = $1 WHERE email = $2',
      ['superadmin', email]
    );

    console.log(`\n✅ Successfully set ${email} to superadmin role!`);
    console.log(`\n🎉 You can now test the superadmin functionality.`);
    console.log(`   - Log out and log back in to refresh your session`);
    console.log(`   - Go to Settings to see the Admin Management section`);
  } catch (error) {
    console.error('❌ Error setting superadmin role:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

setSuperadmin()
  .then(() => {
    console.log('\n✅ Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Failed:', error);
    process.exit(1);
  });

