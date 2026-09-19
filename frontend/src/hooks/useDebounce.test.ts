import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useDebounce } from './useDebounce';

describe('useDebounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebounce('a', 200));
    expect(result.current).toBe('a');
  });

  it('holds the old value until the delay elapses, then updates', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounce(v, 200), {
      initialProps: { v: 'a' },
    });

    rerender({ v: 'b' });
    expect(result.current).toBe('a'); // not yet

    act(() => vi.advanceTimersByTime(199));
    expect(result.current).toBe('a'); // still holding

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('b'); // delay reached
  });

  it('collapses a burst of changes to the last value (timer resets each change)', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounce(v, 200), {
      initialProps: { v: 'a' },
    });

    rerender({ v: 'ab' });
    act(() => vi.advanceTimersByTime(150));
    rerender({ v: 'abc' });
    act(() => vi.advanceTimersByTime(150)); // 300ms total, but only 150 since last change
    expect(result.current).toBe('a'); // never settled on the intermediate 'ab'

    act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe('abc');
  });
});
