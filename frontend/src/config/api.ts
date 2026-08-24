import { getFrontendConfig, FrontendEnvironment } from '@shared/config/environment';
import { API_CONFIG as SHARED_API_CONFIG } from '@shared/constants';
import { logger } from '../utils/logger';

// Validate environment variables
const config: FrontendEnvironment = getFrontendConfig();

// API configuration
export const getApiBaseUrl = () => {
  // IMPORTANT: Detect production at RUNTIME, not build time
  // Check runtime environment variables first (these work in Vercel)
  const runtimeEnv = import.meta.env.VITE_ENVIRONMENT || import.meta.env.MODE;
  const isProductionBuild = runtimeEnv === 'production';
  
  // Check hostname at runtime - this is the most reliable indicator
  const isProductionRuntime = typeof window !== 'undefined' && 
                              !window.location.hostname.includes('localhost') &&
                              !window.location.hostname.includes('127.0.0.1') &&
                              window.location.hostname !== 'localhost';
  
  const isProduction = isProductionBuild || isProductionRuntime;
  
  logger.debug('Environment detection', { 
    isProduction, 
    isProductionBuild,
    isProductionRuntime,
    MODE: import.meta.env.MODE, 
    VITE_ENVIRONMENT: import.meta.env.VITE_ENVIRONMENT,
    hostname: typeof window !== 'undefined' ? window.location.hostname : 'N/A',
    VITE_API_URL: import.meta.env.VITE_API_URL,
    VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
  });
  
  if (isProduction) {
    return ''; // Use relative paths in production (same domain)
  }
  
  // Check for explicit environment variables (runtime check)
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL;
  }
  
  // Check config object (fallback for development)
  if (config.VITE_API_BASE_URL) {
    return config.VITE_API_BASE_URL;
  }
  
  // Fallback to legacy environment variable (only in development)
  const devApiUrl = import.meta.env.VITE_API_URL || config.VITE_API_URL;
  if (devApiUrl && !devApiUrl.includes('localhost')) {
    return devApiUrl;
  }

  // Local browser: Vite dev server proxies /api and /auth → backend (vite.config.ts).
  // Use same-origin URLs so session cookies stay on the UI origin (localhost:3000) and
  // login redirects (GET /api/auth/...) hit the proxy — direct :3001 calls break auth in dev.
  if (
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ) {
    if (import.meta.env.DEV) {
      return '';
    }
    return 'http://localhost:3001';
  }

  return '';
};

export const getAuthBaseUrl = () => {
  // Check runtime environment variables first
  if (import.meta.env.VITE_AUTH_BASE_URL) {
    return import.meta.env.VITE_AUTH_BASE_URL;
  }
  
  // Check config object (fallback)
  if (config.VITE_AUTH_BASE_URL) {
    return config.VITE_AUTH_BASE_URL;
  }
  
  // Fallback to API base URL
  return getApiBaseUrl();
};

// Make API_CONFIG dynamic using getters so it evaluates at runtime, not build time
// This ensures it works correctly on Vercel where production detection happens at runtime
export const API_CONFIG = {
  get BASE_URL() { return getApiBaseUrl(); },
  get AUTH_BASE_URL() { return getAuthBaseUrl(); },
  TIMEOUT: SHARED_API_CONFIG.TIMEOUT_MS,
};

// Helper function to get full auth URL
export const getAuthUrl = (path: string) => {
  // Check runtime environment variables first
  if (import.meta.env.VITE_AUTH_BASE_URL) {
    return `${import.meta.env.VITE_AUTH_BASE_URL}${path}`;
  }
  
  // Check config object (fallback)
  if (config.VITE_AUTH_BASE_URL) {
    return `${config.VITE_AUTH_BASE_URL}${path}`;
  }
  
  // Use dynamic calculation
  const baseUrl = getAuthBaseUrl();
  return baseUrl ? `${baseUrl}${path}` : path;
};

// Helper function to get full API URL
export const getApiUrl = (path: string) => {
  // Use dynamic calculation instead of frozen API_CONFIG
  const baseUrl = getApiBaseUrl();
  return baseUrl ? `${baseUrl}${path}` : path;
};
