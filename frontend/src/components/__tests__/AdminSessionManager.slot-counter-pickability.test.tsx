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
/**
 * The mixed day's availability, named separately so the gutter arm below can
 * render the same day with two extra undrawable cells without re-stating it.
 */
const mixedDaySlots = () => [
  slotAt(day, 8, 0),
  slotAt(day, 10, 0),
  slotAt(day, 11, 0),
  slotAt(day, 12, 0),
  slotAt(day, 13, 0),
  slotAt(day, 13, 30),
  slotAt(day, 14, 30),
  slotAt(day, 15, 0),
  slotAt(day, 15, 30),
];

const mixedDayFixture = () => {
  mockAvailability(mixedDaySlots());
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

  /**
   * The Calendar grid's TILE, not the counter - the symmetric twin of the
   * Table chip arm above. `describeSlot`'s `isPast` is pinned for the chip by
   * the canary entry `session-management-chip-disables-past-cells`; the tile
   * drew the same rule from its own inline copy, and dropping the past term
   * from that copy alone passed the whole AdminSessionManager suite as it
   * then stood. Both now
   * go through `slotIsActionable`, and this arm is what notices if the tile
   * re-hand-rolls it.
   */
  it('Calendar view: a past tile is aria-disabled and not focusable', async () => {
    renderManager({ sessions: mixedDayFixture() });
    await settle();
    await setStartDateToFixedDay();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    await settle();

    // 08:00 is before "now" with nothing else wrong with it, so it is the one
    // cell `describeSlot` reports as past. The server refuses a past start
    // (#101), so the tile must take neither a click nor a keyboard stop.
    const pastTile = screen.getByRole('button', { name: /in the past and cannot be scheduled/ });
    expect(pastTile).toHaveAttribute('aria-disabled', 'true');
    expect(pastTile).toHaveAttribute('tabindex', '-1');

    // Control: the assertion above passes just as well if the grid stopped
    // drawing tiles as buttons at all, so the two genuinely pickable cells
    // (15:00 and 15:30, the same two the headline counts) must still be
    // focusable and not aria-disabled in the same render.
    const pickableTiles = screen.getAllByRole('button', { name: /Available time slot/ });
    expect(pickableTiles).toHaveLength(2);
    pickableTiles.forEach(tile => {
      expect(tile).not.toHaveAttribute('aria-disabled');
      expect(tile).toHaveAttribute('tabindex', '0');
    });
  });

  /**
   * The OTHER half of `slotIsActionable`: the tiles that must stay clickable
   * although the counters exclude them, and the gutter row that draws the
   * same rule a second time.
   *
   * `slotIsActionable` is deliberately more lenient than `isSlotPickable` -
   * an existing session WITH ROOM, and a confirmed slot, are out of "N slots
   * available" but must still take a click, because that click is the
   * deselect cto/AdaptaLabs#95's gutter removal depends on. Nothing pinned
   * that in the whole frontend. MEASURED on this branch: rewriting the
   * timeline tile as
   * `actionable = isSlotPickable(slot, events, sessions, confirmedSlots)`
   * left all 2551 frontend tests green - the whole frontend suite as it stood
   * before this arm, measured 2026-09-21 - while a DOM census showed it setting
   * `tabIndex` -1 and `aria-disabled` on the 11:00 and 13:10 tiles. Silent,
   * and a behaviour change rather than a tidy-up.
   *
   * The GUTTER tile - slots outside the 07:00-23:00 timeline, drawn in their
   * own row beneath it - had no test at all, so re-hand-rolling it as
   * `!status.isBlocked` (the exact defect shape this branch fixed on the
   * timeline tile, dropping the past term) was invisible too. The 06:00 cell
   * is past AND undrawable, so it lands in the gutter and must refuse a
   * click there as well; the 23:30 cell is the control that proves the
   * gutter still draws focusable tiles at all, rather than none.
   */
  it('Calendar view: a session with room stays clickable and the gutter obeys the same rule', async () => {
    const sessions = mixedDayFixture();
    // The mixed day, plus the two cells the gutter row exists for: 06:00
    // starts before TIMELINE_START_HOUR and 23:30-00:30 ends past
    // TIMELINE_END_HOUR, so neither is drawable on the grid.
    mockAvailability([slotAt(day, 6, 0), ...mixedDaySlots(), slotAt(day, 23, 30)]);
    const { container } = renderManager({ sessions });
    await settle();
    await setStartDateToFixedDay();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    await settle();

    // 11:00 and 13:10 are existing sessions with room left, so `isSlotPickable`
    // excludes both - deriving the tile from it takes the deselect away.
    const withRoom = [
      screen.getByRole('button', { name: '11:00 to 11:30 - Session: 2 capacity, 0 booked, 2 remaining' }),
      screen.getByRole('button', { name: '13:10 to 13:40 - Session: 2 capacity, 0 booked, 2 remaining' }),
    ];
    withRoom.forEach(tile => {
      expect(tile).not.toHaveAttribute('aria-disabled');
      expect(tile).toHaveAttribute('tabindex', '0');
    });

    // Control, so the pair above cannot pass by the grid simply making every
    // tile focusable: 14:00 also has room, but is overlapped by the 14:15
    // session, so `isBlocked` holds and the tile must refuse the click.
    const allocatedSession = screen.getByRole('button', {
      name: '14:00 to 14:30 - Session: 2 capacity, 0 booked, 2 remaining',
    });
    expect(allocatedSession).toHaveAttribute('aria-disabled', 'true');
    expect(allocatedSession).toHaveAttribute('tabindex', '-1');

    // The gutter row. Queried by class because these tiles carry `title`
    // rather than `aria-label`, so their accessible name is the time label.
    const gutterTiles = Array.from(container.querySelectorAll('.calendar-gutter-slot'));
    const titleOf = (el: Element) => el.getAttribute('title') ?? '';
    expect(gutterTiles.map(titleOf).sort()).toEqual([
      '06:00 to 06:30 - This time is in the past and cannot be scheduled',
      '23:30 to 00:00 - Available time slot',
    ]);

    const pastGutterTile = gutterTiles.find(el => /in the past/.test(titleOf(el)))!;
    expect(pastGutterTile).toHaveAttribute('aria-disabled', 'true');
    expect(pastGutterTile).toHaveAttribute('tabindex', '-1');

    // Control again: the free undrawable cell in the same row stays clickable,
    // which is the entire reason the gutter row was added.
    const freeGutterTile = gutterTiles.find(el => /Available time slot/.test(titleOf(el)))!;
    expect(freeGutterTile).not.toHaveAttribute('aria-disabled');
    expect(freeGutterTile).toHaveAttribute('tabindex', '0');
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
