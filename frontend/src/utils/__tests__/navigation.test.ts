import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTH_ENDPOINTS,
  authNavigation,
  isAdminRoute,
  isProductionEnvironment,
} from '../navigation';

// Identity-map the URL helpers so assertions read as plain endpoint paths
vi.mock('../../config/api', () => ({
  getAuthUrl: (path: string) => path,
  getApiBaseUrl: () => '',
}));

const PRODUCTION_HOST = 'adaptalabs.kubera-playground.adaptavist.net';

const setLocation = (hostname: string, pathname: string): void => {
  Object.defineProperty(window, 'location', {
    value: { hostname, pathname, href: '' },
    writable: true,
    configurable: true,
  });
};

beforeEach(() => {
  sessionStorage.clear();
  setLocation('localhost', '/');
});

describe('isAdminRoute', () => {
  it('returns true for the admin dashboard and its subpaths', () => {
    setLocation(PRODUCTION_HOST, '/admin');
    expect(isAdminRoute()).toBe(true);

    setLocation(PRODUCTION_HOST, '/admin/opportunities');
    expect(isAdminRoute()).toBe(true);
  });

  it('returns false for participant opportunity pages', () => {
    setLocation(PRODUCTION_HOST, '/opportunities/abc-123');
    expect(isAdminRoute()).toBe(false);
  });

  it('returns false for participant session pages', () => {
    setLocation(PRODUCTION_HOST, '/sessions/abc-123');
    expect(isAdminRoute()).toBe(false);
  });

  it('returns false for the landing page and unrelated paths', () => {
    setLocation(PRODUCTION_HOST, '/');
    expect(isAdminRoute()).toBe(false);

    setLocation(PRODUCTION_HOST, '/administration-guide');
    expect(isAdminRoute()).toBe(false);
  });
});

describe('isProductionEnvironment', () => {
  it('returns true on the Kubera playground hostname', () => {
    setLocation(PRODUCTION_HOST, '/');
    expect(isProductionEnvironment()).toBe(true);
  });

  it('returns false on localhost and 127.0.0.1', () => {
    setLocation('localhost', '/');
    expect(isProductionEnvironment()).toBe(false);

    setLocation('127.0.0.1', '/');
    expect(isProductionEnvironment()).toBe(false);
  });
});

describe('authNavigation.toLogin', () => {
  it('sends admin routes to OIDC login in production', () => {
    authNavigation.toLogin(true, true);
    expect(window.location.href).toBe(AUTH_ENDPOINTS.OIDC_LOGIN);
  });

  it('sends non-admin routes to OIDC login in production', () => {
    authNavigation.toLogin(false, true);
    expect(window.location.href).toBe(AUTH_ENDPOINTS.OIDC_LOGIN);
  });

  it('sends admin routes to the demo admin login in development', () => {
    authNavigation.toLogin(true, false);
    expect(window.location.href).toBe(AUTH_ENDPOINTS.ADMIN_LOGIN);
  });

  it('sends non-admin routes to the demo login in development', () => {
    authNavigation.toLogin(false, false);
    expect(window.location.href).toBe(AUTH_ENDPOINTS.DEMO_LOGIN);
  });

  it('sets the loginRedirect flag so AuthContext validates the session on return', () => {
    authNavigation.toLogin(false, true);
    expect(sessionStorage.getItem('loginRedirect')).toBe('true');
  });
});

describe('authNavigation.toGenericLogin', () => {
  it('sends a 401 on a production participant page to OIDC login (the observed bug)', () => {
    setLocation(PRODUCTION_HOST, '/opportunities/abc-123');
    authNavigation.toGenericLogin();
    expect(window.location.href).toBe(AUTH_ENDPOINTS.OIDC_LOGIN);
  });

  it('sends a 401 on a production admin page to OIDC login', () => {
    setLocation(PRODUCTION_HOST, '/admin/opportunities');
    authNavigation.toGenericLogin();
    expect(window.location.href).toBe(AUTH_ENDPOINTS.OIDC_LOGIN);
  });

  it('sends a 401 on a local admin page to the demo admin login', () => {
    setLocation('localhost', '/admin');
    authNavigation.toGenericLogin();
    expect(window.location.href).toBe(AUTH_ENDPOINTS.ADMIN_LOGIN);
  });

  it('sends a 401 on a local participant page to the demo login', () => {
    setLocation('localhost', '/opportunities/abc-123');
    authNavigation.toGenericLogin();
    expect(window.location.href).toBe(AUTH_ENDPOINTS.DEMO_LOGIN);
  });
});
