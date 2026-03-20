import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { logger } from './logger';

interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Max requests per window
  keyPrefix?: string;    // Prefix for rate limit keys
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/**
 * Get client IP from request, handling proxies
 */
function getClientIp(req: VercelRequest): string {
  // Vercel sets x-forwarded-for
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return ips.trim();
  }
  
  // Fallback to x-real-ip
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }
  
  // Last resort - use a placeholder (shouldn't happen on Vercel)
  return 'unknown';
}

/**
 * Check and update rate limit for a given key.
 * Uses PostgreSQL for distributed rate limiting across serverless instances.
 */
export async function checkRateLimit(
  req: VercelRequest,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const { windowMs, maxRequests, keyPrefix = 'rl' } = config;
  const ip = getClientIp(req);
  const key = `${keyPrefix}:${ip}`;
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowMs);

  try {
    // Ensure rate_limits table exists (create if not)
    await ensureRateLimitTable();

    // Clean up old entries and count recent requests in one transaction
    const result = await query(
      `
      WITH cleanup AS (
        DELETE FROM rate_limits 
        WHERE created_at < $1
      ),
      recent AS (
        SELECT COUNT(*) as count 
        FROM rate_limits 
        WHERE key = $2 AND created_at >= $3
      ),
      inserted AS (
        INSERT INTO rate_limits (key, created_at)
        SELECT $2, $4
        WHERE (SELECT count FROM recent) < $5
        RETURNING id
      )
      SELECT 
        (SELECT count FROM recent) as request_count,
        (SELECT COUNT(*) FROM inserted) as was_inserted
      `,
      [windowStart, key, windowStart, now, maxRequests]
    );

    const requestCount = parseInt(result.rows[0]?.request_count || '0', 10);
    const wasInserted = parseInt(result.rows[0]?.was_inserted || '0', 10) > 0;
    
    const allowed = requestCount < maxRequests;
    const remaining = Math.max(0, maxRequests - requestCount - (wasInserted ? 1 : 0));
    const resetAt = new Date(now.getTime() + windowMs);

    if (!allowed) {
      logger.warn('Rate limit exceeded', {
        ip,
        key,
        requestCount,
        maxRequests,
      });
    }

    return { allowed, remaining, resetAt };
  } catch (error) {
    // If rate limiting fails, allow the request but log the error
    logger.error('Rate limit check failed', {
      error: error instanceof Error ? error.message : String(error),
      ip,
      key,
    });
    
    // Fail open - allow request if rate limiting is broken
    return {
      allowed: true,
      remaining: maxRequests,
      resetAt: new Date(now.getTime() + windowMs),
    };
  }
}

/**
 * Ensure the rate_limits table exists
 */
async function ensureRateLimitTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      id SERIAL PRIMARY KEY,
      key VARCHAR(255) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      INDEX idx_rate_limits_key_created (key, created_at)
    )
  `).catch(async () => {
    // PostgreSQL doesn't support INDEX in CREATE TABLE, create separately
    await query(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        id SERIAL PRIMARY KEY,
        key VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_rate_limits_key_created 
      ON rate_limits (key, created_at)
    `).catch(() => {
      // Index might already exist, ignore error
    });
  });
}

/**
 * Middleware-style rate limiter for Vercel API routes.
 * Returns true if request should be blocked, false otherwise.
 */
export async function rateLimit(
  req: VercelRequest,
  res: VercelResponse,
  config: RateLimitConfig
): Promise<boolean> {
  const result = await checkRateLimit(req, config);

  // Set rate limit headers
  res.setHeader('X-RateLimit-Limit', config.maxRequests.toString());
  res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
  res.setHeader('X-RateLimit-Reset', result.resetAt.toISOString());

  if (!result.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({
      error: 'Too many requests',
      message: 'Please try again later',
      retryAfter: retryAfterSec,
    });
    return true; // Request blocked
  }

  return false; // Request allowed
}

// Pre-configured rate limiters for common use cases
// Auth: single shared bucket per IP for ALL /api/auth/* routes (admin-login, demo-login,
// google-login, google-callback, superadmin-login, etc.). 10/15min was too easy to hit during
// OAuth redirects, retries, and multi-tab testing — use env override in production if needed.
const AUTH_RATE_LIMIT_MAX = Math.min(
  200,
  Math.max(5, parseInt(process.env.AUTH_RATE_LIMIT_MAX || '35', 10) || 35)
);

export const authRateLimit = (req: VercelRequest, res: VercelResponse) =>
  rateLimit(req, res, {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: AUTH_RATE_LIMIT_MAX,
    keyPrefix: 'auth',
  });

export const apiRateLimit = (req: VercelRequest, res: VercelResponse) =>
  rateLimit(req, res, {
    windowMs: 60 * 1000,      // 1 minute
    maxRequests: 100,         // 100 requests per minute
    keyPrefix: 'api',
  });

export const feedbackRateLimit = (req: VercelRequest, res: VercelResponse) =>
  rateLimit(req, res, {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 20,          // 20 submissions per 15 min per IP
    keyPrefix: 'feedback',
  });

/** Stricter limit for destructive admin actions (reset DB, set-superadmin, etc.) */
export const adminRateLimit = (req: VercelRequest, res: VercelResponse) =>
  rateLimit(req, res, {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 5,           // 5 attempts per 15 min per IP
    keyPrefix: 'admin',
  });
