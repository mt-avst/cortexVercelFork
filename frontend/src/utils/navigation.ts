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
 */
export const AUTH_ENDPOINTS = {
  DEMO_LOGIN: '/api/auth/demo-login',
  DEMO_USER_2_LOGIN: '/api/auth/demo-user-2-login',
  ADMIN_LOGIN: '/api/auth/admin-login',
  SUPERADMIN_LOGIN: '/api/auth/superadmin-login',
  GOOGLE_LOGIN: '/api/auth/google-login',
  LOGOUT: '/api/auth/logout',
} as const;

/**
 * Check if currently on admin route
 */
export const isAdminRoute = (): boolean => {
  return window.location.pathname.includes('/admin') ||
         window.location.pathname.includes('/opportunities') ||
         window.location.pathname.includes('/sessions');
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
   * Redirect to demo user 2 login
   */
  toDemoUser2Login: (): void => {
    redirectToAuth(AUTH_ENDPOINTS.DEMO_USER_2_LOGIN);
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
   * Redirect to Google OAuth login
   */
  toGoogleLogin: (): void => {
    redirectToAuth(AUTH_ENDPOINTS.GOOGLE_LOGIN);
  },

  /**
   * Handle login redirect based on context
   * @param isAdmin - Whether current route is admin route
   * @param isProduction - Whether running in production
   */
  toLogin: (isAdmin: boolean, isProduction: boolean): void => {
    let loginRoute: string;
    if (isAdmin) {
      loginRoute = AUTH_ENDPOINTS.ADMIN_LOGIN;
    } else if (isProduction) {
      loginRoute = AUTH_ENDPOINTS.GOOGLE_LOGIN;
    } else {
      loginRoute = AUTH_ENDPOINTS.DEMO_LOGIN;
    }
    window.location.href = getAuthUrl(loginRoute);
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
