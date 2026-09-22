import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import CalendarGrid from '../CalendarGrid';

/**
 * #130: the phone day-pager (`focusedDayIndex`) used to be written ONLY by
 * its own Previous/Next buttons, so a swipe on the still-swipeable
 * `.calendar-timeline` scroller left the label and the buttons'
 * enabled/disabled state pointing at the wrong day.
 *
 * Separately - and this is the second pass, after code review caught the
 * first fix reusing the wrong signal - the pager must render only when the
 * grid ACTUALLY cannot show every visible day at once, at ANY viewport
 * width. The first attempt gated it on `needsScrollContainment`, which folds
 * in a `matchMedia(max-width: 768px)` branch that is forced true for the
 * WHOLE <=768px band regardless of overflow (kept there deliberately, for
 * the sticky-header reason - see that state's own comment in the
 * component). Reusing it for the pager meant a 2-3 day study viewed at
 * 481-768px (iPad portrait, a half-width desktop window) - which fits with
 * room to spare - still showed a pager whose "Next" scrolled nothing: the
 * exact defect #130 exists to kill, over a WIDER band than main's original
 * (<=480px only). The fix is `gridOverflows`, the pure measured half of that
 * same check, with the matchMedia branch excluded.
 *
 * jsdom has NO LAYOUT (#95): `offsetWidth`, `clientWidth` and
 * `getBoundingClientRect` are always 0/stubbed, and `ResizeObserver` does not
 * exist at all - both verified directly against a bare jsdom window. A test
 * that scrolls or resizes a real element and asserts on layout-derived state
 * would pass whether or not the production code ran at all. Nothing here
 * relies on real layout; instead:
 *   - `Element.scrollLeft` IS a genuine settable/readable property in jsdom
 *     (verified: set 304, read back 304), so setting it and firing a
 *     `scroll` event exercises the real column-stride arithmetic in
 *     `handleTimelineScroll`, not a stub.
 *   - `window.matchMedia` does not exist in this jsdom at all, so mocking it
 *     is what controls the narrow-viewport branch directly.
 *   - `clientWidth` is a genuinely hard-wired-0 getter on `Element.prototype`
 *     (verified via its property descriptor) - not writable per-element like
 *     `scrollLeft` is. It is therefore overridden at the prototype level with
 *     a fake getter reading a test-controlled variable, and a minimal
 *     `ResizeObserver` stub is installed so the `measure()` effect that reads
 *     it actually runs (it early-returns otherwise) - `observe`/`disconnect`
 *     are no-ops, since every test here only needs the SYNCHRONOUS `measure()`
 *     call already inside that effect on mount, never a later resize
 *     callback. This drives `gridOverflows` exactly as deliberately as
 *     `scrollLeft` and `matchMedia` are driven above, and never lets a real
 *     (always-zero) `clientWidth` decide a test's outcome.
 */

vi.mock('../../api/client', () => ({
  getMyBookings: vi.fn(async () => ({ upcoming: [], past: [] })),
  getCalendarConnectionStatus: vi.fn(async () => ({ connected: false, connectedAt: null })),
  getMyCalendarEvents: vi.fn(async () => []),
}));

/** A one-hour session at 10am local on the given calendar day. */
const sessionOn = (day: string, id = `sess-${day}`) => {
  const start = new Date(`${day}T10:00:00`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    id,
    opportunity_id: 'opp-1',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    capacity: 3,
    remaining: 3,
  };
};

const renderGrid = (sessions: ReturnType<typeof sessionOn>[]) =>
  render(
    <MemoryRouter>
      <CalendarGrid
        sessions={sessions as never}
        onBookSession={vi.fn() as never}
        bookingLoading={null}
      />
    </MemoryRouter>
  );

/**
 * Installs a `window.matchMedia` mock that answers every query (the
 * component only ever asks `(max-width: 768px)`) with a fixed `matches`.
 * Controls the narrow-viewport branch only - NOT whether the grid overflows,
 * which is `mockedClientWidth` below. Kept separate on purpose: the whole
 * point of this fix is that these two must be independently controllable.
 */
const mockMatchMedia = (matches: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
};

/** See the docblock above: a no-op stand-in, just enough for `measure()`'s
 * mount-time effect to run instead of early-returning. */
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Backs the `Element.prototype.clientWidth` override installed below. */
let mockedClientWidth = 2000;

Object.defineProperty(Element.prototype, 'clientWidth', {
  configurable: true,
  get: () => mockedClientWidth,
});

/**
 * Forces `gridOverflows` true or false by setting the fake measured width
 * comfortably under or comfortably over what any fixture in this file
 * requires (largest here is 3 columns: 128*3 + 24*2 + 90 + 24 = 546px).
 */
const setMeasuredOverflow = (overflows: boolean) => {
  mockedClientWidth = overflows ? 50 : 2000;
};

const pinClockTo = (iso: string) => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(iso));
};

const ORIGINAL_MATCH_MEDIA = window.matchMedia;
const ORIGINAL_RESIZE_OBSERVER = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

beforeEach(() => {
  vi.clearAllMocks();
  // A fixed Monday-anchored week, all in the future, so nothing here is read
  // as past by the anchoring logic these tests are not exercising.
  pinClockTo('2026-09-01T09:00:00');
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  // Comfortable fit by default; a test that wants overflow says so explicitly.
  setMeasuredOverflow(false);
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = ORIGINAL_MATCH_MEDIA;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ORIGINAL_RESIZE_OBSERVER;
});

describe('CalendarGrid day pager - render gate (#130, second pass)', () => {
  it('hides the pager at a narrow (<=768px) viewport when the grid does not actually overflow', () => {
    // The regression code review caught: a `matchMedia`-narrow viewport used
    // to be enough on its own (via `needsScrollContainment`) even though
    // this grid comfortably fits.
    mockMatchMedia(true);
    setMeasuredOverflow(false);
    renderGrid([sessionOn('2026-09-07'), sessionOn('2026-09-08')]);

    expect(
      screen.queryByRole('group', { name: 'Calendar day navigation' })
    ).not.toBeInTheDocument();
  });

  it('shows the pager when the grid overflows, regardless of viewport width', () => {
    // A wide (non-narrow) viewport that genuinely cannot fit the grid - the
    // case `needsScrollContainment` alone would never have shown, since its
    // matchMedia branch is false here and only the measured half is true.
    mockMatchMedia(false);
    setMeasuredOverflow(true);
    renderGrid([sessionOn('2026-09-07'), sessionOn('2026-09-08')]);

    expect(screen.getByRole('group', { name: 'Calendar day navigation' })).toBeInTheDocument();
  });

  it('keeps the pager off a single-day grid even when the grid overflows', () => {
    mockMatchMedia(false);
    setMeasuredOverflow(true);
    renderGrid([sessionOn('2026-09-07')]);

    expect(
      screen.queryByRole('group', { name: 'Calendar day navigation' })
    ).not.toBeInTheDocument();
  });
});

describe('CalendarGrid day pager - swipe sync (#130)', () => {
  // Three columns at the shared (<6-column) 24px gutter, so one
  // column-stride is DAY_COLUMN_MIN_WIDTH_PX (128) + 24 = 152px.
  const COLUMN_STRIDE_PX = 152;

  it('moves the label and button state when the scroller is swiped, not just when its buttons are pressed', () => {
    setMeasuredOverflow(true);
    const { container } = renderGrid([
      sessionOn('2026-09-07'),
      sessionOn('2026-09-08'),
      sessionOn('2026-09-09'),
    ]);

    const timeline = container.querySelector('.calendar-timeline') as HTMLElement;
    expect(timeline).toBeTruthy();

    expect(screen.getByText('Mon, Sep 7 · 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous day' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next day' })).toBeEnabled();

    // A swipe to the last column - no button clicked.
    timeline.scrollLeft = 2 * COLUMN_STRIDE_PX;
    fireEvent.scroll(timeline);

    expect(screen.getByText('Wed, Sep 9 · 3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous day' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();
  });

  it('rounds a partial swipe to the nearest column rather than flooring it', () => {
    setMeasuredOverflow(true);
    const { container } = renderGrid([
      sessionOn('2026-09-07'),
      sessionOn('2026-09-08'),
      sessionOn('2026-09-09'),
    ]);
    const timeline = container.querySelector('.calendar-timeline') as HTMLElement;

    // 100 / 152 = 0.658, which rounds UP to column 1 (the second day) - a
    // floor would leave it at column 0.
    timeline.scrollLeft = 100;
    fireEvent.scroll(timeline);

    expect(screen.getByText('Tue, Sep 8 · 2 of 3')).toBeInTheDocument();
  });

  it('clamps a scroll position past the last column rather than reporting an out-of-range day', () => {
    setMeasuredOverflow(true);
    const { container } = renderGrid([sessionOn('2026-09-07'), sessionOn('2026-09-08')]);
    const timeline = container.querySelector('.calendar-timeline') as HTMLElement;

    // Overshoot well past the last column - momentum scroll on a real
    // device can report a `scrollLeft` briefly past the max.
    timeline.scrollLeft = 10_000;
    fireEvent.scroll(timeline);

    expect(screen.getByText('Tue, Sep 8 · 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();
  });

  it('still lets the buttons drive the pager directly (unchanged behaviour)', () => {
    setMeasuredOverflow(true);
    renderGrid([sessionOn('2026-09-07'), sessionOn('2026-09-08'), sessionOn('2026-09-09')]);

    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));

    expect(screen.getByText('Tue, Sep 8 · 2 of 3')).toBeInTheDocument();
  });
});

/**
 * Non-vacuousness, proven by mutation rather than asserted in prose:
 *
 * 1. Reverting the render gate from `gridOverflows` back to
 *    `needsScrollContainment` (the exact regression code review caught)
 *    turns "hides the pager at a narrow (<=768px) viewport when the grid
 *    does not actually overflow" red: with `mockMatchMedia(true)`,
 *    `needsScrollContainment` is true regardless of `setMeasuredOverflow
 *    (false)`, so the pager renders and the `not.toBeInTheDocument()`
 *    assertion fails. ("shows the pager when the grid overflows..." does NOT
 *    catch this particular mutation - `needsScrollContainment` also goes
 *    true via its own OR'd-in overflow measurement in that case, which is
 *    why the narrow-but-fitting test above is the one that has to exist.)
 *
 * 2. Reverting the render gate to a constant `false` turns "shows the pager
 *    when the grid overflows..." red, and every swipe-sync test red with it
 *    (the pager cannot be found to interact with at all).
 *
 * 3. Deleting the `onScroll={handleTimelineScroll}` wiring (or reverting
 *    `handleTimelineScroll` to a no-op) turns every test in the "swipe sync"
 *    describe block red except the last: firing `scroll` on the timeline no
 *    longer moves `focusedDayIndex`, so the label stays "Mon, Sep 7 · 1 of 3"
 *    after every simulated swipe. The last test, which drives the buttons
 *    directly rather than the scroller, keeps passing either way - the
 *    control proving the other three are not passing for an unrelated
 *    reason (e.g. the buttons alone rendering the right label).
 *
 * Verified locally against this branch; not committed, since it is a
 * temporary edit to source made only to prove these tests kill the mutations
 * they target.
 */
