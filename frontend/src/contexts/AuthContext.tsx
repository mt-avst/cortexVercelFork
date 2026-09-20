import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';

import { getMe, logout } from '../api/client';
import { getApiBaseUrl } from '../config/api';
import { logger } from '../utils/logger';
import { authNavigation, isAdminRoute, isProductionEnvironment, navigation } from '../utils/navigation';

import { User } from '../api/types';

/**
 * Authentication context interface
 * 
 * Provides authentication state and methods for managing user sessions,
 * including login, logout, and user data fetching with proper error handling.
 */
interface AuthContextType {
  user: User | null;
  loading: boolean;
  error: string | null;
  initialAuthCheck: boolean;
  login: () => void;
  logout: () => Promise<void>;
  fetchUser: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  clearSessionCookies: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Authentication Provider Component
 * 
 * Manages authentication state for the entire application, including:
 * - User session management
 * - Automatic authentication checking on app load
 * - Login/logout functionality
 * - Error handling for authentication failures
 * - Demo login functionality for development
 * 
 * @param children - React children components
 * @returns JSX element providing authentication context
 */
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(false); // Start with loading false - will be set to true during auth check
  const [error, setError] = useState<string | null>(null);
  const [initialAuthCheck, setInitialAuthCheck] = useState(false); // Track if initial auth check is complete
  const hasCheckedAuth = useRef(false); // Prevent React StrictMode double-execution

  const fetchUser = async (isInitialCheck = false) => {
    try {
      setLoading(true);
      setError(null);
      logger.log('AuthProvider: Fetching user data...', { isInitialCheck });
      
      // Set flag to prevent automatic redirects during initial auth check
      if (isInitialCheck && window.__setInitialAuthCheck) {
        window.__setInitialAuthCheck(true);
      }
      
      logger.log('AuthProvider: Making API call to:', `${getApiBaseUrl()}/api/me`);

      const userData = await getMe();
      // #102: log only that a user resolved, never the user object itself (PII)
      // or document.cookie - a dev log is still a log, and an error-reporting
      // SDK would capture these.
      logger.log('AuthProvider: User data received', { hasUser: Boolean(userData) });
      setUser(userData);
    } catch (error: unknown) {
      // #102: do not log the raw error object - an AxiosError carries
      // config.data (the request body) and config.headers (the CSRF token),
      // which an error-reporting SDK would capture. The structured
      // logger.error below records name/message/stack safely instead.
      // Don't set error for 401 - that's expected when not logged in
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as { response?: { status?: number } };
        logger.log('AuthProvider: Axios error status:', axiosError.response?.status);
        if (axiosError.response?.status !== 401) {
          logger.error('AuthProvider: Auth error', {
            error: error instanceof Error ? error : undefined,
            errorDetails: error instanceof Error ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            } : { message: String(error) },
            requestId: logger.getRequestId() || undefined,
          });
          setError('Failed to fetch user data');
        }
      } else {
        logger.error('AuthProvider: Auth error', {
          error: error instanceof Error ? error : undefined,
          errorDetails: error instanceof Error ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          } : { message: String(error) },
          requestId: logger.getRequestId() || undefined,
        });
        setError('Failed to fetch user data');
      }
      logger.log('AuthProvider: Setting user to null');
      setUser(null);
    } finally {
      logger.log('AuthProvider: Setting loading to false');
      setLoading(false);
      
      // Clear the initial auth check flag after auth check completes
      if (isInitialCheck && window.__setInitialAuthCheck) {
        setTimeout(() => {
          window.__setInitialAuthCheck?.(false);
        }, 100);
      }
      
      if (isInitialCheck) {
        logger.log('AuthProvider: Initial auth check complete');
        setInitialAuthCheck(true);
      }
    }
  };

  const login = () => {
    // Determine appropriate login route based on current context
    const isAdmin = isAdminRoute();
    const isProduction = isProductionEnvironment();
    
    logger.info('Redirecting to login', { isProduction, isAdminRoute: isAdmin });
    authNavigation.toLogin(isAdmin, isProduction);
  };

  const handleLogout = async () => {
    try {
      await logout();
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error('Logout failed', {
        error,
        errorDetails: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
        requestId: logger.getRequestId() || undefined,
      });
    } finally {
      // Clear local state and redirect home even if the API call failed -
      // the user asked to log out, so the UI should reflect that regardless.
      setUser(null);
      setError(null);
      navigation.toHome();
    }
  };

  const refreshAuth = async () => {
    logger.log('AuthProvider: Manual auth refresh requested');
    await fetchUser(false);
  };

  const clearSessionCookies = () => {
    // Clear the specific session cookie
    // Try to clear without domain (works for all environments)
    document.cookie = 'adaptalabs_session=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/';
    logger.log('AuthProvider: Cleared session cookies');
  };

  // Validate the session on every mount - a fresh load, a full-page refresh,
  // a bookmark, or a URL typed directly into the address bar - not just when
  // returning from login. The session cookie is httpOnly and validated
  // server-side, so /api/me is the source of truth; there's no "stale
  // cookie" risk in asking, only a risk in assuming logged-out without
  // asking (that assumption was the bug: it showed the logged-out landing
  // page for a still-valid session on every direct navigation).
  //
  // The loginRedirect flag is set by redirectToAuth() immediately before
  // sending the browser to Okta, and read back here on the return trip. It
  // doesn't gate whether the check happens - it only triggers one extra
  // retry, to cover the narrow race where this effect runs before the
  // session cookie the backend just set has fully landed.
  useEffect(() => {
    const checkAuthStatus = async () => {
      // Prevent double execution in React StrictMode
      if (hasCheckedAuth.current) {
        logger.log('AuthProvider: Skipping duplicate mount (React StrictMode)');
        return;
      }
      hasCheckedAuth.current = true;

      logger.log('AuthProvider: Checking authentication status on mount');

      const loginRedirectFlag = sessionStorage.getItem('loginRedirect');
      const isReturningFromLogin = loginRedirectFlag === 'true';

      // Clear the flag immediately, even if true, to prevent reuse
      sessionStorage.removeItem('loginRedirect');

      logger.log('AuthProvider: Login redirect detection:', {
        referrer: document.referrer,
        search: window.location.search,
        hadLoginRedirectFlag: !!loginRedirectFlag,
        isReturningFromLogin
      });

      if (isReturningFromLogin) {
        // Returning from login - check auth immediately.
        // Cookies are set synchronously by the browser, so no delay needed
        // for the common case; retry once if that first check fails, in
        // case the cookie genuinely wasn't ready yet.
        logger.log('AuthProvider: Detected return from login redirect - checking auth immediately');
        setInitialAuthCheck(false);
        fetchUser(true).catch((err) => {
          logger.log('AuthProvider: First auth check failed, retrying after brief delay', err);
          setTimeout(async () => {
            logger.log('AuthProvider: Retrying auth check after login redirect');
            await fetchUser(true);
          }, 200);
        });
        return;
      }

      // Any other mount - always ask the backend whether a session is
      // already valid rather than defaulting to logged-out.
      logger.log('AuthProvider: Not returning from login - checking session anyway');
      await fetchUser(true);
    };

    checkAuthStatus();
  }, []); // Empty dependency array - only run on mount

  const value: AuthContextType = {
    user,
    loading,
    error,
    initialAuthCheck,
    login,
    logout: handleLogout,
    fetchUser,
    refreshAuth,
    clearSessionCookies,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
