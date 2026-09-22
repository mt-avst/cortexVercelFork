import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import CalendarGrid from '../CalendarGrid';

/**
 * #130: the phone day-pager (`focusedDayIndex`) used to be written ONLY by
 * its own Previous/Next buttons, so a swipe on the still-swipeable
 * `.calendar-timeline` scroller left the label and the buttons'
 * enabled/disabled state pointing at the wrong day. Separately, it rendered
 * on viewport width alone (`isNarrowViewport`), with no regard for whether
 * the grid actually needed to scroll - two days that fit comfortably at a
 * narrow-but-not-tiny width still showed a pager whose "Next" moved nothing.
 *
 * jsdom has NO LAYOUT (#95): `offsetWidth`, `clientWidth` and
 * `getBoundingClientRect` are always 0/stubbed, so a test that scrolls a real
 * element and then asserts on layout-derived state would pass whether or not
 * the production code ran at all. Two things below are NOT stubbed, and are
 * what these tests actually drive:
 *   - `Element.scrollLeft` is a genuine settable/readable property in jsdom
 *     (verified directly: `el.scrollLeft = 304` then reads back `304`),
 *     unlike `clientWidth`, which is hard-wired to 0 - so setting it and
 *     firing a `scroll` event exercises the real column-stride arithmetic in
 *     `handleTimelineScroll`, not a stub.
 *   - `window.matchMedia` does not exist at all in this jsdom (verified:
 *     `typeof window.matchMedia === 'undefined'` on a bare jsdom window, and
 *     no setup file here installs one), so mocking it is what actually
 *     controls `needsScrollContainment` in these tests. The OTHER path that
 *     can set it - the `ResizeObserver` measurement against `clientWidth` -
 *     is a second vacuity trap (that width is always 0 in jsdom) and is never
 *     reached here: `ResizeObserver` is also undefined in this environment,
 *     so that branch returns early and cannot quietly make these tests pass
 *     for the wrong reason.
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
 * component only ever asks `(max-width: 768px)`) with a fixed `matches`,
 * which is what drives `needsScrollContainment`'s initial state directly -
 * see the docblock above for why this, and not a layout measurement, is the
 * non-vacuous way to control it here.
 */
const mockMatchMedia = (matches: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
};

const pinClockTo = (iso: string) => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(iso));
};

const ORIGINAL_MATCH_MEDIA = window.matchMedia;

beforeEach(() => {
  vi.clearAllMocks();
  // A fixed Monday-anchored week, all in the future, so nothing here is read
  // as past by the anchoring logic these tests are not exercising.
  pinClockTo('2026-09-01T09:00:00');
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = ORIGINAL_MATCH_MEDIA;
});

describe('CalendarGrid day pager - render gate (#130)', () => {
  it('does not render when the grid does not need scroll containment, even with more than one visible day', () => {
    mockMatchMedia(false);
    renderGrid([sessionOn('2026-09-07'), sessionOn('2026-09-08')]);

    expect(
      screen.queryByRole('group', { name: 'Calendar day navigation' })
    ).not.toBeInTheDocument();
  });

  it('renders once the grid needs scroll containment', () => {
    mockMatchMedia(true);
    renderGrid([sessionOn('2026-09-07'), sessionOn('2026-09-08')]);

    expect(screen.getByRole('group', { name: 'Calendar day navigation' })).toBeInTheDocument();
  });

  it('stays off a single-day grid even when scroll containment is on', () => {
    mockMatchMedia(true);
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
    mockMatchMedia(true);
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
    mockMatchMedia(true);
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
    mockMatchMedia(true);
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
    mockMatchMedia(true);
    renderGrid([sessionOn('2026-09-07'), sessionOn('2026-09-08'), sessionOn('2026-09-09')]);

    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));

    expect(screen.getByText('Tue, Sep 8 · 2 of 3')).toBeInTheDocument();
  });
});

/**
 * Non-vacuousness, proven by mutation rather than asserted in prose:
 *
 * 1. Reverting the render gate to `isNarrowViewport && visibleDays.length > 1`
 *    (the pre-#130 shape) turns both tests in the "render gate" describe
 *    block red: with no `window.innerWidth` narrowed and `matchMedia` mocked
 *    but `isNarrowViewport`'s own initial-state check reading
 *    `window.innerWidth <= 480` (jsdom's default width is 1024), the pager
 *    never renders even when `mockMatchMedia(true)` says scroll containment
 *    is on - "renders once the grid needs scroll containment" fails to find
 *    the group role.
 *
 * 2. Deleting the `onScroll={handleTimelineScroll}` wiring (or reverting
 *    `handleTimelineScroll` to a no-op) turns every test in the "swipe sync"
 *    describe block red except the last: firing `scroll` on the timeline no
 *    longer moves `focusedDayIndex`, so the label stays "Mon, Sep 7 · 1 of 3"
 *    after every simulated swipe and the disabled-state assertions on the
 *    buttons fail. The last test, which drives the buttons directly rather
 *    than the scroller, keeps passing either way - which is exactly why it
 *    is included, as the control proving the other four are not passing for
 *    an unrelated reason (e.g. the buttons alone rendering the right label).
 *
 * Verified locally against this branch; not committed, since it is a
 * temporary edit to source made only to prove these tests kill the mutations
 * they target.
 */
