/**
 * Environment Variable Helper for API Serverless Functions
 * 
 * Provides validated access to environment variables for API routes.
 * Uses lazy validation to avoid errors during module load (Vercel serverless).
 * 
 * Note: In serverless functions, env vars are available at runtime,
 * but validation should be done on first access, not module load.
 */

import { getBackendConfig, BackendEnvironment } from '../../shared/config/environment';

// Cache validated config (lazy initialization)
let cachedConfig: BackendEnvironment | null = null;

/**
 * Get validated backend environment configuration
 * Validates on first access and caches result
 * 
 * @returns Validated backend environment configuration
 */
export function getApiConfig(): BackendEnvironment {
  if (!cachedConfig) {
    try {
      cachedConfig = getBackendConfig();
    } catch (error) {
      // In serverless, env vars might not be set at module load time
      // Return a partial config with defaults to avoid startup failures
      console.warn('⚠️ Environment validation failed, using defaults:', error);
      cachedConfig = {
        NODE_ENV: (process.env.NODE_ENV as any) || 'development',
        PORT: 3001,
        DATABASE_URL: process.env.DATABASE_URL || process.env.POSTGRES_URL,
        SESSION_SECRET: process.env.SESSION_SECRET || 'default-secret-for-development-only',
        CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:3000',
        FRONTEND_URL: process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:3000',
        EMAIL_FROM: process.env.EMAIL_FROM,
        EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME,
        EMAIL_SMTP_HOST: process.env.EMAIL_SMTP_HOST,
        EMAIL_SMTP_PORT: process.env.EMAIL_SMTP_PORT ? parseInt(process.env.EMAIL_SMTP_PORT, 10) : undefined,
        EMAIL_SMTP_USER: process.env.EMAIL_SMTP_USER,
        EMAIL_SMTP_PASS: process.env.EMAIL_SMTP_PASS,
        GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
        GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
      } as BackendEnvironment;
    }
  }
  return cachedConfig;
}

/**
 * Get email configuration with validation
 * Returns validated email config or defaults
 */
export function getEmailConfig() {
  const config = getApiConfig();
  return {
    fromEmail: config.EMAIL_FROM || 'noreply@adaptalabs.com',
    fromName: config.EMAIL_FROM_NAME || 'AdaptaLabs',
    smtpHost: config.EMAIL_SMTP_HOST,
    smtpPort: config.EMAIL_SMTP_PORT,
    smtpUser: config.EMAIL_SMTP_USER,
    smtpPass: config.EMAIL_SMTP_PASS,
  };
}

/**
 * Get Google OAuth configuration with validation
 * Returns validated OAuth config or undefined
 */
export function getGoogleOAuthConfig() {
  const config = getApiConfig();
  return {
    clientId: config.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: config.GOOGLE_OAUTH_REDIRECT_URI,
  };
}

/**
 * Clear cached config (useful for testing)
 */
export function clearConfigCache() {
  cachedConfig = null;
}


