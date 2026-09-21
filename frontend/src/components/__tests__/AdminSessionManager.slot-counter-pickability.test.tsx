import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
 * `isAllocated` gets a DIRECT unit test, and a full-render arm only in the
 * mixed-day suite at the bottom. A lone session cannot reach that branch in
 * a full render: `protectedSlotKeys` injects every session's own exact time
 * as a slot `pruneOverlaps` prefers, so the overlapping generated cell is
 * pruned first (an earlier full-render arm here kept passing with the branch
 * mutated away, because its "allocated" session was excluding the cell via
 * `isExistingSession` instead). Two sessions overlapping each other DO reach
 * it - see the 14:00/14:15 pair in the mixed-day fixture.
 *
 * `isExistingSession` and `confirmedSlots` also get direct arms each: in a
 * saved study one is derived from the other, so a full render with sessions
 * cannot tell them apart. The temporary-study suite is the rendered path
 * where only `confirmedSlots` excludes a cell.
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

describe('isSlotPickable - the existing-session and confirmed exclusions, each alone (#135)', () => {
  // In a full render with a saved study, `confirmedSlots` is derived from
  // `sessions`, so the two checks agree and either one masks the other's
  // removal. Direct calls give each its own arm.
  const events: never[] = [];

  it('excludes a slot that exactly matches a session, with confirmedSlots empty', () => {
    const slot = slotAt(day, 12, 0);
    const session = sessionRow('exact-1', slot.start, slot.end);

    expect(isSlotPickable(slot, events, [session], new Set<string>())).toBe(false);
  });

  it('excludes a slot held only in confirmedSlots, with no session anywhere', () => {
    const slot = slotAt(day, 12, 0);

    expect(isSlotPickable(slot, events, [], new Set([`${slot.start}|${slot.end}`]))).toBe(false);
  });
});

describe('AdminSessionManager - a temporary study restores confirmed slots with no sessions (#135)', () => {
  // The one real path where `confirmedSlots` and `sessions` disagree: a new
  // (temporary) study has sessions=[] and restores its confirmed slots from
  // sessionStorage, so only the `confirmedSlots` check can exclude the cell.
  it('Table view: a confirmed-but-unsaved cell is neither counted nor offered by Select all', async () => {
    const confirmedCell = slotAt(day, 12, 0);
    mockAvailability([confirmedCell, slotAt(day, 12, 30)]);
    sessionStorage.setItem(
      'confirmedSlots_opp-1',
      JSON.stringify([`${confirmedCell.start}|${confirmedCell.end}`])
    );
    renderManager({ isTemporary: true, sessions: [] });
    await settle();
    await setStartDateToFixedDay();
    await settle();

    expect(await readHeadlineCount()).toBe(1);
    expect(screen.getByRole('button', { name: 'Select all (1)' })).toBeInTheDocument();
  });
});

/**
 * One day carrying every kind of cell at once, so the headline, the per-day
 * Select-all and the chips themselves have to agree on all of them together.
 * `now` is 09:00 and the duration is 30 minutes.
 *
 *   08:00        past                                  - disabled chip
 *   10:00        calendar conflict                     - disabled chip
 *   11:00        session with room                     - "created" chip, not a button
 *   12:00        full session                          - disabled chip
 *   13:10-13:40  odd-length session (the generated
 *                13:00 and 13:30 cells are pruned)     - "created" chip
 *   14:00-14:30  session, overlapped by the next one   - disabled chip (allocated)
 *   14:15-14:45  session overlapping 14:00 - pruned, never drawn
 *   14:30        generated cell overlapped by 14:15    - disabled chip (allocated)
 *   15:00, 15:30 genuinely free                        - the only two pickable
 *
 * The 14:00/14:15 pair is what makes the allocated branch reachable in a full
 * render: both are protected, the prune keeps the earlier one, and the 14:30
 * cell abuts 14:00 (kept) while overlapping 14:15 (dropped).
 */
const mixedDayFixture = () => {
  mockAvailability([
    slotAt(day, 8, 0),
    slotAt(day, 10, 0),
    slotAt(day, 11, 0),
    slotAt(day, 12, 0),
    slotAt(day, 13, 0),
    slotAt(day, 13, 30),
    slotAt(day, 14, 30),
    slotAt(day, 15, 0),
    slotAt(day, 15, 30),
  ]);
  vi.mocked(getMyCalendarEvents).mockResolvedValue([
    {
      id: 'evt-1',
      title: 'Team standup',
      start: at(day, 10, 0).toISOString(),
      end: at(day, 10, 30).toISOString(),
      startTime: at(day, 10, 0),
      endTime: at(day, 10, 30),
      status: 'confirmed',
      attendees: [],
    },
  ] as never);
  const iso = (hour: number, minute = 0) => at(day, hour, minute).toISOString();
  const full = { ...sessionRow('full-1', iso(12), iso(12, 30)), booked_count: 2, remaining: 0 };
  return [
    sessionRow('room-1', iso(11), iso(11, 30)),
    full,
    sessionRow('odd-1', iso(13, 10), iso(13, 40)),
    sessionRow('pair-a', iso(14), iso(14, 30)),
    sessionRow('pair-b', iso(14, 15), iso(14, 45)),
  ];
};

const selectAllSum = () =>
  screen
    .queryAllByRole('button', { name: /^Select all/i })
    .reduce((n, b) => n + Number(b.textContent!.match(/\((\d+)\)/)![1]), 0);

const chipGroups = () => screen.getAllByRole('group', { name: /^Slots on/ });

/** Chips a click would newly select: enabled, not already on. */
const offeredChips = () =>
  chipGroups().flatMap(group =>
    within(group)
      .queryAllByRole('button')
      .filter(b => !(b as HTMLButtonElement).disabled && b.getAttribute('aria-pressed') === 'false')
  );

const renderMixedTable = async () => {
  renderManager({ sessions: mixedDayFixture() });
  await settle();
  await setStartDateToFixedDay();
  await settle();
};

describe('AdminSessionManager - headline, Select all and chips agree on a mixed day (#135)', () => {
  it('Table view: the headline equals the sum of the per-day Select all counts', async () => {
    await renderMixedTable();

    const headline = await readHeadlineCount();
    expect(headline).toBe(2);
    expect(selectAllSum()).toBe(headline);
  });

  it('Table view: every counted slot is an enabled chip and every uncounted chip is not offered', async () => {
    await renderMixedTable();

    const headline = await readHeadlineCount();
    const offered = offeredChips();
    expect(offered).toHaveLength(headline);
    offered.forEach(chip => expect(chip.getAttribute('title')).toMatch(/Available time slot$/));

    // Every other chip is either a disabled button or a non-interactive
    // created-session marker - nothing uncounted is clickable.
    const allChips = chipGroups().flatMap(group => [
      ...within(group).queryAllByRole('button'),
      ...within(group).queryAllByRole('img'),
    ]);
    const rest = allChips.filter(chip => !offered.includes(chip));
    rest.forEach(chip => {
      const isDisabledButton = chip.tagName === 'BUTTON' && (chip as HTMLButtonElement).disabled;
      const isCreatedMarker = chip.getAttribute('role') === 'img';
      expect(isDisabledButton || isCreatedMarker).toBe(true);
    });

    // The five blocked cells by kind, so a failure says which one drifted:
    // past, conflict, the 14:30 allocated cell, the full 12:00 session and
    // the 14:00 session (room left, but overlapped by 14:15 - its tooltip
    // leads with the session, so it reads as one).
    const disabledTitles = rest
      .filter(chip => chip.tagName === 'BUTTON')
      .map(chip => chip.getAttribute('title') ?? '');
    expect(disabledTitles).toHaveLength(5);
    expect(disabledTitles.filter(t => /in the past/.test(t))).toHaveLength(1);
    expect(disabledTitles.filter(t => /conflicts with existing calendar events/.test(t))).toHaveLength(1);
    expect(disabledTitles.filter(t => /allocated to another study/.test(t))).toHaveLength(1);
    expect(disabledTitles.filter(t => / 0 remaining$/.test(t))).toHaveLength(1);
    expect(disabledTitles.filter(t => / 2 remaining$/.test(t))).toHaveLength(1);
  });

  it('Table view: the counters follow a sessions change after first render', async () => {
    mockAvailability([slotAt(day, 12, 0), slotAt(day, 12, 30), slotAt(day, 13, 0)]);
    const props = {
      opportunityId: 'opp-1',
      onSessionsChange: vi.fn(),
      defaultDurationMinutes: 30,
    };
    const { rerender } = render(
      <MemoryRouter>
        <AdminSessionManager {...props} sessions={[]} />
      </MemoryRouter>
    );
    await settle();
    await setStartDateToFixedDay();
    await settle();
    expect(await readHeadlineCount()).toBe(3);
    expect(selectAllSum()).toBe(3);

    const added = sessionRow('late-1', at(day, 12, 30).toISOString(), at(day, 13, 0).toISOString());
    rerender(
      <MemoryRouter>
        <AdminSessionManager {...props} sessions={[added]} />
      </MemoryRouter>
    );
    await settle();

    expect(await readHeadlineCount()).toBe(2);
    expect(selectAllSum()).toBe(2);
    expect(offeredChips()).toHaveLength(2);
  });
});
