#!/usr/bin/env node
/**
 * Set researcher_admin role for one or more users by email.
 * Usage: npx ts-node scripts/set-researcher-admin.ts <email1> [email2 ...]
 * Example: npx ts-node scripts/set-researcher-admin.ts choward@adaptavist.com gbaisch@adaptavist.com
 *
 * Users must exist in the database (e.g. have logged in once with Google) before running.
 * For production: use DATABASE_URL from Vercel (e.g. vercel env pull, then run this script).
 */

import { Pool } from 'pg';

const emails = process.argv.slice(2).filter(Boolean);
if (emails.length === 0) {
  console.error('Usage: npx ts-node scripts/set-researcher-admin.ts <email1> [email2 ...]');
  console.error('Example: npx ts-node scripts/set-researcher-admin.ts choward@adaptavist.com gbaisch@adaptavist.com');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!databaseUrl) {
  console.error('❌ DATABASE_URL or POSTGRES_URL environment variable is not set');
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

async function setResearcherAdmins() {
  const client = await pool.connect();
  try {
    for (const email of emails) {
      const result = await client.query(
        'SELECT id, name, email, role FROM users WHERE email = $1',
        [email]
      );
      if (result.rows.length === 0) {
        console.log(`⚠️  ${email} — user not found. Have them log in once with Google to create their account, then run this script again.`);
        continue;
      }
      const user = result.rows[0] as { id: string; name: string; email: string; role: string };
      if (user.role === 'researcher_admin' || user.role === 'superadmin') {
        console.log(`ℹ️  ${user.name} (${email}) — already ${user.role}, no change.`);
        continue;
      }
      await client.query(
        'UPDATE users SET role = $1 WHERE email = $2',
        ['researcher_admin', email]
      );
      console.log(`✅ Set ${user.name} (${email}) to researcher_admin.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

setResearcherAdmins()
  .then(() => {
    console.log('\nDone.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Error:', err);
    process.exit(1);
  });
