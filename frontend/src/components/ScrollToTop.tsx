import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Resets the window scroll to the top whenever the route pathname changes.
 *
 * React Router keeps the previous scroll position across a client-side
 * navigation, so clicking a study part-way down the list would land the reader
 * mid-page on the new screen. `BrowserRouter` has no `<ScrollRestoration>`
 * (that ships only with the data routers), so this small effect stands in for
 * it: on every pathname change it jumps straight to the top.
 *
 * Keyed on `pathname` alone, not `search` or `hash`, so an in-page anchor
 * (`#section`) or a filter that only rewrites the query string does not yank
 * the reader back to the top.
 */
export default function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    // 'auto' (instant), never 'smooth': a scroll animation on a fresh page is
    // disorienting, and it would race the new page's own paint.
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [pathname]);

  return null;
}
