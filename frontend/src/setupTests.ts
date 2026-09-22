// Vitest setup file for frontend tests
import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// findBy*/waitFor default to a 1000ms poll window. That is ample on a developer
// machine, where an async-rendered element (a row menu opening, a portal
// mounting) appears in tens of ms. On the contended shared CI runner it is not:
// the click -> state update -> re-render -> portal mount is starved of CPU, and
// the 1000ms window elapses before the element exists, so findBy throws
// "Unable to find role ...". That is the actual flake that reddened
// test-frontend on !506's post-merge pipeline (Admin.test.tsx "offers Analytics
// in the row menu"), skipping #149's deploy. 5000ms gives the DOM time to
// appear under load; a passing query still returns the instant the element
// exists, so the green path is unchanged, and a genuinely missing element still
// fails (just 5s later).
configure({ asyncUtilTimeout: 5000 });

// jsdom does not implement window.scrollTo and throws "Not implemented" when it
// is called. ScrollToTop (mounted for real by App.test) calls it on every route
// change, so stub it to a no-op to keep the suite output clean. A test that
// needs to assert on scrolling installs its own spy.
if (typeof window !== 'undefined') {
  window.scrollTo = () => {};
}

// Same gap, one level down: jsdom does not implement Element.prototype.scrollTo
// either. CalendarGrid's day pager (#130) calls it on its own scroller element
// from a button click, which previously had no test exercising that click at
// all - the first one to do so turned an unrelated jsdom limitation into an
// uncaught "scrollTo is not a function" that failed the run despite every
// assertion passing. Stubbed globally for the same reason as window.scrollTo
// above: any future component calling `el.scrollTo(...)` from an event handler
// would hit this identically.
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo() {};
}
