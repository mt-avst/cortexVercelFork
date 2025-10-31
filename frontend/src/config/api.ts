import { getFrontendConfig, FrontendEnvironment } from '../shared/config/environment';
import { API_CONFIG as SHARED_API_CONFIG } from '../shared/constants';

// Validate environment variables
const config: FrontendEnvironment = getFrontendConfig();

// API configuration
export const getApiBaseUrl = () => {
  // IMPORTANT: Detect production at RUNTIME, not build time
  // Check runtime environment variables first (these work in Vercel)
  const runtimeEnv = process.env.REACT_APP_ENVIRONMENT || process.env.NODE_ENV;
  const isProductionBuild = runtimeEnv === 'production';
  
  // Check hostname at runtime - this is the most reliable indicator
  const isProductionRuntime = typeof window !== 'undefined' && 
                              !window.location.hostname.includes('localhost') &&
                              !window.location.hostname.includes('127.0.0.1') &&
                              window.location.hostname !== 'localhost';
  
  const isProduction = isProductionBuild || isProductionRuntime;
  
  console.log('Environment detection:', { 
    isProduction, 
    isProductionBuild,
    isProductionRuntime,
    NODE_ENV: process.env.NODE_ENV, 
    REACT_APP_ENVIRONMENT: process.env.REACT_APP_ENVIRONMENT,
    hostname: typeof window !== 'undefined' ? window.location.hostname : 'N/A',
    REACT_APP_API_URL: process.env.REACT_APP_API_URL,
    REACT_APP_API_BASE_URL: process.env.REACT_APP_API_BASE_URL
  });
  
  if (isProduction) {
    return ''; // Use relative paths in production (same domain)
  }
  
  // Check for explicit environment variables (runtime check)
  if (process.env.REACT_APP_API_BASE_URL) {
    return process.env.REACT_APP_API_BASE_URL;
  }
  
  // Check config object (fallback for development)
  if (config.REACT_APP_API_BASE_URL) {
    return config.REACT_APP_API_BASE_URL;
  }
  
  // Fallback to legacy environment variable (only in development)
  const devApiUrl = process.env.REACT_APP_API_URL || config.REACT_APP_API_URL;
  if (devApiUrl && !devApiUrl.includes('localhost')) {
    return devApiUrl;
  }
  
  // Development default (only used when running locally)
  // This will NEVER execute in production because isProduction check happens first
  if (typeof window !== 'undefined' && 
      (window.location.hostname === 'localhost' || 
       window.location.hostname === '127.0.0.1')) {
    return 'http://localhost:3001';
  }
  
  // If we somehow get here in production, use relative paths
  return '';
};

export const getAuthBaseUrl = () => {
  // Check runtime environment variables first
  if (process.env.REACT_APP_AUTH_BASE_URL) {
    return process.env.REACT_APP_AUTH_BASE_URL;
  }
  
  // Check config object (fallback)
  if (config.REACT_APP_AUTH_BASE_URL) {
    return config.REACT_APP_AUTH_BASE_URL;
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
  if (process.env.REACT_APP_AUTH_BASE_URL) {
    return `${process.env.REACT_APP_AUTH_BASE_URL}${path}`;
  }
  
  // Check config object (fallback)
  if (config.REACT_APP_AUTH_BASE_URL) {
    return `${config.REACT_APP_AUTH_BASE_URL}${path}`;
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
