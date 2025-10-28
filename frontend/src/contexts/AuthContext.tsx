import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

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

  const fetchUser = async (isInitialCheck = false) => {
    try {
      setLoading(true);
      setError(null);
      logger.log('AuthProvider: Fetching user data...', { isInitialCheck });
      
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

  // Automatically check authentication status on app load
  useEffect(() => {
    const checkAuthStatus = async () => {
      logger.log('AuthProvider: Checking authentication status on mount');
      
      // Check if we're returning from a login redirect
      // The referrer will be from the backend server after login
      let backendHost = '';
      if (API_CONFIG.BASE_URL) {
        try {
          backendHost = new URL(API_CONFIG.BASE_URL).hostname;
        } catch (e) {
          // URL is relative or invalid, use current hostname
          backendHost = window.location.hostname;
        }
      } else {
        // No BASE_URL means we're using relative paths (production)
        backendHost = window.location.hostname;
      }
      
      const isReturningFromLogin = 
        document.referrer.includes('/auth/') || 
        window.location.search.includes('auth') ||
        sessionStorage.getItem('loginRedirect') === 'true';
      
      logger.log('AuthProvider: Login redirect detection:', {
        referrer: document.referrer,
        search: window.location.search,
        sessionStorage: sessionStorage.getItem('loginRedirect'),
        isReturningFromLogin
      });
      
      if (isReturningFromLogin) {
        logger.log('AuthProvider: Detected return from login redirect');
        // Clear the login redirect flag
        sessionStorage.removeItem('loginRedirect');
        
        // If returning from login, wait a bit for session cookie to be set
        // and retry authentication check
        setTimeout(async () => {
          logger.log('AuthProvider: Retrying auth check after login redirect');
          await fetchUser(false);
        }, 1000); // Increased delay to 1 second
      } else {
        // If not returning from login, just log that we're doing a normal auth check
        logger.log('AuthProvider: Not returning from login, doing normal auth check');
      }
      
      // Always check authentication status on mount
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
