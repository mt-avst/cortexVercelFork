/**
 * Secure Encryption Utilities
 * 
 * Uses AES-256-GCM for encrypting sensitive data like OAuth tokens.
 * This replaces the previous insecure XOR-based encryption.
 */

import crypto from 'crypto';
import { logger } from './logger';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recommended IV length
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

/**
 * Get or derive the encryption key from environment.
 * The key should be a 32-byte (256-bit) hex string or base64 string.
 */
function getEncryptionKey(): Buffer {
  const keyEnv = process.env.ENCRYPTION_KEY;
  
  if (!keyEnv) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY environment variable is required in production');
    }
    // Development fallback - NOT secure, only for local dev
    logger.warn('Using development-only encryption key - NOT SECURE');
    return crypto.scryptSync('dev-only-key', 'dev-salt', KEY_LENGTH);
  }

  // If key looks like hex (64 chars), decode as hex
  if (/^[0-9a-fA-F]{64}$/.test(keyEnv)) {
    return Buffer.from(keyEnv, 'hex');
  }

  // If key is base64, decode as base64
  if (/^[A-Za-z0-9+/=]+$/.test(keyEnv) && keyEnv.length >= 43) {
    const decoded = Buffer.from(keyEnv, 'base64');
    if (decoded.length >= KEY_LENGTH) {
      return decoded.slice(0, KEY_LENGTH);
    }
  }

  // Otherwise, derive key from the string using scrypt
  logger.warn('Deriving encryption key from string - consider using a proper 32-byte key');
  return crypto.scryptSync(keyEnv, 'adaptalabs-salt', KEY_LENGTH);
}

/**
 * Encrypt sensitive data using AES-256-GCM.
 * Returns base64-encoded string containing: IV + ciphertext + auth tag
 * 
 * @param plaintext - The data to encrypt
 * @returns Base64-encoded encrypted data
 */
export function encrypt(plaintext: string): string {
  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    const authTag = cipher.getAuthTag();
    
    // Combine IV + ciphertext + authTag
    const combined = Buffer.concat([iv, encrypted, authTag]);
    
    return combined.toString('base64');
  } catch (error) {
    logger.error('Encryption failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error('Encryption failed');
  }
}

/**
 * Decrypt data that was encrypted with encrypt().
 * 
 * @param encryptedData - Base64-encoded encrypted data
 * @returns Decrypted plaintext
 */
export function decrypt(encryptedData: string): string {
  try {
    const key = getEncryptionKey();
    const combined = Buffer.from(encryptedData, 'base64');
    
    // Extract IV, ciphertext, and auth tag
    const iv = combined.slice(0, IV_LENGTH);
    const authTag = combined.slice(-AUTH_TAG_LENGTH);
    const ciphertext = combined.slice(IV_LENGTH, -AUTH_TAG_LENGTH);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString('utf8');
  } catch (error) {
    logger.error('Decryption failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error('Decryption failed - data may be corrupted or key mismatch');
  }
}

/**
 * Check if encrypted data uses the legacy XOR format.
 * Legacy format is base64 that decodes to printable ASCII with 'demo:' prefix
 * or doesn't contain the proper GCM structure.
 */
export function isLegacyEncryption(encryptedData: string): boolean {
  try {
    const decoded = Buffer.from(encryptedData, 'base64');
    
    // Check for demo prefix
    const str = decoded.toString('utf8');
    if (str.startsWith('demo:')) {
      return true;
    }
    
    // Legacy XOR encryption produces printable ASCII
    // GCM produces binary data that often has unprintable chars
    const isPrintableAscii = /^[\x20-\x7E]*$/.test(str);
    
    // If it's short or all printable, likely legacy
    if (decoded.length < IV_LENGTH + AUTH_TAG_LENGTH || isPrintableAscii) {
      return true;
    }
    
    return false;
  } catch {
    return false;
  }
}

/**
 * Decrypt legacy XOR-encrypted data.
 * This maintains backwards compatibility during migration.
 * 
 * @deprecated Use decrypt() for new data
 */
export function decryptLegacy(encryptedData: string): string {
  const keyEnv = process.env.ENCRYPTION_KEY || 'demo-key';
  const key = keyEnv.padEnd(32, '0').substring(0, 32);
  
  const decoded = Buffer.from(encryptedData, 'base64').toString('utf8');
  
  // Check for demo prefix
  if (decoded.startsWith('demo:')) {
    return decoded.replace('demo:', '');
  }
  
  // XOR decryption
  let decrypted = '';
  for (let i = 0; i < decoded.length; i++) {
    decrypted += String.fromCharCode(decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  
  return decrypted;
}

/**
 * Decrypt data, automatically handling both legacy and new formats.
 * Use this during migration period.
 */
export function decryptAuto(encryptedData: string): string {
  if (isLegacyEncryption(encryptedData)) {
    logger.debug('Decrypting legacy-format data');
    return decryptLegacy(encryptedData);
  }
  return decrypt(encryptedData);
}

/**
 * Generate a secure random encryption key (for initial setup).
 * Returns a 64-character hex string suitable for ENCRYPTION_KEY env var.
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(KEY_LENGTH).toString('hex');
}
