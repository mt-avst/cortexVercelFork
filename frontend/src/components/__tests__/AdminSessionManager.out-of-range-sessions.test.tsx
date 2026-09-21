import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { getAvailability, deleteSession } from '../../api/client';

/**
 * cto/AdaptaLabs#95 - a session the timeline cannot place must still be
 * removable.
 *
 * The grid draws 07:00-23:00 and `getTimePosition` clamps, so a 06:00 session
 * rendered at height ~0.01% on the top edge: in the DOM, counted, and
 * impossible to click. The per-slot click is the ONLY per-session removal on
 * this screen - Table view is read-only and Reset All refuses outright once
 * anything is booked - so those sessions were stuck there permanently.
 *
 * The entry gate added in !298 refuses new ones, but says nothing about the
 * ones already in the database: the create routes carry no hour bound, and
 * cannot sensibly carry one, because the drawable window is the VIEWER's local
 * 07:00-23:00 and a session legitimate in Sydney is out of range in London.
 *
 * WHY NOT "click it and see": jsdom has no layout, so a zero-height div is as
 * clickable in a test as a full-size one. `fireEvent.click` on the old sliver
 * passed. These tests therefore assert the GEOMETRY that decides clickability
 * in a browser, and the placement that produces it.
 */

vi.mock('../../api/client', () => ({
  getAvailability: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  createSessions: vi.fn(async () => []),
  deleteSession: vi.fn(async () => undefined),
  deleteAllSessions: vi.fn(async () => undefined),
}));

vi.mock('../../utils/navigation', () => ({
  navigation: { toAdmin: vi.fn() },
}));

type ManagerProps = React.ComponentProps<typeof AdminSessionManager>;

const renderManager = (props: Partial<ManagerProps> = {}) => {
  const utils = render(
    <MemoryRouter>
      <AdminSessionManager
        opportunityId="opp-1"
        sessions={[]}
        onSessionsChange={vi.fn()}
        defaultDurationMinutes={30}
        {...props}
      />
    </MemoryRouter>
  );
  // Row 6: the session list is the default view now. These suites exercise the
  // calendar grid (and its manual-entry panel), so switch to it up front -
  // which also proves the segmented Calendar/Table toggle swaps the view.
  fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
  return utils;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

/** A weekday, because weekend columns are suppressed by default. */
const futureWeekday = (minDaysAhead = 3) => {
  const d = new Date();
  d.setDate(d.getDate() + minDaysAhead);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
};

const sessionAt = (id: string, hour: number, minute: number, durationMinutes = 30) => {
  const start = new Date(futureWeekday(3));
  start.setHours(hour, minute, 0, 0);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  return {
    id,
    opportunity_id: 'opp-1',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    capacity: 1,
    booked_count: 0,
    remaining: 1,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
};

const pad = (n: number) => String(n).padStart(2, '0');
const labelFor = (hour: number, minute: number, durationMinutes = 30) => {
  const endMinutes = hour * 60 + minute + durationMinutes;
  return (
    `${pad(hour)}:${pad(minute)} - ` +
    `${pad(Math.floor(endMinutes / 60) % 24)}:${pad(endMinutes % 60)}`
  );
};

/**
 * Every drawn slot whose inline height is too small to be a click target.
 *
 * This is the defect made measurable. The `is it below 1%` threshold is
 * generous: the clamped slivers measured ~0.01% of a 900px column, which is a
 * tenth of a pixel.
 */
const unclickablySmallSlots = () =>
  Array.from(document.querySelectorAll('.calendar-slot')).filter((element) => {
    const height = (element as HTMLElement).style.height;
    return height.endsWith('%') && parseFloat(height) < 1;
  });

const slotElementFor = (label: string) => {
  const labelElement = screen.getByText(label);
  const slot = labelElement.closest('.calendar-slot');
  if (!slot) throw new Error(`No slot element around the label ${label}`);
  return slot as HTMLElement;
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  // An empty generated grid: these tests are about what the SESSIONS prop puts
  // on screen, and a generated grid would only add slots to count around.
  vi.mocked(getAvailability).mockImplementation(async () => ({
    available_slots: [],
    total_slots: 0,
    duration_minutes: 30,
    time_range: { start: new Date().toISOString(), end: new Date().toISOString() },
  }));
});

describe('AdminSessionManager - a session outside the drawn hours (#95)', () => {
  it.each([
    ['before the timeline starts', 6, 0],
    ['after the timeline ends', 23, 45],
  ])('draws one %s in the gutter row, at full size', async (_name, hour, minute) => {
    renderManager({ sessions: [sessionAt(`s-${hour}${minute}`, hour, minute)] });
    await settle();

    const label = labelFor(hour, minute);
    const slot = slotElementFor(label);

    // In the gutter, NOT positioned on the timeline. The two are mutually
    // exclusive by construction, and asserting both ways round is what fails
    // if the partition is inverted rather than merely dropped.
    expect(slot.className).toContain('calendar-gutter-slot');
    expect(slot.className).not.toContain('position-absolute');
    expect(slot.style.height).toBe('');
    expect(slot.closest('.calendar-gutter-row')).not.toBeNull();

    // And nothing anywhere is drawn at a height nobody could hit.
    expect(unclickablySmallSlots()).toHaveLength(0);
  });

  it('offers the gutter session to the keyboard as well as the mouse', async () => {
    renderManager({ sessions: [sessionAt('s-0600', 6, 0)] });
    await settle();

    const slot = slotElementFor(labelFor(6, 0));
    expect(slot.getAttribute('role')).toBe('button');
    expect(slot.getAttribute('tabindex')).toBe('0');
  });

  it('removes it when it is clicked, which is the whole point', async () => {
    const onSessionsChange = vi.fn();
    const stuck = sessionAt('s-0600', 6, 0);
    renderManager({ sessions: [stuck], onSessionsChange });
    await settle();

    fireEvent.click(slotElementFor(labelFor(6, 0)));

    // The same removal path a drawable session gets: the row deletes server
    // side and hands the parent the shorter list. A gutter that only displayed
    // would satisfy every placement assertion above and fix nothing.
    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith('s-0600'));
    await waitFor(() => expect(onSessionsChange).toHaveBeenCalledWith([]));
  });

  it('removes it from the keyboard too', async () => {
    const onSessionsChange = vi.fn();
    renderManager({ sessions: [sessionAt('s-2345', 23, 45)], onSessionsChange });
    await settle();

    fireEvent.keyDown(slotElementFor(labelFor(23, 45)), { key: 'Enter' });

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith('s-2345'));
  });

  it.each([
    // The exact edges, both of which read as "outside" to an off-by-one: 07:00
    // is the first drawable instant, and 22:30-23:00 is the last 30-minute slot
    // that ENDS inside the window. A comparison written `<=` or `>=` sends the
    // whole working day's boundary sessions to the gutter, and the middle of
    // the day would never notice.
    ['at the first drawable instant', 7, 0],
    ['ending exactly as the timeline does', 22, 30],
  ])('keeps a session %s on the timeline', async (_name, hour, minute) => {
    renderManager({ sessions: [sessionAt(`s-${hour}${minute}`, hour, minute)] });
    await settle();

    const slot = slotElementFor(labelFor(hour, minute));

    expect(slot.className).toContain('position-absolute');
    expect(slot.className).not.toContain('calendar-gutter-slot');
    expect(document.querySelector('.calendar-gutter-row')).toBeNull();
  });

  it('leaves a session inside the drawn hours exactly where it was', async () => {
    // THE control. A partition that sent everything to the gutter would satisfy
    // every test above and destroy the calendar.
    renderManager({ sessions: [sessionAt('s-1415', 14, 15)] });
    await settle();

    const slot = slotElementFor(labelFor(14, 15));

    expect(slot.className).toContain('position-absolute');
    expect(slot.className).not.toContain('calendar-gutter-slot');
    // 14:15 is 7.25 hours into a 16-hour timeline; a 30-minute slot is 3.125%
    // of it. Positioned, not stacked.
    expect(parseFloat(slot.style.top)).toBeCloseTo(45.3125, 3);
    expect(parseFloat(slot.style.height)).toBeCloseTo(3.125, 3);
    expect(document.querySelector('.calendar-gutter-row')).toBeNull();
  });

  it('detects a slot drawn too small to click, so the absence arms above mean something', async () => {
    // The control on the CONTROL. `unclickablySmallSlots()` returning nothing is
    // only evidence if it can return something: a one-minute session inside the
    // window draws at 0.104% - the same order as the clamped slivers this issue
    // is about - and the detector has to see it.
    renderManager({ sessions: [sessionAt('s-1400-1min', 14, 0, 1)] });
    await settle();

    const tooSmall = unclickablySmallSlots();
    expect(tooSmall).toHaveLength(1);
    expect(parseFloat((tooSmall[0] as HTMLElement).style.height)).toBeLessThan(0.2);
  });

  it('draws the gutter session and the mid-day session exactly once each, not double-drawn', async () => {
    // Was pinned via the "N slots available" headline against
    // `AdminSessionManager.manual-slots.test.tsx`'s counted-equals-drawn
    // equality. cto/AdaptaLabs#135 moved that headline onto `isSlotPickable`,
    // which - like the historical D11 `gridBookableCount` it restores - counts
    // an existing session as NOT "available" (it is booked capacity, not open
    // capacity), so the headline no longer includes either session here and
    // cannot stand in for "drawn once" any more on its own. Assert the DOM
    // directly for that property instead: it fails BOTH ways this always
    // meant to catch - a gutter row dropped entirely, and one drawn TWICE by
    // a partition that forgot to remove the slot from the timeline.
    renderManager({ sessions: [sessionAt('s-0600', 6, 0), sessionAt('s-1415', 14, 15)] });
    await settle();

    expect(screen.getAllByText(labelFor(6, 0))).toHaveLength(1);
    expect(screen.getAllByText(labelFor(14, 15))).toHaveLength(1);

    // And the headline reads 0, not 2: both are existing sessions, and
    // `isSlotPickable` excludes an existing session unconditionally (row 8 /
    // #135). A regression that stopped excluding them - the exact defect
    // #135 fixed - would read 2 here as it used to.
    const counted = Number(/(\d+) slots available/.exec(document.body.textContent ?? '')?.[1]);
    expect(counted).toBe(0);
  });
});
