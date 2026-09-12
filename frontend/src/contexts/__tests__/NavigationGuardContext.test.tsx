import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';

import {
  GuardedLink,
  NavigationGuardProvider,
  useNavigationGuard,
  type NavGuard,
} from '../NavigationGuardContext';

/**
 * WZ-13: the shared navigation guard the Header's links consult.
 *
 * Two things are pinned here: the registry itself (does runGuard reflect what
 * was registered, and does clearing it work), and GuardedLink's contract (does
 * an intercepting guard actually stop the navigation, and does a non-
 * intercepting one let it through).
 */

/** Reads the registry imperatively so a test can drive it like a caller would. */
const RegistryProbe: React.FC<{ onReady: (api: ReturnType<typeof useNavigationGuard>) => void }> = ({
  onReady,
}) => {
  const api = useNavigationGuard();
  onReady(api);
  return null;
};

const LocationProbe: React.FC = () => (
  <span data-testid="location">{useLocation().pathname}</span>
);

describe('the navigation guard registry', () => {
  it('returns false when no guard is registered', () => {
    let api!: ReturnType<typeof useNavigationGuard>;
    render(
      <NavigationGuardProvider>
        <RegistryProbe onReady={(a) => (api = a)} />
      </NavigationGuardProvider>
    );

    expect(api.runGuard('/anywhere')).toBe(false);
  });

  it("returns the registered guard's boolean, and clears on registerGuard(null)", () => {
    let api!: ReturnType<typeof useNavigationGuard>;
    render(
      <NavigationGuardProvider>
        <RegistryProbe onReady={(a) => (api = a)} />
      </NavigationGuardProvider>
    );

    // A guard that intercepts only one specific destination proves the boolean
    // is the guard's own answer, not a fixed value.
    const guard: NavGuard = (destination) => destination === '/blocked';
    api.registerGuard(guard);
    expect(api.runGuard('/blocked')).toBe(true);
    expect(api.runGuard('/allowed')).toBe(false);

    api.registerGuard(null);
    expect(api.runGuard('/blocked')).toBe(false);
  });

  it('throws when used outside the provider', () => {
    // Silence the expected React error boundary noise for this one render.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(<RegistryProbe onReady={() => {}} />)
    ).toThrow(/within a NavigationGuardProvider/);
    spy.mockRestore();
  });
});

describe('GuardedLink', () => {
  const renderLink = (register: (api: ReturnType<typeof useNavigationGuard>) => void) =>
    render(
      <MemoryRouter initialEntries={['/start']}>
        <NavigationGuardProvider>
          <RegistryProbe onReady={register} />
          <LocationProbe />
          <Routes>
            <Route
              path="/start"
              element={<GuardedLink to="/next">Go next</GuardedLink>}
            />
            <Route path="/next" element={<div>arrived</div>} />
          </Routes>
        </NavigationGuardProvider>
      </MemoryRouter>
    );

  it('prevents the navigation when the guard intercepts', () => {
    renderLink((api) => api.registerGuard(() => true));

    fireEvent.click(screen.getByRole('link', { name: 'Go next' }));

    // The guard took the click, so the location did not move.
    expect(screen.getByTestId('location')).toHaveTextContent('/start');
    expect(screen.queryByText('arrived')).not.toBeInTheDocument();
  });

  it('lets the navigation through when the guard does not intercept', () => {
    renderLink((api) => api.registerGuard(() => false));

    fireEvent.click(screen.getByRole('link', { name: 'Go next' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/next');
    expect(screen.getByText('arrived')).toBeInTheDocument();
  });

  it('navigates normally when no guard is registered at all', () => {
    renderLink(() => {});

    fireEvent.click(screen.getByRole('link', { name: 'Go next' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/next');
  });

  it("runs the caller's own onClick before consulting the guard", () => {
    const clicked = vi.fn();
    render(
      <MemoryRouter initialEntries={['/start']}>
        <NavigationGuardProvider>
          <RegistryProbe onReady={(api) => api.registerGuard(() => true)} />
          <LocationProbe />
          <Routes>
            <Route
              path="/start"
              element={
                <GuardedLink to="/next" onClick={clicked}>
                  Go next
                </GuardedLink>
              }
            />
            <Route path="/next" element={<div>arrived</div>} />
          </Routes>
        </NavigationGuardProvider>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('link', { name: 'Go next' }));

    // The side-effect fired even though the navigation was blocked.
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location')).toHaveTextContent('/start');
  });
});
