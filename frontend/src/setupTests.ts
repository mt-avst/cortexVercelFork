// Vitest setup file for frontend tests
import '@testing-library/jest-dom/vitest';

// jsdom does not implement window.scrollTo and throws "Not implemented" when it
// is called. ScrollToTop (mounted for real by App.test) calls it on every route
// change, so stub it to a no-op to keep the suite output clean. A test that
// needs to assert on scrolling installs its own spy.
if (typeof window !== 'undefined') {
  window.scrollTo = () => {};
}
