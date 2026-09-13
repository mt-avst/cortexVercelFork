import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ScrollToTop from '../ScrollToTop';

/**
 * A tiny harness that drives a navigation on mount, so a test can assert what
 * ScrollToTop does in response to a route change without a real browser.
 */
function Navigate({ to }: { to: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to);
  }, [navigate, to]);
  return null;
}

describe('ScrollToTop', () => {
  let scrollSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollSpy = vi.fn();
    // jsdom has no scrolling; install a spy we can assert against.
    window.scrollTo = scrollSpy as unknown as typeof window.scrollTo;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scrolls to the top when the pathname changes', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <ScrollToTop />
        <Navigate to="/opportunities/abc" />
        <Routes>
          <Route path="/" element={<div>home</div>} />
          <Route path="/opportunities/:id" element={<div>detail</div>} />
        </Routes>
      </MemoryRouter>,
    );

    // Once for the initial mount, once for the push to a new pathname.
    expect(scrollSpy).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
    expect(scrollSpy).toHaveBeenCalledTimes(2);
  });

  it('does not scroll when only the query string changes', () => {
    render(
      <MemoryRouter initialEntries={['/studies']}>
        <ScrollToTop />
        <Navigate to="/studies?type=survey" />
        <Routes>
          <Route path="/studies" element={<div>studies</div>} />
        </Routes>
      </MemoryRouter>,
    );

    // Only the initial mount; the search-only change must not yank the reader up.
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });
});
