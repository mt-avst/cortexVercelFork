import { useCallback, useEffect, useRef, useState } from 'react';
import type { DependencyList, RefObject } from 'react';

/** Whether a scrolling strip has more content past either edge right now. */
export interface ScrollEdgeCue {
  left: boolean;
  right: boolean;
}

/**
 * The scroll-edge cue a horizontally-scrolling strip needs (the Research
 * Studies tab bar, the phone quick-filter chips): whether there is more
 * content past the left or right edge right now, so each strip's own CSS can
 * fade/arrow that edge. Extracted from two near-
 * identical ~25-line copies, one per strip.
 *
 * Recomputed on scroll (wire `onScroll={update}` on the scrolling element),
 * on window resize, and via a `ResizeObserver` on the element itself - a
 * window resize alone misses a CONTENT-driven width change (a tab's own
 * count badge arriving after mount, a chip's count changing under a Close),
 * which a `ResizeObserver` on the strip's own box does not always catch
 * either if the box itself does not change while the content still does -
 * `extraDeps` covers that: pass the values the strip's own content reads
 * (badge counts, filtered counts), and the cue recomputes whenever any of
 * them change, on top of scroll/resize/box-resize.
 */
export function useScrollEdgeCue<T extends HTMLElement>(
  extraDeps: DependencyList = []
): { ref: RefObject<T>; cue: ScrollEdgeCue; update: () => void } {
  const ref = useRef<T>(null);
  const [cue, setCue] = useState<ScrollEdgeCue>({ left: false, right: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next = { left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 };
    // Every `scroll` event on the strip called this - a strip scrolled
    // horizontally without ever nearing either edge (the common case: most
    // scroll positions leave both edges cued exactly as before) re-rendered
    // Admin on every single event regardless, since a fresh `{ left, right }`
    // object is a new reference even when both booleans are unchanged. Bail
    // out before `setState` when nothing actually changed.
    setCue((current) =>
      current.left === next.left && current.right === next.right ? current : next
    );
  }, []);

  useEffect(() => {
    update();
    window.addEventListener('resize', update);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver === 'function' && ref.current) {
      observer = new ResizeObserver(update);
      observer.observe(ref.current);
    }
    return () => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [update]);

  useEffect(() => {
    update();
    // extraDeps is a caller-supplied list, exhaustively deliberate - update
    // itself is stable (empty deps) and does not need to be named again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, extraDeps);

  return { ref, cue, update };
}

export default useScrollEdgeCue;
