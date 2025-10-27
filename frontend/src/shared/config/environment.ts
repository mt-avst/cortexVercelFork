// Shared Environment Configuration for Adaptalabs Application
// This file contains standardized environment variable definitions and validation

import { z } from 'zod';

// ============================================================================
// ENVIRONMENT SCHEMAS
// ============================================================================

/**
 * Backend environment variables schema
 */
export const backendEnvSchema = z.object({
  // Application Configuration
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default(3001),
  
  // Database Configuration
  DATABASE_URL: z.string().min(1, 'Database URL is required'),
  
  // Session Configuration
  SESSION_SECRET: z.string().min(32, 'Session secret must be at least 32 characters'),
  
  // OIDC Configuration
  OIDC_ISSUER: z.string().url('OIDC issuer must be a valid URL'),
  OIDC_CLIENT_ID: z.string().min(1, 'OIDC client ID is required'),
  OIDC_CLIENT_SECRET: z.string().min(1, 'OIDC client secret is required'),
  OIDC_REDIRECT_URL: z.string().url('OIDC redirect URL must be a valid URL'),
  
  // Admin Configuration
  ADMIN_EMAILS: z.string().optional().transform(val => 
    val ? val.split(',').map(email => email.trim()) : []
  ),
  
  // CORS Configuration
  CORS_ORIGIN: z.string().url('CORS origin must be a valid URL').default('http://localhost:3000'),
  
  // Security Configuration
  ENABLE_CSRF: z.string().transform(val => val === 'true').default(false),
  
  // Email Configuration (Optional)
  EMAIL_FROM: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().optional(),
  EMAIL_SMTP_HOST: z.string().optional(),
  EMAIL_SMTP_PORT: z.string().transform(Number).optional(),
  EMAIL_SMTP_USER: z.string().optional(),
  EMAIL_SMTP_PASS: z.string().optional(),
  
  // Google Calendar Configuration (Optional)
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  GOOGLE_PRIVATE_KEY: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().optional(),
  
  // Frontend URL
  FRONTEND_URL: z.string().url('Frontend URL must be a valid URL').default('http://localhost:3000'),
});

/**
 * Frontend environment variables schema
 */
export const frontendEnvSchema = z.object({
  // API Configuration
  REACT_APP_API_URL: z.string().url('API URL must be a valid URL').default('http://localhost:3001'),
  REACT_APP_API_BASE_URL: z.string().url('API base URL must be a valid URL').optional(),
  REACT_APP_AUTH_BASE_URL: z.string().url('Auth base URL must be a valid URL').optional(),
  
  // Environment
  REACT_APP_ENVIRONMENT: z.enum(['development', 'production', 'test']).default('development'),
  
  // Feature Flags
  REACT_APP_ENABLE_ANALYTICS: z.string().transform(val => val === 'true').default('false'),
  REACT_APP_ENABLE_DEBUG: z.string().transform(val => val === 'true').default('false'),
});

// ============================================================================
// ENVIRONMENT TYPES
// ============================================================================

export type BackendEnvironment = z.infer<typeof backendEnvSchema>;
export type FrontendEnvironment = z.infer<typeof frontendEnvSchema>;

// ============================================================================
// ENVIRONMENT VALIDATION
// ============================================================================

/**
 * Validate backend environment variables
 */
export const validateBackendEnvironment = (): BackendEnvironment => {
  try {
    return backendEnvSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues.map(err => 
        `${err.path.join('.')}: ${err.message}`
      ).join('\n');
      
      throw new Error(`Environment validation failed:\n${errorMessages}`);
    }
    throw error;
  }
};

/**
 * Validate frontend environment variables
 */
export const validateFrontendEnvironment = (): FrontendEnvironment => {
  try {
    return frontendEnvSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues.map(err => 
        `${err.path.join('.')}: ${err.message}`
      ).join('\n');
      
      throw new Error(`Environment validation failed:\n${errorMessages}`);
    }
    throw error;
  }
};

// ============================================================================
// ENVIRONMENT CONFIGURATION OBJECTS
// ============================================================================

/**
 * Get validated backend environment configuration
 */
export const getBackendConfig = (): BackendEnvironment => {
  return validateBackendEnvironment();
};

/**
 * Get validated frontend environment configuration
 */
export const getFrontendConfig = (): FrontendEnvironment => {
  return validateFrontendEnvironment();
};

// ============================================================================
// ENVIRONMENT HELPERS
// ============================================================================

/**
 * Check if running in production
 */
export const isProduction = (): boolean => {
  return process.env.NODE_ENV === 'production';
};

/**
 * Check if running in development
 */
export const isDevelopment = (): boolean => {
  return process.env.NODE_ENV === 'development';
};

/**
 * Check if running in test
 */
export const isTest = (): boolean => {
  return process.env.NODE_ENV === 'test';
};

/**
 * Get environment-specific configuration
 */
export const getEnvironmentConfig = () => {
  const env = process.env.NODE_ENV || 'development';
  
  const configs = {
    development: {
      logLevel: 'debug',
      enableCors: true,
      enableCsrf: false,
      enableRateLimit: false,
    },
    production: {
      logLevel: 'info',
      enableCors: false,
      enableCsrf: true,
      enableRateLimit: true,
    },
    test: {
      logLevel: 'error',
      enableCors: true,
      enableCsrf: false,
      enableRateLimit: false,
    },
  };
  
  return configs[env as keyof typeof configs] || configs.development;
};

// ============================================================================
// ENVIRONMENT DOCUMENTATION
// ============================================================================

/**
 * Environment variable documentation
 */
export const ENVIRONMENT_DOCS = {
  backend: {
    NODE_ENV: 'Application environment (development, production, test)',
    PORT: 'Port number for the backend server',
    DATABASE_URL: 'PostgreSQL database connection string',
    SESSION_SECRET: 'Secret key for session encryption (min 32 characters)',
    OIDC_ISSUER: 'OpenID Connect issuer URL',
    OIDC_CLIENT_ID: 'OpenID Connect client ID',
    OIDC_CLIENT_SECRET: 'OpenID Connect client secret',
    OIDC_REDIRECT_URL: 'OpenID Connect redirect URL',
    ADMIN_EMAILS: 'Comma-separated list of admin email addresses',
    CORS_ORIGIN: 'CORS origin URL for frontend',
    ENABLE_CSRF: 'Enable CSRF protection (true/false)',
    EMAIL_FROM: 'Email address for sending emails',
    EMAIL_FROM_NAME: 'Display name for email sender',
    EMAIL_SMTP_HOST: 'SMTP server hostname',
    EMAIL_SMTP_PORT: 'SMTP server port',
    EMAIL_SMTP_USER: 'SMTP username',
    EMAIL_SMTP_PASS: 'SMTP password',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'Google service account email',
    GOOGLE_PRIVATE_KEY: 'Google service account private key',
    GOOGLE_CALENDAR_ID: 'Google Calendar ID',
    FRONTEND_URL: 'Frontend application URL',
  },
  frontend: {
    REACT_APP_API_URL: 'Backend API URL',
    REACT_APP_API_BASE_URL: 'Backend API base URL (optional)',
    REACT_APP_AUTH_BASE_URL: 'Backend auth base URL (optional)',
    REACT_APP_ENVIRONMENT: 'Frontend environment (development, production, test)',
    REACT_APP_ENABLE_ANALYTICS: 'Enable analytics tracking (true/false)',
    REACT_APP_ENABLE_DEBUG: 'Enable debug mode (true/false)',
  },
};

// ============================================================================
// ENVIRONMENT EXAMPLES
// ============================================================================

/**
 * Example environment files
 */
export const ENVIRONMENT_EXAMPLES = {
  backend: {
    development: `NODE_ENV=development
PORT=3001
DATABASE_URL=postgresql://user:pass@localhost:5432/adaptalabs_dev
SESSION_SECRET=your_random_session_secret_here_at_least_32_chars
OIDC_ISSUER=https://your-idp.com
OIDC_CLIENT_ID=your_client_id
OIDC_CLIENT_SECRET=your_client_secret
OIDC_REDIRECT_URL=http://localhost:3001/auth/callback
ADMIN_EMAILS=admin1@company.com,admin2@company.com
CORS_ORIGIN=http://localhost:3000
ENABLE_CSRF=false
FRONTEND_URL=http://localhost:3000`,
    
    production: `NODE_ENV=production
PORT=3001
DATABASE_URL=postgresql://user:pass@prod-db:5432/adaptalabs
SESSION_SECRET=your_production_session_secret_at_least_32_chars
OIDC_ISSUER=https://your-idp.com
OIDC_CLIENT_ID=your_client_id
OIDC_CLIENT_SECRET=your_client_secret
OIDC_REDIRECT_URL=https://api.yourdomain.com/auth/callback
ADMIN_EMAILS=admin1@company.com,admin2@company.com
CORS_ORIGIN=https://yourdomain.com
ENABLE_CSRF=true
EMAIL_FROM=noreply@yourdomain.com
EMAIL_FROM_NAME=Adaptalabs Research Platform
EMAIL_SMTP_HOST=smtp.yourdomain.com
EMAIL_SMTP_PORT=587
EMAIL_SMTP_USER=noreply@yourdomain.com
EMAIL_SMTP_PASS=your_smtp_password
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nYour private key here\\n-----END PRIVATE KEY-----"
GOOGLE_CALENDAR_ID=primary
FRONTEND_URL=https://yourdomain.com`,
  },
  
  frontend: {
    development: `REACT_APP_API_URL=http://localhost:3001
REACT_APP_ENVIRONMENT=development
REACT_APP_ENABLE_DEBUG=true`,
    
    production: `REACT_APP_API_URL=https://api.yourdomain.com
REACT_APP_ENVIRONMENT=production
REACT_APP_ENABLE_ANALYTICS=true`,
  },
};
