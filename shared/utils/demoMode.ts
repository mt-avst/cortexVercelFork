/**
 * Demo Mode Detection Utility
 * 
 * Centralized demo mode detection for Google OAuth integration.
 * Demo mode is enabled when Google OAuth credentials are not configured.
 * 
 * This utility ensures consistent demo mode detection across:
 * - API serverless functions (api/)
 * - Backend Express routes (backend/src/routes/)
 */

/**
 * Check if Google OAuth is configured (production mode)
 * Returns true if credentials are missing (demo mode)
 * 
 * @returns true if in demo mode (credentials missing), false if in production mode
 */
export function isGoogleOAuthDemoMode(): boolean {
  return !process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET;
}

/**
 * Check if Google OAuth is configured (production mode)
 * Returns true if credentials are present (production mode)
 * 
 * @returns true if in production mode (credentials present), false if in demo mode
 */
export function isGoogleOAuthProductionMode(): boolean {
  return !isGoogleOAuthDemoMode();
}


