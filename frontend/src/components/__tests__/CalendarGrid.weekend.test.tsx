import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import CalendarGrid from '../CalendarGrid';

/**
 * Nothing in the admin session-creation flow stops an admin scheduling a
 * session on a Saturday or a Sunday, so the grid has to be able to show one.
 *
 * It used to build its columns from Monday to Friday only. A weekend session
 * landed in no column at all, and an opportunity whose sessions were ALL on a
 * weekend fell through to the "No sessions available" empty state - the
 * participant was told there was nothing to book while a bookable slot sat in
 * the database. That is data loss at the presentation layer, not a display
 * preference, which is why these tests assert on the slot as well as the column.
 *
 * Every fixture here is pinned to a fixed week rather than offset from the day
 * the suite runs. The defect these tests cover was originally masked by a
 * fixture that moved with the calendar and so only failed on two days in seven.
 */

vi.mock('../../api/client', () => ({
  getMyBookings: vi.fn(async () => ({ upcoming: [], past: [] })),
  getCalendarConnectionStatus: vi.fn(async () => ({ connected: false, connectedAt: null })),
  getMyCalendarEvents: vi.fn(async () => []),
}));

/** Monday of the pinned week. The whole week runs 7 Sep (Mon) to 13 Sep (Sun) 2026. */
const MONDAY = '2026-09-07';
const FRIDAY = '2026-09-11';
const SATURDAY = '2026-09-12';
const SUNDAY = '2026-09-13';

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
 * Pins the clock so "today", "past" and the Now indicator are all decided
 * against a known instant. shouldAdvanceTime keeps React's own scheduling and
 * Testing Library's async helpers working.
 */
const pinClockTo = (iso: string) => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(iso));
};

beforeEach(() => {
  vi.clearAllMocks();
  // The whole week is in the future from here, so no fixture reads as past.
  pinClockTo('2026-09-01T09:00:00');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CalendarGrid - sessions on a weekend', () => {
  it('renders a lone Saturday session instead of the empty state', () => {
    renderGrid([sessionOn(SATURDAY)]);

    // The reproduction: this used to be "No sessions available".
    expect(screen.getByTitle(availableAt10)).toBeInTheDocument();
    expect(screen.queryByText('No sessions available')).not.toBeInTheDocument();
  });

  it('gives the Saturday its own labelled column', () => {
    renderGrid([sessionOn(SATURDAY)]);

    expect(screen.getByText('Sat, Sep 12')).toBeInTheDocument();
  });

  it('renders a lone Sunday session too', () => {
    renderGrid([sessionOn(SUNDAY)]);

    expect(screen.getByTitle(availableAt10)).toBeInTheDocument();
    expect(screen.getByText('Sun, Sep 13')).toBeInTheDocument();
  });

  it('does not add a column for a weekend day that has no sessions', () => {
    // Friday and the following Monday. The weekend between them is empty, so
    // widening the grid must not start padding it with two blank columns.
    renderGrid([sessionOn(FRIDAY), sessionOn('2026-09-14')]);

    expect(screen.getByText('Fri, Sep 11')).toBeInTheDocument();
    expect(screen.getByText('Mon, Sep 14')).toBeInTheDocument();
    expect(screen.queryByText('Sat, Sep 12')).not.toBeInTheDocument();
    expect(screen.queryByText('Sun, Sep 13')).not.toBeInTheDocument();
  });

  it('keeps all seven days of a Monday-to-Sunday span', () => {
    const week = [MONDAY, '2026-09-08', '2026-09-09', '2026-09-10', FRIDAY, SATURDAY, SUNDAY];
    renderGrid(week.map(day => sessionOn(day)));

    // Guards the column cap as much as the weekday filter: the grid used to
    // slice to five columns, which would drop the weekend all over again even
    // with the Monday-to-Friday filter gone.
    ['Mon, Sep 7', 'Tue, Sep 8', 'Wed, Sep 9', 'Thu, Sep 10', 'Fri, Sep 11', 'Sat, Sep 12', 'Sun, Sep 13']
      .forEach(label => expect(screen.getByText(label)).toBeInTheDocument());

    expect(screen.getAllByTitle(availableAt10)).toHaveLength(7);
  });

  it('draws exactly one header cell per day column', () => {
    // A TRUNCATED span on purpose. On a full seven-day week the day list and
    // the drawn window are the same array, so this assertion held no matter
    // which of the two the header row was built from - and building it from the
    // untruncated list is exactly the drift the comment below describes.
    const { container } = renderGrid([sessionOn(MONDAY), sessionOn('2026-09-21')]);

    // The sticky header row and the columns beneath it are built from two
    // separate passes over the day list. They have to stay the same length or
    // the headers sit over the wrong days, which reads as sessions being on
    // days they are not - the participant books the wrong slot.
    expect(container.querySelectorAll('.calendar-day-header-cell')).toHaveLength(7);
    expect(container.querySelectorAll('.calendar-day-column')).toHaveLength(7);
  });

  it('sizes the header grid and the day columns identically', () => {
    // Truncated for the same reason as the test above: on a full week both
    // grids compute the same numbers from either list.
    const { container } = renderGrid([sessionOn(MONDAY), sessionOn('2026-09-21')]);

    const headerGrid = container.querySelector('.calendar-day-header-cell')!.parentElement!;
    const columnsGrid = container.querySelector('.calendar-day-column')!.parentElement!;

    // Two independently written style objects on two grids that have to line up
    // down the page. Same gutter and same floor, or the headers drift off their
    // columns as soon as the viewport is narrow enough for the floor to bite.
    expect(headerGrid.style.gap).toBe(columnsGrid.style.gap);
    expect(headerGrid.style.gridTemplateColumns).toBe(columnsGrid.style.gridTemplateColumns);
    expect(headerGrid.style.minWidth).toBe(
      (container.querySelector('.calendar-days-container') as HTMLElement).style.minWidth
    );
  });

  it('keeps a full seven-column week inside the panel it is rendered in', () => {
    /**
     * The grid sits in a .mission-glass-panel inside .container. At the widest
     * the container goes (--container-max-width 1200px, --container-padding
     * 20px a side) and the panel's own 32px of padding, that leaves 1096px.
     *
     * Left of the day columns sit a 90px time axis and the 24px flex gap
     * separating it from them, so the columns' declared minimum has to fit in
     * what is left. A first pass at this used a 140px column minimum, which
     * needs 1166px and would have pushed a seven-column week straight off the
     * edge of the card - the sort of thing that only shows up on a real screen
     * with a weekend session on it, which is to say months later.
     */
    const PANEL_CONTENT_WIDTH_PX = 1200 - 2 * 20 - 2 * 32;
    const TIME_AXIS_PX = 90 + 24;

    const week = [MONDAY, '2026-09-08', '2026-09-09', '2026-09-10', FRIDAY, SATURDAY, SUNDAY];
    const { container } = renderGrid(week.map(day => sessionOn(day)));

    const daysContainer = container.querySelector('.calendar-days-container') as HTMLElement;
    const declaredMin = parseInt(daysContainer.style.minWidth, 10);

    expect(declaredMin).toBeGreaterThan(0);
    expect(TIME_AXIS_PX + declaredMin).toBeLessThanOrEqual(PANEL_CONTENT_WIDTH_PX);
  });

  it('leaves each of seven columns wide enough for the widest slot label', () => {
    /**
     * The floor is not a round number someone liked - it is there so the grid
     * stops shrinking before a slot label starts overflowing its slot. The
     * label is `white-space: nowrap`, so it does not truncate politely.
     *
     * 112.5px is the widest label measured in the 11px/600 stack the CSS sets:
     * a session crossing noon, where formatTimeRange has to print both
     * meridiems ("11:30 AM - 12:30 PM"). The slot is inset 6px each side.
     *
     * A floor that counts the columns but forgets the gutters between them
     * passes every other check here while leaving the columns ~14px narrower
     * than this, which is a clipped label on the narrowest supported screen.
     */
    const WIDEST_SLOT_LABEL_PX = 112.5;
    // 6px each side PLUS the 1px border every slot variant carries, against a
    // border-box slot. Counting only the 6px left the floor 2px under the label
    // it was measured against, and `.calendar-slot` is `overflow: hidden`, so
    // the failure is a CLIPPED time rather than a visibly overflowing one - a
    // truncated time reads as a real time.
    const SLOT_INSET_PX = 14;

    const week = [MONDAY, '2026-09-08', '2026-09-09', '2026-09-10', FRIDAY, SATURDAY, SUNDAY];
    const { container } = renderGrid(week.map(day => sessionOn(day)));

    const columnsGrid = container.querySelector('.calendar-day-column')!.parentElement as HTMLElement;
    const daysContainer = container.querySelector('.calendar-days-container') as HTMLElement;

    const gap = parseInt(columnsGrid.style.gap, 10);
    const declaredMin = parseInt(daysContainer.style.minWidth, 10);
    const widthPerColumn = (declaredMin - 6 * gap) / 7;

    expect(widthPerColumn).toBeGreaterThanOrEqual(WIDEST_SLOT_LABEL_PX + SLOT_INSET_PX);
  });

  it('marks a weekend column as today when today is that weekend day', () => {
    // todayColumnIndex is matched against the index of a rendered column. If it
    // is derived from a different list than the one rendered it can point at
    // the wrong column, or at no column while still lighting the Now indicator.
    pinClockTo(`${SATURDAY}T09:00:00`);
    renderGrid([sessionOn(FRIDAY), sessionOn(SATURDAY)]);

    const saturdayHeading = screen.getByText('Sat, Sep 12');
    expect(saturdayHeading).toHaveTextContent('Today');
    expect(screen.getByText('Fri, Sep 11')).not.toHaveTextContent('Today');
  });

  it('says so when a span is too long to show rather than dropping days silently', () => {
    // Two Mondays a fortnight apart. The grid can only show a bounded window,
    // but the days outside it must be announced, not disappeared.
    renderGrid([sessionOn(MONDAY), sessionOn('2026-09-21')]);

    // BOTH bookable days survive the cut - the window spends its budget on the
    // days that have sessions and only then on the empty ones between them.
    expect(screen.getByText('Mon, Sep 7')).toBeInTheDocument();
    expect(screen.getByText('Mon, Sep 21')).toBeInTheDocument();
    expect(screen.getAllByTitle(availableAt10)).toHaveLength(2);

    // Four empty weekdays did not fit. The exact count is asserted, not just
    // that a notice exists: an under-reporting notice is the same silence it
    // was written to replace.
    expect(screen.getByRole('status')).toHaveTextContent(/4 later days are not shown/i);
    expect(screen.getByRole('status')).toHaveTextContent(/none of which have sessions/i);
  });

  it('never spends a column on an empty day while a bookable day goes unshown', () => {
    // The regression this guards is the original defect wearing a third hat.
    // A fortnightly Saturday opportunity spans Sat 12 to Sat 26; every day
    // between is a weekday, and weekdays earn a column whether or not they hold
    // anything. Taking the first seven days IN DATE ORDER therefore filled the
    // grid with six empty weekdays and truncated the second bookable Saturday -
    // a session the participant could book, invisible, with the whole budget
    // spent on days carrying nothing.
    renderGrid([sessionOn(SATURDAY), sessionOn('2026-09-26')]);

    expect(screen.getByText('Sat, Sep 12')).toBeInTheDocument();
    expect(screen.getByText('Sat, Sep 26')).toBeInTheDocument();
    expect(screen.getAllByTitle(availableAt10)).toHaveLength(2);
    // And nothing with sessions is left behind.
    expect(screen.getByRole('status')).toHaveTextContent(/none of which have sessions/i);
  });

  it('draws the Now indicator when today is one of the drawn columns', () => {
    pinClockTo('2026-09-09T09:00:00');
    renderGrid([sessionOn(MONDAY), sessionOn('2026-09-21')]);

    expect(screen.getByText('NOW')).toBeInTheDocument();
  });

  it('does not draw the Now indicator when today falls outside the drawn columns', () => {
    // Wednesday 16 Sep is day eight of this span, so it is one of the days the
    // window cannot fit. The indicator is drawn across the whole grid and means
    // "this line is the time, here, today" - drawing it over a week that does
    // not contain today puts every slot on the wrong side of the current time.
    //
    // This is what goes wrong if the index is searched over every day in range
    // rather than the drawn ones: no column matches, so nothing is badged
    // Today, but the index is still >= 0 and the line is still drawn.
    pinClockTo('2026-09-16T09:00:00');
    renderGrid([sessionOn(MONDAY), sessionOn('2026-09-21')]);

    expect(screen.queryByText('NOW')).not.toBeInTheDocument();
  });
});
