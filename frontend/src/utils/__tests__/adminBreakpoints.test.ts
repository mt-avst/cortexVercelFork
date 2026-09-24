import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  COMPACT_ACTIONS_BREAKPOINT,
  COMPACT_ACTIONS_QUERY,
  PHONE_BREAKPOINT,
  PHONE_QUERY,
  supportsMatchMedia,
  useMatchMedia,
} from '../adminBreakpoints';

/**
 * useMatchMedia / adminBreakpoints (TESTLANE-C section 2): the shared
 * breakpoint constants both Admin.tsx (kebab lead, phone toolbar) and
 * `_components.css` must stay in step at, and the live matchMedia boolean
 * that reads them.
 */

const ORIGINAL_MATCH_MEDIA = window.matchMedia;

/** A fake MediaQueryList that supports the `change` event `useMatchMedia`
 * listens for, unlike the CalendarGrid pattern's fixed-answer stub. */
class FakeMediaQueryList {
  matches: boolean;
  media: string;
  private listeners = new Set<() => void>();

  constructor(media: string, matches: boolean) {
    this.media = media;
    this.matches = matches;
  }

  addEventListener = (_type: 'change', cb: () => void) => {
    this.listeners.add(cb);
  };

  removeEventListener = (_type: 'change', cb: () => void) => {
    this.listeners.delete(cb);
  };

  /** Test-only: flips `matches` and fires every registered listener. */
  set(matches: boolean) {
    this.matches = matches;
    this.listeners.forEach((cb) => cb());
  }

  get listenerCount() {
    return this.listeners.size;
  }
}

const installFakeMatchMedia = (initial: boolean): FakeMediaQueryList => {
  const mql = new FakeMediaQueryList('(max-width: 575.98px)', initial);
  window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;
  return mql;
};

afterEach(() => {
  window.matchMedia = ORIGINAL_MATCH_MEDIA;
});

describe('the breakpoint constants', () => {
  it('are pinned as literals, and the CSS-facing query strings match them', () => {
    expect(COMPACT_ACTIONS_BREAKPOINT).toBe(1023.98);
    expect(COMPACT_ACTIONS_QUERY).toBe('(max-width: 1023.98px)');
    expect(PHONE_BREAKPOINT).toBe(575.98);
    expect(PHONE_QUERY).toBe('(max-width: 575.98px)');
  });
});

describe('supportsMatchMedia', () => {
  it('is true when window.matchMedia exists as a function', () => {
    installFakeMatchMedia(false);
    expect(supportsMatchMedia()).toBe(true);
  });

  it('is false when window.matchMedia is missing - jsdom has none at all by default (guard, not a stub)', () => {
    // @ts-expect-error - deleting a required global to exercise the guard.
    delete window.matchMedia;
    expect(supportsMatchMedia()).toBe(false);
  });
});

describe('useMatchMedia', () => {
  it('starts from the real matchMedia value, not a guessed initial state', () => {
    installFakeMatchMedia(true);
    const { result } = renderHook(() => useMatchMedia('(max-width: 575.98px)'));
    expect(result.current).toBe(true);
  });

  it('updates on a change event', () => {
    const mql = installFakeMatchMedia(false);
    const { result } = renderHook(() => useMatchMedia('(max-width: 575.98px)'));
    expect(result.current).toBe(false);

    act(() => {
      mql.set(true);
    });
    expect(result.current).toBe(true);

    act(() => {
      mql.set(false);
    });
    expect(result.current).toBe(false);
  });

  it('removes its change listener on unmount (cleanup)', () => {
    const mql = installFakeMatchMedia(false);
    const { unmount } = renderHook(() => useMatchMedia('(max-width: 575.98px)'));
    expect(mql.listenerCount).toBe(1);

    unmount();
    expect(mql.listenerCount).toBe(0);
  });

  it('does not throw, and reads as false, when matchMedia does not exist (jsdom has no stub at all)', () => {
    // @ts-expect-error - exercising the no-matchMedia guard.
    delete window.matchMedia;
    const { result } = renderHook(() => useMatchMedia('(max-width: 575.98px)'));
    expect(result.current).toBe(false);
  });
});
