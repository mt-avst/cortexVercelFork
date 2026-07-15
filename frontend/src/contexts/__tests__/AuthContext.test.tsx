import { vi } from 'vitest';
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '../AuthContext';
import { generateMockUser } from '../../shared/test-utils';
import { getMe, logout } from '../../api/client';

// Mock the API client
vi.mock('../../api/client', () => ({
  getMe: vi.fn(),
  logout: vi.fn(),
}));

// Mock the config
vi.mock('../../config/api', () => ({
  getApiBaseUrl: vi.fn(() => ''),
}));

// Mock the logger
vi.mock('../../utils/logger', () => ({
  logger: {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    getRequestId: vi.fn(() => undefined),
    setRequestId: vi.fn(),
  },
}));

// Mock navigation - its own behaviour is covered by utils/__tests__/navigation.test.ts.
// Here we only need to assert AuthContext calls into it correctly.
vi.mock('../../utils/navigation', () => ({
  authNavigation: {
    toLogin: vi.fn(),
  },
  navigation: {
    toHome: vi.fn(),
  },
  isAdminRoute: vi.fn(() => false),
  isProductionEnvironment: vi.fn(() => false),
}));

import { authNavigation, navigation } from '../../utils/navigation';

// Mock sessionStorage
const mockSessionStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};

Object.defineProperty(window, 'sessionStorage', {
  value: mockSessionStorage,
  writable: true,
});

// Mock document.cookie
Object.defineProperty(document, 'cookie', {
  value: '',
  writable: true,
});

// Test component that uses the auth context
const TestComponent = () => {
  const { user, loading, error, initialAuthCheck } = useAuth();

  return (
    <div>
      <div data-testid="loading">{loading ? 'Loading' : 'Not Loading'}</div>
      <div data-testid="error">{error || 'No Error'}</div>
      <div data-testid="initial-auth-check">{initialAuthCheck ? 'Complete' : 'Pending'}</div>
      <div data-testid="user">{user ? user.name : 'No User'}</div>
    </div>
  );
};

describe('AuthContext', () => {
  const mockGetMe = vi.mocked(getMe);
  const mockLogout = vi.mocked(logout);

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionStorage.getItem.mockReturnValue(null);
    document.cookie = '';
  });

  describe('session check on mount', () => {
    // Reproduces the bug: after a successful login, navigating directly to
    // an authenticated URL (typed into the address bar, a bookmark, a full
    // page refresh, or any load that isn't a click on an in-app link) has no
    // loginRedirect flag in sessionStorage. The provider must still ask the
    // backend whether the session cookie is valid instead of assuming
    // logged-out.
    it('checks the session and renders authenticated on a normal mount with no loginRedirect flag', async () => {
      mockSessionStorage.getItem.mockReturnValue(null);
      const mockUser = generateMockUser();
      mockGetMe.mockResolvedValue(mockUser);

      render(
        <AuthProvider>
          <TestComponent />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(mockGetMe).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(screen.getByTestId('user')).toHaveTextContent(mockUser.name);
      });
      expect(screen.getByTestId('initial-auth-check')).toHaveTextContent('Complete');
    });

    it('checks the session and renders authenticated when the loginRedirect flag is present', async () => {
      mockSessionStorage.getItem.mockReturnValue('true');
      const mockUser = generateMockUser();
      mockGetMe.mockResolvedValue(mockUser);

      render(
        <AuthProvider>
          <TestComponent />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(mockGetMe).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(screen.getByTestId('user')).toHaveTextContent(mockUser.name);
      });
    });

    it('clears the loginRedirect flag after reading it so it cannot be reused', async () => {
      mockSessionStorage.getItem.mockReturnValue('true');
      mockGetMe.mockResolvedValue(generateMockUser());

      render(
        <AuthProvider>
          <TestComponent />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(mockSessionStorage.removeItem).toHaveBeenCalledWith('loginRedirect');
      });
    });

    it('renders a clean logged-out state (no error) when there is no valid session', async () => {
      mockSessionStorage.getItem.mockReturnValue(null);
      const axiosError = { response: { status: 401 }, message: 'Unauthorized' };
      mockGetMe.mockRejectedValue(axiosError);

      render(
        <AuthProvider>
          <TestComponent />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('initial-auth-check')).toHaveTextContent('Complete');
      });
      expect(screen.getByTestId('user')).toHaveTextContent('No User');
      expect(screen.getByTestId('error')).toHaveTextContent('No Error');
    });

    it('surfaces an error for a non-401 failure', async () => {
      mockSessionStorage.getItem.mockReturnValue(null);
      const axiosError = { response: { status: 500 }, message: 'Internal Server Error' };
      mockGetMe.mockRejectedValue(axiosError);

      render(
        <AuthProvider>
          <TestComponent />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('error')).toHaveTextContent('Failed to fetch user data');
      });
      expect(screen.getByTestId('user')).toHaveTextContent('No User');
    });

    it('only checks the session once, even under React StrictMode double-invocation', async () => {
      mockGetMe.mockResolvedValue(generateMockUser());

      render(
        <React.StrictMode>
          <AuthProvider>
            <TestComponent />
          </AuthProvider>
        </React.StrictMode>
      );

      await waitFor(() => {
        expect(screen.getByTestId('initial-auth-check')).toHaveTextContent('Complete');
      });
      expect(mockGetMe).toHaveBeenCalledTimes(1);
    });
  });

  describe('useAuth hook', () => {
    it('throws when used outside an AuthProvider', () => {
      const originalError = console.error;
      console.error = vi.fn();

      expect(() => {
        render(<TestComponent />);
      }).toThrow('useAuth must be used within an AuthProvider');

      console.error = originalError;
    });

    it('login() sets the loginRedirect flag and delegates to authNavigation.toLogin', async () => {
      mockGetMe.mockRejectedValue({ response: { status: 401 } });

      const TestLoginComponent = () => {
        const { login } = useAuth();
        return <button onClick={login}>Login</button>;
      };

      render(
        <AuthProvider>
          <TestLoginComponent />
        </AuthProvider>
      );

      await waitFor(() => expect(mockGetMe).toHaveBeenCalled());

      act(() => {
        screen.getByText('Login').click();
      });

      expect(authNavigation.toLogin).toHaveBeenCalledWith(false, false);
    });

    it('logout() calls the API, clears user state, and navigates home', async () => {
      const mockUser = generateMockUser();
      mockGetMe.mockResolvedValue(mockUser);
      mockLogout.mockResolvedValue(undefined);

      const TestLogoutComponent = () => {
        const { logout, user } = useAuth();
        return (
          <div>
            <div data-testid="user">{user ? user.name : 'No User'}</div>
            <button onClick={logout}>Logout</button>
          </div>
        );
      };

      render(
        <AuthProvider>
          <TestLogoutComponent />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('user')).toHaveTextContent(mockUser.name);
      });

      await act(async () => {
        screen.getByText('Logout').click();
      });

      expect(mockLogout).toHaveBeenCalled();
      expect(navigation.toHome).toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.getByTestId('user')).toHaveTextContent('No User');
      });
    });

    it('logout() still clears user state and navigates home if the API call fails', async () => {
      const mockUser = generateMockUser();
      mockGetMe.mockResolvedValue(mockUser);
      mockLogout.mockRejectedValue(new Error('Logout failed'));

      const TestLogoutComponent = () => {
        const { logout, user } = useAuth();
        return (
          <div>
            <div data-testid="user">{user ? user.name : 'No User'}</div>
            <button onClick={logout}>Logout</button>
          </div>
        );
      };

      render(
        <AuthProvider>
          <TestLogoutComponent />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('user')).toHaveTextContent(mockUser.name);
      });

      await act(async () => {
        screen.getByText('Logout').click();
      });

      expect(mockLogout).toHaveBeenCalled();
      expect(navigation.toHome).toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.getByTestId('user')).toHaveTextContent('No User');
      });
    });

    it('refreshAuth() re-fetches the user on demand', async () => {
      mockGetMe.mockResolvedValue(generateMockUser());

      const TestRefreshComponent = () => {
        const { refreshAuth } = useAuth();
        return <button onClick={refreshAuth}>Refresh</button>;
      };

      render(
        <AuthProvider>
          <TestRefreshComponent />
        </AuthProvider>
      );

      await waitFor(() => expect(mockGetMe).toHaveBeenCalledTimes(1));

      await act(async () => {
        screen.getByText('Refresh').click();
      });

      expect(mockGetMe).toHaveBeenCalledTimes(2);
    });

    it('clearSessionCookies() expires the session cookie', async () => {
      mockGetMe.mockResolvedValue(generateMockUser());

      const TestClearComponent = () => {
        const { clearSessionCookies } = useAuth();
        return <button onClick={clearSessionCookies}>Clear Cookies</button>;
      };

      render(
        <AuthProvider>
          <TestClearComponent />
        </AuthProvider>
      );

      await waitFor(() => expect(mockGetMe).toHaveBeenCalled());

      act(() => {
        screen.getByText('Clear Cookies').click();
      });

      expect(document.cookie).toContain('adaptalabs_session=; expires=Thu, 01 Jan 1970 00:00:00 UTC');
    });
  });
});
