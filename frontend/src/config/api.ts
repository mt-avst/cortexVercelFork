import { getFrontendConfig, FrontendEnvironment } from '../shared/config/environment';
import { API_CONFIG as SHARED_API_CONFIG } from '../shared/constants';

// Validate environment variables
const config: FrontendEnvironment = getFrontendConfig();

// API configuration
const getApiBaseUrl = () => {
  // IMPORTANT: Detect production FIRST before falling back to defaults
  // In production (Vercel deployment), use relative paths
  const isProduction = config.REACT_APP_ENVIRONMENT === 'production' || 
                       process.env.NODE_ENV === 'production' ||
                       (typeof window !== 'undefined' && !window.location.hostname.includes('localhost'));
  
  console.log('Environment detection:', { 
    isProduction, 
    NODE_ENV: process.env.NODE_ENV, 
    REACT_APP_ENVIRONMENT: config.REACT_APP_ENVIRONMENT,
    hostname: typeof window !== 'undefined' ? window.location.hostname : 'N/A',
    REACT_APP_API_URL: config.REACT_APP_API_URL
  });
  
  if (isProduction) {
    return '';
  }
  
  // Check for explicit environment variables
  if (config.REACT_APP_API_BASE_URL) {
    return config.REACT_APP_API_BASE_URL;
  }
  
  // Fallback to legacy environment variable (only in development)
  if (config.REACT_APP_API_URL && config.REACT_APP_API_URL !== 'http://localhost:3001') {
    return config.REACT_APP_API_URL;
  }
  
  // Development default (only for local dev)
  return 'http://localhost:3001';
};

const getAuthBaseUrl = () => {
  // Check for production environment variables first
  if (config.REACT_APP_AUTH_BASE_URL) {
    return config.REACT_APP_AUTH_BASE_URL;
  }
  
  // Fallback to API base URL
  return getApiBaseUrl();
};

export const API_CONFIG = {
  BASE_URL: getApiBaseUrl(),
  AUTH_BASE_URL: getAuthBaseUrl(),
  TIMEOUT: SHARED_API_CONFIG.TIMEOUT_MS,
} as const;

// Helper function to get full auth URL
export const getAuthUrl = (path: string) => {
  // Check for production environment variables first
  if (config.REACT_APP_AUTH_BASE_URL) {
    return `${config.REACT_APP_AUTH_BASE_URL}${path}`;
  }
  
  // Use dynamic calculation instead of frozen API_CONFIG
  const baseUrl = getAuthBaseUrl();
  return baseUrl ? `${baseUrl}${path}` : path;
};

// Helper function to get full API URL
export const getApiUrl = (path: string) => {
  // Use dynamic calculation instead of frozen API_CONFIG
  const baseUrl = getApiBaseUrl();
  return baseUrl ? `${baseUrl}${path}` : path;
};
