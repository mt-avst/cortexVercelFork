import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScrollEdgeCue } from '../useScrollEdgeCue';

/**
 * useScrollEdgeCue (TESTLANE-C section 2): the left/right "more content past
 * this edge" cue a horizontally-scrolling strip needs, plus the bail-out
 * C-L4/round 5 called for - `setCue` must not re-render on a scroll event
 * that leaves both edges exactly as they were.
 */

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const ORIGINAL_RESIZE_OBSERVER = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

afterEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ORIGINAL_RESIZE_OBSERVER;
  vi.restoreAllMocks();
});

/** A scrollable element with the three geometry properties `update` reads,
 * all otherwise 0 in jsdom (no real layout). */
const mockGeometry = (el: HTMLElement, { scrollLeft = 0, scrollWidth = 0, clientWidth = 0 }) => {
  Object.defineProperty(el, 'scrollLeft', { configurable: true, value: scrollLeft, writable: true });
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
};

describe('useScrollEdgeCue', () => {
  it('starts with both edges false when the ref is not attached yet (no element to measure)', () => {
    const { result } = renderHook(() => useScrollEdgeCue<HTMLDivElement>());
    expect(result.current.cue).toEqual({ left: false, right: false });
  });

  it('reports a right cue at the scrolled-to-start left edge of an overflowing strip', () => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    const el = document.createElement('div');
    document.body.appendChild(el);
    mockGeometry(el, { scrollLeft: 0, scrollWidth: 500, clientWidth: 200 });

    const { result } = renderHook(() => useScrollEdgeCue<HTMLDivElement>());
    act(() => {
      (result.current.ref as { current: HTMLDivElement | null }).current = el;
      result.current.update();
    });
    expect(result.current.cue).toEqual({ left: false, right: true });
    el.remove();
  });

  it('reports both edges cued once scrolled past the start and before the end', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    mockGeometry(el, { scrollLeft: 150, scrollWidth: 500, clientWidth: 200 });
    // max = 500 - 200 = 300; scrollLeft 150 is > 1 and < 300 - 1.

    const { result } = renderHook(() => useScrollEdgeCue<HTMLDivElement>());
    act(() => {
      (result.current.ref as { current: HTMLDivElement | null }).current = el;
      result.current.update();
    });
    expect(result.current.cue).toEqual({ left: true, right: true });
    el.remove();
  });

  it('reports only the left cue once scrolled to the end', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    mockGeometry(el, { scrollLeft: 300, scrollWidth: 500, clientWidth: 200 });

    const { result } = renderHook(() => useScrollEdgeCue<HTMLDivElement>());
    act(() => {
      (result.current.ref as { current: HTMLDivElement | null }).current = el;
      result.current.update();
    });
    expect(result.current.cue).toEqual({ left: true, right: false });
    el.remove();
  });

  it('reports neither edge when the strip does not overflow at all', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    mockGeometry(el, { scrollLeft: 0, scrollWidth: 200, clientWidth: 200 });

    const { result } = renderHook(() => useScrollEdgeCue<HTMLDivElement>());
    act(() => {
      (result.current.ref as { current: HTMLDivElement | null }).current = el;
      result.current.update();
    });
    expect(result.current.cue).toEqual({ left: false, right: false });
    el.remove();
  });

  it('recomputes when an extra dependency changes, on top of scroll/resize', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    mockGeometry(el, { scrollLeft: 0, scrollWidth: 500, clientWidth: 200 });

    let dep = 1;
    const { result, rerender } = renderHook(() => useScrollEdgeCue<HTMLDivElement>([dep]));
    act(() => {
      (result.current.ref as { current: HTMLDivElement | null }).current = el;
      result.current.update();
    });
    expect(result.current.cue).toEqual({ left: false, right: true });

    // The strip shrank under the same content (e.g. a chip's count changed).
    mockGeometry(el, { scrollLeft: 300, scrollWidth: 500, clientWidth: 200 });
    dep = 2;
    act(() => {
      rerender();
    });
    expect(result.current.cue).toEqual({ left: true, right: false });
    el.remove();
  });

  it('makes no state update when neither edge value changed (round 5 bail-out) - the returned cue object stays referentially the same', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    mockGeometry(el, { scrollLeft: 150, scrollWidth: 500, clientWidth: 200 });

    const { result } = renderHook(() => useScrollEdgeCue<HTMLDivElement>());
    act(() => {
      (result.current.ref as { current: HTMLDivElement | null }).current = el;
      result.current.update();
    });
    const firstCue = result.current.cue;
    expect(firstCue).toEqual({ left: true, right: true });

    // A further scroll event that leaves both edges exactly as they were -
    // the common case a real strip fires far more often than an edge change.
    mockGeometry(el, { scrollLeft: 151, scrollWidth: 500, clientWidth: 200 });
    act(() => {
      result.current.update();
    });
    expect(result.current.cue).toBe(firstCue);
    el.remove();
  });

  it('cleans up its resize listener and observer on unmount - a leaked window listener is not bound to anything here', () => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useScrollEdgeCue<HTMLDivElement>());
    unmount();
    expect(removeSpy.mock.calls.some(([type]) => type === 'resize')).toBe(true);
  });
});
