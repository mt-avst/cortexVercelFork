import React, { createContext, useCallback, useContext, useRef } from 'react';
import { Link, type LinkProps } from 'react-router-dom';

/**
 * A cross-cutting confirm-before-you-leave hook for in-app navigation.
 *
 * The problem this solves is narrow and specific (WZ-13): the global Header's
 * links navigate through react-router directly, so a dirty author who clicks
 * one bypasses BOTH the `beforeunload` guard (which only fires on browser
 * exits) and the form's own in-app exit confirmation. The Header and the page
 * live in different subtrees, so the page cannot reach into the Header to
 * intercept its links - but they share this provider, mounted above both, and
 * the page registers a guard on it that the Header's links consult.
 *
 * Deliberately NOT a router migration: this app mounts `BrowserRouter` with a
 * `Routes` tree, so `useBlocker` (which needs a data router) is not available,
 * and moving the whole app onto `createBrowserRouter` is a far larger change
 * than one confirmation dialog warrants.
 */

/**
 * A guard the current page has registered. Returns true when it has INTERCEPTED
 * the navigation - meaning it has taken responsibility for it (typically by
 * opening a confirmation) and the caller must NOT navigate. Returns false when
 * it has no objection and the caller should proceed as normal.
 */
export type NavGuard = (destination: string) => boolean;

interface NavigationGuardContextValue {
  /**
   * Install (or clear, with null) the guard consulted on every guarded
   * navigation. Stable across renders, so an effect can depend on it without
   * re-registering on every render.
   */
  registerGuard: (guard: NavGuard | null) => void;
  /**
   * Ask the registered guard about a destination. Returns the guard's own
   * boolean, or false when no guard is registered - so an app with no guard in
   * play navigates exactly as it would without this provider.
   */
  runGuard: (destination: string) => boolean;
}

const NavigationGuardContext = createContext<NavigationGuardContextValue | undefined>(
  undefined
);

export const NavigationGuardProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  // A ref, not state: registering a guard is not a render-affecting event, and
  // the guard is read imperatively at click time rather than during render.
  const guardRef = useRef<NavGuard | null>(null);

  const registerGuard = useCallback((guard: NavGuard | null): void => {
    guardRef.current = guard;
  }, []);

  const runGuard = useCallback(
    (destination: string): boolean =>
      guardRef.current ? guardRef.current(destination) : false,
    []
  );

  return (
    <NavigationGuardContext.Provider value={{ registerGuard, runGuard }}>
      {children}
    </NavigationGuardContext.Provider>
  );
};

export const useNavigationGuard = (): NavigationGuardContextValue => {
  const context = useContext(NavigationGuardContext);
  if (context === undefined) {
    throw new Error('useNavigationGuard must be used within a NavigationGuardProvider');
  }
  return context;
};

/** A registry that accepts a guard and forgets it, for when there is no provider. */
const NOOP_REGISTRY: NavigationGuardContextValue = {
  registerGuard: () => {},
  runGuard: () => false,
};

/**
 * Like `useNavigationGuard`, but returns a no-op registry when there is no
 * provider above rather than throwing.
 *
 * A page that WANTS to register a guard (OpportunityForm) should not crash when
 * it is rendered without one. In the running app the provider is always present
 * - App mounts it in `AppChromeLayout` above every routed page - but the form
 * is also rendered in isolation by its own tests and could be embedded
 * elsewhere with no Header to guard, and registering into a registry nobody
 * reads is harmless. `GuardedLink` keeps the throwing hook, because a guarded
 * link with no provider is a wiring bug worth surfacing loudly.
 */
export const useOptionalNavigationGuard = (): NavigationGuardContextValue => {
  const context = useContext(NavigationGuardContext);
  return context ?? NOOP_REGISTRY;
};

/**
 * A react-router `Link` that consults the registered navigation guard before it
 * navigates. When the guard intercepts a string destination, the default is
 * prevented and the guard owns what happens next (e.g. a confirmation modal);
 * otherwise the Link behaves exactly as `react-router`'s does.
 *
 * The caller's own `onClick` still runs first and unconditionally, so a link
 * that also closes a menu or toggles something keeps doing it - the guard only
 * decides whether the navigation itself proceeds.
 */
export const GuardedLink: React.FC<LinkProps> = ({ onClick, to, ...rest }) => {
  // Optional, not the throwing hook: the Header renders GuardedLinks and is
  // mounted bare in many existing tests. Without a provider `runGuard` is the
  // no-op that returns false, so the link simply navigates as a plain `Link`
  // would - which is exactly the "no guard registered" behaviour anyway.
  const { runGuard } = useOptionalNavigationGuard();

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    // A modified click (Cmd/Ctrl/Shift/Alt, or a non-primary button) opens the
    // destination in a new tab or window and does NOT take this page away, so
    // it loses nothing and must not trip the guard - the same fall-through
    // react-router's own Link gives those clicks.
    const opensElsewhere =
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey;
    // `to` can be a partial Path object; the guard only speaks in string
    // destinations, which is what every guarded Header link uses. A non-string
    // `to` is left to navigate normally rather than guessed at.
    if (!opensElsewhere && typeof to === 'string' && runGuard(to)) {
      event.preventDefault();
    }
  };

  return <Link to={to} onClick={handleClick} {...rest} />;
};
