// Simple test to verify the frontend test setup works
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import App from './App';

/*
 * The whole router is rendered, so every page would be imported for real. Only
 * the pieces the catch-all actually needs are stubbed: `Home`, because that is
 * where an unmatched path lands and it must be identifiable, and the two
 * context modules, because `AuthProvider` fetches on mount. Every `<Route>`
 * declaration, including `path="*"`, comes from the real `App.tsx`.
 */
vi.mock('./pages/Home', () => ({
  default: () => <div>Home page</div>,
}));

vi.mock('./contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ user: null, loading: false, initialAuthCheck: false, logout: vi.fn() }),
}));

vi.mock('./contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ isDarkMode: false, theme: 'light', toggleTheme: vi.fn() }),
  useAnimation: () => ({ prefersReducedMotion: false }),
}));

describe('Frontend Test Setup', () => {
  it('should run basic tests', () => {
    expect(1 + 1).toBe(2);
  });

  it('should have testing utilities available', () => {
    expect(typeof expect).toBe('function');
    expect(typeof describe).toBe('function');
    expect(typeof it).toBe('function');
  });

  it('should be able to import React', () => {
    const React = require('react');
    expect(typeof React).toBe('object');
  });
});

/**
 * The catch-all, `<Route path="*">` in App.tsx.
 *
 * #46 deleted the `/submit-research-request` route rather than repointing it,
 * and justified that with "the catch-all sends a stale link somewhere
 * sensible". That justification was enforced by nothing: deleting the
 * catch-all route left the entire 1501-test suite green, so the guarantee this
 * MR now depends on could be removed without a single named failure.
 *
 * Asserted through the real `<App />` rather than a hand-built `<MemoryRouter>`
 * holding a copy of the routes, because a copy cannot see the real declaration
 * being deleted - which is the exact mutation that has to fail here.
 */
describe('a path with no route', () => {
  /** Arrive at `path`, returning the history depth on arrival, before any redirect. */
  const go = (path: string) => {
    window.history.pushState({}, '', path);
    const depthAtDeadPath = window.history.length;
    render(<App />);
    return depthAtDeadPath;
  };

  it.each([
    // The path this MR retires. Anyone still holding the link, or a bookmark
    // from when it served the Under Development placeholder, lands home.
    '/submit-research-request',
    '/no-such-page',
  ])('sends %s to the home page, without a way back to it', async (path) => {
    const depthAtDeadPath = go(path);

    expect(await screen.findByText('Home page')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
    /*
     * `replace`, not push - and this is the assertion that can see the
     * difference. `pathname` is '/' either way, so it cannot.
     *
     * A push leaves the dead path in the stack behind them, so Back returns to
     * it, which redirects forward again: the back button stops working. A
     * replace consumes the entry instead, leaving the depth where it was on
     * arrival. Relative, because jsdom's history is cumulative across a file
     * and the absolute number depends on test order.
     */
    expect(window.history.length).toBe(depthAtDeadPath);
  });
});
