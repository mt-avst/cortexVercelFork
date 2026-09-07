import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import CalendarGrid from '../CalendarGrid';

/**
 * #112: the grid used to anchor its truncated window on the CHRONOLOGICALLY
 * EARLIEST days-with-sessions, with no regard for whether they had already
 * passed. An opportunity open for several weeks - old sessions still in the
 * data, new ones added on top - could fill the whole seven-column budget with
 * past, unbookable days and push the current and future weeks, and everything
 * bookable in them, out of the window entirely. A participant opening the
 * calendar then saw last week's availability with nothing on screen able to
 * reach a bookable day.
 *
 * The fix anchors the default window on the earliest day that has NOT yet
 * ended, and adds a Previous/Next control so a participant can still reach a
 * page the default window does not cover - but only once there is more than
 * one page to move between (`showWeekNav`, gated on more than
 * MAX_VISIBLE_DAYS distinct days-with-sessions).
 *
 * Same conventions as `CalendarGrid.weekend.test.tsx`: fixtures are pinned to
 * fixed calendar dates rather than offset from the day the suite runs, and
 * the clock is pinned with fake timers so "today" is a known instant.
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

/** The slot's title is the only user-visible statement of what it thinks it is. */
const availableAt10 = /^Available: 10:00 AM - 11:00 AM/;

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
 * Pins the clock so "today", "past" and the default anchor are all decided
 * against a known instant. shouldAdvanceTime keeps React's own scheduling and
 * Testing Library's async helpers working.
 */
const pinClockTo = (iso: string) => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(iso));
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CalendarGrid - anchoring the default window on the upcoming week (#112)', () => {
  // Five days across three past weeks, and four days across two future
  // weeks - nine distinct days-with-sessions in total, two more than
  // MAX_VISIBLE_DAYS (7), so the window has to choose which to drop.
  const PAST = ['2026-08-17', '2026-08-19', '2026-08-24', '2026-08-26', '2026-08-31'];
  const FUTURE = ['2026-09-14', '2026-09-16', '2026-09-21', '2026-09-23'];

  it('shows the upcoming week, not the earliest past week, when the span is long', () => {
    // "Today" sits between the last past day (31 Aug) and the first future
    // one (14 Sep).
    pinClockTo('2026-09-07T09:00:00');
    renderGrid([...PAST, ...FUTURE].map((day) => sessionOn(day)));

    // The reported defect exactly: the earliest day of the whole span must
    // not be on screen once it has passed and something later exists to show
    // instead. This is the assertion that fails against the pre-fix anchor
    // (see the note below the describe block for how that was proven).
    expect(screen.queryByText('Mon, Aug 17')).not.toBeInTheDocument();
    expect(screen.queryByText('Wed, Aug 19')).not.toBeInTheDocument();
    expect(screen.queryByText('Mon, Aug 24')).not.toBeInTheDocument();
    expect(screen.queryByText('Wed, Aug 26')).not.toBeInTheDocument();
    expect(screen.queryByText('Mon, Aug 31')).not.toBeInTheDocument();

    // Every future day survives - there are only four of them, well inside
    // the seven-column budget, so none should have been sacrificed either.
    expect(screen.getByText('Mon, Sep 14')).toBeInTheDocument();
    expect(screen.getByText('Wed, Sep 16')).toBeInTheDocument();
    expect(screen.getByText('Mon, Sep 21')).toBeInTheDocument();
    expect(screen.getByText('Wed, Sep 23')).toBeInTheDocument();
    expect(screen.getAllByTitle(availableAt10)).toHaveLength(FUTURE.length);
  });

  it('backfills empty columns forward from the anchor only, never from the start of the whole span (HIGH)', () => {
    // Same fixture and same "today" as the test above, but this asserts the
    // FULL ORDERED set of headers rather than presence/absence of a handful
    // of days. That distinction matters here specifically: the earlier test
    // would still pass if the empty-day backfill pulled in filler from
    // BEFORE the anchor, as long as it also happened to keep all four future
    // days - which, for this exact fixture, it does not (see the mutation
    // note below the describe block). This is the test that actually pins
    // the backfill's start position.
    pinClockTo('2026-09-07T09:00:00');
    const { container } = renderGrid([...PAST, ...FUTURE].map((day) => sessionOn(day)));

    const titles = Array.from(container.querySelectorAll('.calendar-day-title')).map(
      (el) => el.textContent
    );

    // The exact ordered set - not "these are present", which a reordered or
    // padded-with-extras result could still satisfy. Four real session days
    // (14, 18, 21, 23 Sep) plus three empty fill days (15, 16, 17 Sep), all
    // of them on or after the anchor (14 Sep) and all within September.
    expect(titles).toEqual([
      'Mon, Sep 14',
      'Tue, Sep 15',
      'Wed, Sep 16',
      'Thu, Sep 17',
      'Fri, Sep 18',
      'Mon, Sep 21',
      'Wed, Sep 23',
    ]);

    // Restated independently of the exact-array check above: every visible
    // day's date is on or after the anchor day (14 Sep), and no August date
    // - the whole PAST fixture - appears anywhere in the titles.
    const anchor = new Date('2026-09-14T00:00:00');
    for (const text of titles) {
      expect(text).not.toBeNull();
      const parsed = new Date(`${text} 2026`);
      expect(parsed.getTime()).toBeGreaterThanOrEqual(anchor.getTime());
    }
    for (const label of ['Aug 17', 'Aug 19', 'Aug 24', 'Aug 26', 'Aug 31']) {
      expect(titles.some((t) => t?.includes(label))).toBe(false);
    }
  });

  it('does not show the navigation control when everything fits in one page', () => {
    // Three days in a single week - the control has nothing to move between,
    // and every day must still render without it.
    pinClockTo('2026-09-01T09:00:00');
    renderGrid(['2026-09-07', '2026-09-09', '2026-09-11'].map((day) => sessionOn(day)));

    expect(
      screen.queryByRole('group', { name: 'Session days navigation' })
    ).not.toBeInTheDocument();
    expect(screen.getByText('Mon, Sep 7')).toBeInTheDocument();
    expect(screen.getByText('Wed, Sep 9')).toBeInTheDocument();
    expect(screen.getByText('Fri, Sep 11')).toBeInTheDocument();
    expect(screen.getAllByTitle(availableAt10)).toHaveLength(3);
  });

  it('advances the visible days when Next is pressed, and back when Previous is pressed', () => {
    // Ten distinct days, all still in the future, so the default page is the
    // chronologically first seven and there is exactly one more page after.
    // Odd calendar days keep every one of them a distinct day-with-sessions.
    const days = [
      '2026-10-05',
      '2026-10-07',
      '2026-10-09',
      '2026-10-11',
      '2026-10-13',
      '2026-10-15',
      '2026-10-17',
      '2026-10-19',
      '2026-10-21',
      '2026-10-23'
    ];
    pinClockTo('2026-10-01T09:00:00');
    renderGrid(days.map((day) => sessionOn(day)));

    // Page one: the first seven days-with-sessions, no padding needed since
    // that is exactly MAX_VISIBLE_DAYS.
    expect(screen.getByText('Sat, Oct 17')).toBeInTheDocument();
    expect(screen.queryByText('Fri, Oct 23')).not.toBeInTheDocument();
    expect(screen.getAllByTitle(availableAt10)).toHaveLength(7);

    fireEvent.click(screen.getByRole('button', { name: 'Show later session days' }));

    // Page two: the remaining three real days. Only three sessions render
    // even though seven columns are drawn (the rest pad with empty days), so
    // the count is what proves the content actually moved rather than the
    // page merely re-rendering the same thing.
    expect(screen.getByText('Fri, Oct 23')).toBeInTheDocument();
    expect(screen.queryByText('Sat, Oct 17')).not.toBeInTheDocument();
    expect(screen.getAllByTitle(availableAt10)).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Show earlier session days' }));

    // Back to page one.
    expect(screen.getByText('Sat, Oct 17')).toBeInTheDocument();
    expect(screen.queryByText('Fri, Oct 23')).not.toBeInTheDocument();
    expect(screen.getAllByTitle(availableAt10)).toHaveLength(7);
  });

  it('keeps the omitted-days notice numerically accurate on both pages, and never claims a position', () => {
    // Same ten-day fixture as the paging test above. Oct 5-23 spans 17 days
    // in `sessionsByDate` (weekdays, plus the three weekend days - 11, 17 -
    // that happen to carry a session).
    const days = [
      '2026-10-05',
      '2026-10-07',
      '2026-10-09',
      '2026-10-11',
      '2026-10-13',
      '2026-10-15',
      '2026-10-17',
      '2026-10-19',
      '2026-10-21',
      '2026-10-23'
    ];
    pinClockTo('2026-10-01T09:00:00');
    renderGrid(days.map((day) => sessionOn(day)));

    // Page one draws 7 of the 17 days, so 10 are omitted; 3 of those (19, 21,
    // 23 Oct) carry a session - the "later" days page one could not fit.
    expect(screen.getByRole('status')).toHaveTextContent(
      '10 days are not shown, 3 of which have sessions. Use Previous / Next to see them.'
    );
    expect(screen.getByRole('status')).not.toHaveTextContent(/first/i);
    expect(screen.getByRole('status')).not.toHaveTextContent(/later days/i);

    fireEvent.click(screen.getByRole('button', { name: 'Show later session days' }));

    // Page two draws only 5 columns (19-23 Oct: the forward walk runs out of
    // span before it reaches seven), so 12 of the 17 are omitted this time -
    // and all 7 of the real session days page one drew are now among the
    // omitted set instead, which is exactly why the notice cannot say
    // "later": on this page the un-shown days with sessions are EARLIER.
    expect(screen.getByRole('status')).toHaveTextContent(
      '12 days are not shown, 7 of which have sessions. Use Previous / Next to see them.'
    );
    expect(screen.getByRole('status')).not.toHaveTextContent(/first/i);
    expect(screen.getByRole('status')).not.toHaveTextContent(/later days/i);
  });

  it('resets to the default anchored page when the sessions prop changes identity, even mid-page', () => {
    const days = [
      '2026-10-05',
      '2026-10-07',
      '2026-10-09',
      '2026-10-11',
      '2026-10-13',
      '2026-10-15',
      '2026-10-17',
      '2026-10-19',
      '2026-10-21',
      '2026-10-23'
    ];
    pinClockTo('2026-10-01T09:00:00');
    const { rerender } = renderGrid(days.map((day) => sessionOn(day)));

    fireEvent.click(screen.getByRole('button', { name: 'Show later session days' }));

    // Proves the page actually moved before proving the reset - a reset that
    // never left page one would make the assertion below vacuous.
    expect(screen.getByText('Fri, Oct 23')).toBeInTheDocument();
    expect(screen.queryByText('Sat, Oct 17')).not.toBeInTheDocument();

    // A refetch: the same session days, but a brand NEW array reference -
    // nothing in the data has actually changed, only its identity.
    rerender(
      <MemoryRouter>
        <CalendarGrid
          sessions={days.map((day) => sessionOn(day)) as never}
          onBookSession={vi.fn() as never}
          bookingLoading={null}
        />
      </MemoryRouter>
    );

    // Back to the default anchored window - page one - with no click asking
    // for it. A `navPage` left pointing at the old page two would either show
    // the wrong days for a data set that has moved on, or point past the end
    // of one that has shrunk.
    expect(screen.getByText('Sat, Oct 17')).toBeInTheDocument();
    expect(screen.queryByText('Fri, Oct 23')).not.toBeInTheDocument();
    expect(screen.getAllByTitle(availableAt10)).toHaveLength(7);
  });
});

/**
 * Non-vacuousness of the first test above, proven by mutation rather than
 * asserted in prose:
 *
 * Replacing `anchorIndex`'s body with an unconditional `return 0;` -
 * reproducing the pre-#112 behaviour of always starting the window at the
 * chronologically earliest day-with-sessions - turns "shows the upcoming
 * week, not the earliest past week, when the span is long" red: `Mon, Aug 17`
 * (and the next four past days) are found on screen, and `Mon, Sep 21` /
 * `Wed, Sep 23` are not, because the seven-column budget is spent on
 * `[17, 19, 24, 26, 31 Aug, 14, 16 Sep]` - the five past days plus only the
 * first two future ones. Restoring the real `anchorIndex` makes it pass
 * again. Verified locally against this branch; not committed, since it is a
 * temporary edit to source made only to prove the test kills the mutation it
 * targets.
 */
