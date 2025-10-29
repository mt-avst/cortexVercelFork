import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';

import { getMe, logout } from '../api/client';
import { getAuthUrl, API_CONFIG } from '../config/api';
import { logger } from '../utils/logger';

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
      if (isInitialCheck && (window as any).__setInitialAuthCheck) {
        (window as any).__setInitialAuthCheck(true);
      }
      
      // Debug: Check cookies before making request
      logger.log('AuthProvider: Current cookies:', document.cookie);
      logger.log('AuthProvider: Making API call to:', `${API_CONFIG.BASE_URL}/api/me`);
      
      const userData = await getMe();
      logger.log('AuthProvider: User data received:', userData);
      setUser(userData);
    } catch (err) {
      logger.log('AuthProvider: Auth error caught:', err);
      // Don't set error for 401 - that's expected when not logged in
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosError = err as { response?: { status?: number } };
        logger.log('AuthProvider: Axios error status:', axiosError.response?.status);
        if (axiosError.response?.status !== 401) {
          logger.error('AuthProvider: Auth error:', err);
          setError('Failed to fetch user data');
        }
      } else {
        logger.error('AuthProvider: Auth error:', err);
        setError('Failed to fetch user data');
      }
      logger.log('AuthProvider: Setting user to null');
      setUser(null);
    } finally {
      logger.log('AuthProvider: Setting loading to false');
      setLoading(false);
      
      // Clear the initial auth check flag after auth check completes
      if (isInitialCheck && (window as any).__setInitialAuthCheck) {
        setTimeout(() => {
          (window as any).__setInitialAuthCheck(false);
        }, 100);
      }
      
      if (isInitialCheck) {
        logger.log('AuthProvider: Initial auth check complete');
        setInitialAuthCheck(true);
      }
    }
  };

  const login = () => {
    // Set a flag to detect when we return from login
    sessionStorage.setItem('loginRedirect', 'true');
    
    // Determine appropriate login route based on current context
    const isAdminRoute = window.location.pathname.includes('/admin') || 
                        window.location.pathname.includes('/opportunities') ||
                        window.location.pathname.includes('/sessions');
    
    const loginRoute = isAdminRoute ? '/auth/admin-login' : '/auth/demo-login';
    
    console.log('🔐 Redirecting to login:', loginRoute);
    window.location.href = getAuthUrl(loginRoute);
  };

  const handleLogout = async () => {
    try {
      await logout();
      setUser(null);
      setError(null);
      
      // Redirect to homepage after logout
      window.location.href = '/';
    } catch (err) {
      logger.error('Logout failed:', err);
      // Still redirect even if logout fails
      window.location.href = '/';
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

  // CRITICAL FIX: NEVER automatically check authentication on initial app load.
  // This prevents automatic login from stale cookies.
  // Authentication will ONLY be checked when:
  // 1. User explicitly clicks a login button AND we're returning from that redirect
  //    (detected by sessionStorage flag that was set RIGHT BEFORE redirect)
  // 2. Never check based on referrer - it's unreliable and can trigger false positives
  
  useEffect(() => {
    const checkAuthStatus = async () => {
      // Prevent double execution in React StrictMode
      if (hasCheckedAuth.current) {
        logger.log('AuthProvider: Skipping duplicate mount (React StrictMode)');
        return;
      }
      hasCheckedAuth.current = true;
      
      logger.log('AuthProvider: Checking authentication status on mount');
      
      // CRITICAL: Only check auth if we have a FRESH sessionStorage flag
      // Clear any stale flags from previous sessions first
      const loginRedirectFlag = sessionStorage.getItem('loginRedirect');
      const isReturningFromLogin = loginRedirectFlag === 'true';
      
      // IMPORTANT: Clear the flag immediately, even if true, to prevent reuse
      sessionStorage.removeItem('loginRedirect');
      
      logger.log('AuthProvider: Login redirect detection:', {
        referrer: document.referrer,
        search: window.location.search,
        hadLoginRedirectFlag: !!loginRedirectFlag,
        isReturningFromLogin
      });
      
      if (isReturningFromLogin) {
        // We were returning from login - check auth immediately
        // Cookies are set synchronously by the browser, so no delay needed
        logger.log('AuthProvider: Detected return from login redirect - checking auth immediately');
        // Set initialAuthCheck to false initially so Admin page waits
        setInitialAuthCheck(false);
        // Check auth immediately - cookies should already be set by the redirect
        fetchUser(true).catch((err) => {
          // If first attempt fails, retry once after short delay (in case cookie wasn't ready)
          logger.log('AuthProvider: First auth check failed, retrying after brief delay', err);
          setTimeout(async () => {
            logger.log('AuthProvider: Retrying auth check after login redirect');
            await fetchUser(true);
          }, 200);
        });
        return;
      }
      
      // NOT returning from login - ABSOLUTELY DO NOT check auth
      logger.log('AuthProvider: NOT returning from login - starting completely fresh, NO auth check');
      
      // Aggressively clear all cookies (client-side)
      clearSessionCookies();
      
      // Clear HttpOnly cookies via logout API calls (silent)
      const logoutUrls = [
        API_CONFIG.BASE_URL ? `${API_CONFIG.BASE_URL}/api/auth/logout` : '/api/auth/logout',
        API_CONFIG.BASE_URL ? `${API_CONFIG.BASE_URL}/auth/logout` : '/auth/logout'
      ];
      
      Promise.allSettled(
        logoutUrls.map(url => 
          fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
          })
        )
      ).catch(() => {}); // Ignore all errors
      
      // Set state: logged out, initial check complete, NO auth performed
      setInitialAuthCheck(true);
      setUser(null);
      setLoading(false);
      
      logger.log('AuthProvider: Initial load complete - user is logged out, ZERO auth checks performed');
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
