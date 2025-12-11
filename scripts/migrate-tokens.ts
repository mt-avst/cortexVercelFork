/**
 * Token Migration Script
 * 
 * This script migrates OAuth tokens from legacy XOR encryption to AES-256-GCM.
 * Run this script after deploying the security hardening changes.
 * 
 * Usage:
 *   npx ts-node scripts/migrate-tokens.ts
 * 
 * Environment variables required:
 *   - DATABASE_URL: PostgreSQL connection string
 *   - ENCRYPTION_KEY: 64-character hex key for AES-256-GCM
 *   - GOOGLE_OAUTH_CLIENT_SECRET: Used by legacy XOR encryption
 */

import { Pool } from 'pg';

// Configuration
const BATCH_SIZE = 100;
const DRY_RUN = process.argv.includes('--dry-run');

// Legacy XOR decryption (for reading old tokens)
function decryptLegacyXOR(encryptedHex: string, key: string): string {
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const keyBuffer = Buffer.from(key);
  const decrypted = Buffer.alloc(encrypted.length);
  
  for (let i = 0; i < encrypted.length; i++) {
    decrypted[i] = encrypted[i] ^ keyBuffer[i % keyBuffer.length];
  }
  
  return decrypted.toString('utf8');
}

// AES-256-GCM encryption (new secure format)
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(keyHex, 'hex');
}

function encryptAES(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  
  const authTag = cipher.getAuthTag();
  
  // Format: iv:authTag:ciphertext (all base64)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

function isLegacyFormat(token: string): boolean {
  // Legacy XOR format is just hex characters
  // New AES format contains colons (iv:tag:ciphertext)
  return !token.includes(':') && /^[0-9a-fA-F]+$/.test(token);
}

async function migrateTokens() {
  console.log('🔐 Token Migration Script');
  console.log('========================');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log('');

  // Validate environment
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL environment variable is required');
    process.exit(1);
  }
  if (!process.env.ENCRYPTION_KEY) {
    console.error('❌ ENCRYPTION_KEY environment variable is required');
    process.exit(1);
  }
  if (!process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    console.error('❌ GOOGLE_OAUTH_CLIENT_SECRET environment variable is required (for legacy decryption)');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    // Check if user_calendars table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'user_calendars'
      )
    `);

    if (!tableCheck.rows[0].exists) {
      console.log('ℹ️  user_calendars table does not exist - no migration needed');
      return;
    }

    // Count tokens to migrate
    const countResult = await pool.query(`
      SELECT COUNT(*) as total,
             COUNT(CASE WHEN encrypted_tokens IS NOT NULL AND encrypted_tokens NOT LIKE '%:%' THEN 1 END) as legacy
      FROM user_calendars
      WHERE encrypted_tokens IS NOT NULL
    `);

    const total = parseInt(countResult.rows[0].total, 10);
    const legacy = parseInt(countResult.rows[0].legacy, 10);

    console.log(`📊 Found ${total} users with tokens`);
    console.log(`   - ${legacy} with legacy XOR encryption`);
    console.log(`   - ${total - legacy} already using AES-256-GCM`);
    console.log('');

    if (legacy === 0) {
      console.log('✅ No legacy tokens to migrate!');
      return;
    }

    // Fetch and migrate in batches
    let migrated = 0;
    let failed = 0;
    let offset = 0;

    while (true) {
      const batch = await pool.query(`
        SELECT id, user_id, encrypted_tokens 
        FROM user_calendars 
        WHERE encrypted_tokens IS NOT NULL 
          AND encrypted_tokens NOT LIKE '%:%'
        LIMIT $1 OFFSET $2
      `, [BATCH_SIZE, offset]);

      if (batch.rows.length === 0) break;

      for (const row of batch.rows) {
        try {
          // Decrypt with legacy XOR
          const decrypted = decryptLegacyXOR(
            row.encrypted_tokens,
            process.env.GOOGLE_OAUTH_CLIENT_SECRET!
          );

          // Validate it's valid JSON
          JSON.parse(decrypted);

          // Re-encrypt with AES-256-GCM
          const newEncrypted = encryptAES(decrypted);

          if (!DRY_RUN) {
            await pool.query(`
              UPDATE user_calendars 
              SET encrypted_tokens = $1, updated_at = NOW()
              WHERE id = $2
            `, [newEncrypted, row.id]);
          }

          migrated++;
          console.log(`✅ Migrated user ${row.user_id}`);
        } catch (error) {
          failed++;
          console.error(`❌ Failed to migrate user ${row.user_id}:`, error instanceof Error ? error.message : error);
        }
      }

      offset += BATCH_SIZE;
    }

    console.log('');
    console.log('📋 Migration Summary');
    console.log('====================');
    console.log(`✅ Successfully migrated: ${migrated}`);
    console.log(`❌ Failed: ${failed}`);
    
    if (DRY_RUN) {
      console.log('');
      console.log('ℹ️  This was a dry run. Run without --dry-run to apply changes.');
    }

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run migration
migrateTokens().catch(console.error);
