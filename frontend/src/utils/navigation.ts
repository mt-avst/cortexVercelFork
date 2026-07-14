/**
 * Centralized Navigation Utility
 * 
 * Provides consistent redirect handling across the application.
 * This utility centralizes all window.location.href redirects to ensure
 * consistent behavior and easier maintenance.
 */

import { getAuthUrl, getApiBaseUrl } from '../config/api';

/**
 * Auth endpoint constants
 *
 * The demo endpoints only exist on the backend under NODE_ENV=development
 * (backend/src/routes/auth.ts) - never redirect to them in production.
 */
export const AUTH_ENDPOINTS = {
  DEMO_LOGIN: '/api/auth/demo-login',
  ADMIN_LOGIN: '/api/auth/admin-login',
  SUPERADMIN_LOGIN: '/api/auth/superadmin-login',
  // App-level Okta OIDC (backend /auth/login, also mounted at /api/auth/login).
  // This is the only login path that works in production on Kubera.
  OIDC_LOGIN: '/api/auth/login',
  LOGOUT: '/api/auth/logout',
} as const;

/**
 * Check if currently on an admin route (/admin and its subpaths).
 * Participant pages such as /opportunities and /sessions are NOT admin routes.
 * Only used to pick between the dev demo logins - production ignores it.
 */
export const isAdminRoute = (): boolean => {
  const { pathname } = window.location;
  return pathname === '/admin' || pathname.startsWith('/admin/');
};

/**
 * Check if running in production environment
 */
export const isProductionEnvironment = (): boolean => {
  return typeof window !== 'undefined' &&
         !window.location.hostname.includes('localhost') &&
         !window.location.hostname.includes('127.0.0.1');
};

/**
 * Simple redirect to a path
 * @param path - The path or URL to redirect to
 */
export const redirectTo = (path: string): void => {
  window.location.href = path;
};

/**
 * Redirect to an auth endpoint
 * @param endpoint - The auth endpoint path
 */
export const redirectToAuth = (endpoint: string): void => {
  sessionStorage.setItem('loginRedirect', 'true');
  window.location.href = getAuthUrl(endpoint);
};

/**
 * Authentication navigation helpers
 */
export const authNavigation = {
  /**
   * Redirect to demo login
   */
  toDemoLogin: (): void => {
    redirectToAuth(AUTH_ENDPOINTS.DEMO_LOGIN);
  },

  /**
   * Redirect to admin login
   */
  toAdminLogin: (): void => {
    redirectToAuth(AUTH_ENDPOINTS.ADMIN_LOGIN);
  },

  /**
   * Redirect to superadmin login
   */
  toSuperadminLogin: (): void => {
    redirectToAuth(AUTH_ENDPOINTS.SUPERADMIN_LOGIN);
  },

  /**
   * Redirect to app-level Okta OIDC login (production login path)
   */
  toOidcLogin: (): void => {
    redirectToAuth(AUTH_ENDPOINTS.OIDC_LOGIN);
  },

  /**
   * Handle login redirect based on context
   *
   * In production every role logs in through Okta OIDC - the demo endpoints
   * do not exist there and Google OAuth is blocked and deprecated. The demo
   * split (admin vs user) only applies to local development.
   *
   * @param isAdmin - Whether current route is admin route
   * @param isProduction - Whether running in production
   */
  toLogin: (isAdmin: boolean, isProduction: boolean): void => {
    let loginRoute: string;
    if (isProduction) {
      loginRoute = AUTH_ENDPOINTS.OIDC_LOGIN;
    } else if (isAdmin) {
      loginRoute = AUTH_ENDPOINTS.ADMIN_LOGIN;
    } else {
      loginRoute = AUTH_ENDPOINTS.DEMO_LOGIN;
    }
    redirectToAuth(loginRoute);
  },

  /**
   * Generic login redirect (auto-detects context)
   * Used by error handler when 401 is received
   */
  toGenericLogin: (): void => {
    const isAdmin = isAdminRoute();
    const isProduction = isProductionEnvironment();
    authNavigation.toLogin(isAdmin, isProduction);
  },
};

/**
 * General navigation helpers
 */
export const navigation = {
  /**
   * Redirect to the admin dashboard
   */
  toAdmin: (): void => {
    window.location.href = '/admin';
  },

  /**
   * Redirect to the home page
   */
  toHome: (): void => {
    window.location.href = '/';
  },

  /**
   * Redirect to the login page (landing)
   */
  toLogin: (): void => {
    window.location.href = '/';
  },

  /**
   * Redirect to feedback export download
   */
  toFeedbackExport: (): void => {
    window.location.href = `${getApiBaseUrl()}/api/feedback/export`;
  },

  /**
   * Navigate to a specific path
   * @param path - The path to navigate to
   */
  to: (path: string): void => {
    window.location.href = path;
  },

  /**
   * Get the current path
   */
  getCurrentPath: (): string => {
    return window.location.pathname;
  },
};

export default navigation;
