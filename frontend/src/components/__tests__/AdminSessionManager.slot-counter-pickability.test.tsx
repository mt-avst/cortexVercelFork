import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import AdminSessionManager, { isSlotPickable } from '../AdminSessionManager';
import { getAvailability, getMyCalendarEvents } from '../../api/client';

/**
 * cto/AdaptaLabs#135. `drawnSlots` (Calendar view) and `tableSlotCount`
 * (Table view) excluded only a calendar-conflict cell, not an allocated,
 * confirmed/existing-session, or past one - so a researcher on either view
 * could see an inflated "N slots available" that counted cells the grid
 * would refuse to hand out. Both counters now route through the shared
 * `isSlotPickable` predicate (module scope in AdminSessionManager.tsx).
 * `describeSlot` inside `CalendarView` is a SEPARATE, deliberately more
 * lenient implementation, not backed by this predicate - see the docblock on
 * `isSlotPickable` itself.
 *
 * Each exclusion below gets its OWN arm, isolated from the other three, so a
 * single mutation removing any one of them fails a test BY NAME. An earlier
 * version of this fixture put the allocated and confirmed cells before
 * "now" alongside the past cell - so `slotIsPast` alone excluded all three,
 * and deleting the `confirmedSlots`/`isExistingSession`/`isAllocated` checks
 * individually was invisible to the whole 17-file, 110-test
 * `AdminSessionManager*` suite. Confirmed by a code-reviewer gate that
 * removed each exclusion in turn and ran the suite.
 *
 * `isAllocated` gets a DIRECT unit test rather than a full-render arm like
 * the other three: a full render cannot reach that branch at all (see the
 * comment on `isAllocated` itself), because `protectedSlotKeys` injects every
 * session's own exact time as a slot `pruneOverlaps` prefers, and the
 * overlapping generated cell `isAllocated` would have flagged is the exact
 * one `pruneOverlaps` already dropped in favour of it - proven by hand below
 * (a full-render arm claiming to isolate `isAllocated` kept passing with that
 * branch mutated away, because the fixture's "allocated" session was silently
 * excluding the cell via `isExistingSession` instead).
 *
 * System time is pinned (`Date` only - real timers stay real) so a slot's
 * past/future-ness does not depend on the wall-clock hour the suite runs at.
 */

const toDateInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// A weekday, well clear of "today" so the default Start/End Date range never
// interferes, and never itself a weekend (the picker excludes weekends by
// default).
const fixedWeekday = () => {
  const d = new Date();
  d.setDate(d.getDate() + 10);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
};

const at = (day: Date, hour: number, minute = 0) => {
  const d = new Date(day);
  d.setHours(hour, minute, 0, 0);
  return d;
};

const slotAt = (day: Date, hour: number, minute = 0, durationMinutes = 30) => {
  const start = at(day, hour, minute);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString(), duration_minutes: durationMinutes };
};

const sessionRow = (id: string, startIso: string, endIso: string, capacity = 2) => ({
  id,
  opportunity_id: 'opp-1',
  start_time: startIso,
  end_time: endIso,
  capacity,
  booked_count: 0,
  remaining: capacity,
  location_or_meet_link_optional: '',
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
});

vi.mock('../../api/client', () => ({
  getAvailability: vi.fn(),
  getMyCalendarEvents: vi.fn(),
  createSessions: vi.fn(async () => []),
  deleteSession: vi.fn(async () => undefined),
  deleteAllSessions: vi.fn(async () => undefined),
}));

vi.mock('../../utils/navigation', () => ({
  navigation: { toAdmin: vi.fn() },
}));

type ManagerProps = React.ComponentProps<typeof AdminSessionManager>;

const renderManager = (props: Partial<ManagerProps> = {}) =>
  render(
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

// `now` is 09:00 on the fixed day. Every excluded cell below is placed AFTER
// `now`, except the one dedicated past cell (08:00) - so past-ness never
// piggy-backs on, or masks, any of the other three exclusions.
const day = fixedWeekday();
const now = at(day, 9, 0);

const setStartDateToFixedDay = async () => {
  const input = (await screen.findByLabelText('Start Date')) as HTMLInputElement;
  fireEvent.change(input, { target: { value: toDateInput(day) } });
};

const readHeadlineCount = async () => {
  const headline = await screen.findByText(/\d+ slots available/i);
  return Number(headline.textContent!.match(/(\d+) slots available/i)![1]);
};

const mockAvailability = (slots: ReturnType<typeof slotAt>[]) => {
  vi.mocked(getAvailability).mockResolvedValue({
    available_slots: slots,
    total_slots: slots.length,
    duration_minutes: 30,
    time_range: { start: slots[0].start, end: slots[slots.length - 1].end },
  } as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  vi.mocked(getMyCalendarEvents).mockResolvedValue([] as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AdminSessionManager - isSlotPickable exclusions, isolated one at a time (#135)', () => {
  it('excludes a past cell, and nothing else', async () => {
    // 08:00 is before "now" (09:00); 12:30 has nothing wrong with it.
    mockAvailability([slotAt(day, 8, 0), slotAt(day, 12, 30)]);
    renderManager();
    await settle();
    await setStartDateToFixedDay();
    await settle();

    expect(await readHeadlineCount()).toBe(1);
  });

  it('excludes a calendar-conflict cell, and nothing else', async () => {
    mockAvailability([slotAt(day, 11, 0), slotAt(day, 12, 30)]);
    vi.mocked(getMyCalendarEvents).mockResolvedValue([
      {
        id: 'evt-1',
        title: 'Team standup',
        start: at(day, 11, 0).toISOString(),
        end: at(day, 11, 30).toISOString(),
        startTime: at(day, 11, 0),
        endTime: at(day, 11, 30),
        status: 'confirmed',
        attendees: [],
      },
    ] as never);
    renderManager();
    await settle();
    await setStartDateToFixedDay();
    await settle();

    expect(await readHeadlineCount()).toBe(1);
  });

  it('excludes an existing/confirmed session cell (exact match), and nothing else', async () => {
    mockAvailability([slotAt(day, 12, 0), slotAt(day, 12, 30)]);
    const confirmed = sessionRow('conf-1', at(day, 12, 0).toISOString(), at(day, 12, 30).toISOString());
    renderManager({ sessions: [confirmed] });
    await settle();
    await setStartDateToFixedDay();
    await settle();

    expect(await readHeadlineCount()).toBe(1);
  });
});

describe('isSlotPickable - the isAllocated branch, direct (#135)', () => {
  // Bypasses the whole component and its pruning pipeline on purpose: see the
  // module docblock above for why a full render cannot isolate this branch.
  const events: never[] = [];
  const confirmedSlots = new Set<string>();

  it('excludes a slot overlapped by another session at a non-exact boundary, and nothing else', () => {
    const slot = slotAt(day, 11, 30);
    const overlapping = sessionRow(
      'alloc-1',
      at(day, 11, 30).toISOString(),
      new Date(at(day, 11, 30).getTime() + 15 * 60 * 1000).toISOString()
    );

    expect(isSlotPickable(slot, events, [overlapping], confirmedSlots)).toBe(false);
  });

  it('does not exclude a slot the same session merely abuts', () => {
    const slot = slotAt(day, 12, 0);
    // Ends exactly as `slot` starts - adjacent, not overlapping.
    const abutting = sessionRow('abut-1', at(day, 11, 0).toISOString(), at(day, 12, 0).toISOString());

    expect(isSlotPickable(slot, events, [abutting], confirmedSlots)).toBe(true);
  });

  it('does not exclude a slot with no session anywhere near it', () => {
    const slot = slotAt(day, 12, 30);

    expect(isSlotPickable(slot, events, [], confirmedSlots)).toBe(true);
  });
});

describe('AdminSessionManager - all four exclusions together, and the two views agree (#135)', () => {
  // 08:00 past, 11:00 conflict, 11:30 & 12:00 existing-session exclusions
  // (11:30's session overlaps non-exactly, but see the note above: pruning
  // turns it into an exact-match existing-session cell before the counter
  // ever filters it), 12:30 the one genuinely pickable cell. Every excluded
  // cell has a distinct SOURCE (a different session or event), even though
  // two of them resolve through the same `isExistingSession` check.
  const buildFixture = () => {
    mockAvailability([
      slotAt(day, 8, 0),
      slotAt(day, 11, 0),
      slotAt(day, 11, 30),
      slotAt(day, 12, 0),
      slotAt(day, 12, 30),
    ]);
    vi.mocked(getMyCalendarEvents).mockResolvedValue([
      {
        id: 'evt-1',
        title: 'Team standup',
        start: at(day, 11, 0).toISOString(),
        end: at(day, 11, 30).toISOString(),
        startTime: at(day, 11, 0),
        endTime: at(day, 11, 30),
        status: 'confirmed',
        attendees: [],
      },
    ] as never);
    const allocated = sessionRow(
      'alloc-1',
      at(day, 11, 30).toISOString(),
      new Date(at(day, 11, 30).getTime() + 15 * 60 * 1000).toISOString()
    );
    const confirmed = sessionRow('conf-1', at(day, 12, 0).toISOString(), at(day, 12, 30).toISOString());
    return [allocated, confirmed];
  };

  it('Table view: counts only the one genuinely pickable cell', async () => {
    const sessions = buildFixture();
    renderManager({ sessions });
    await settle();
    await setStartDateToFixedDay();
    await settle();

    expect(await readHeadlineCount()).toBe(1);
  });

  it('Calendar (grid) view: same exclusions, same count', async () => {
    const sessions = buildFixture();
    renderManager({ sessions });
    await settle();
    await setStartDateToFixedDay();
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    await settle();

    expect(await readHeadlineCount()).toBe(1);
  });
});
