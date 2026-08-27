import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { createSessions, getAvailability } from '../../api/client';
import type { CreateSessionRequest } from '../../api/types';

/**
 * cto/AdaptaLabs#89 item 2 - authoring must not depend on the calendar.
 *
 * The generated availability grid can only express starts that land on a
 * duration boundary from 07:00 UTC, and it arrives from an endpoint. A slot
 * typed in by hand depends on neither.
 */

/**
 * A REALISTIC generated grid: contiguous :00/:30 slots across the working day,
 * which is what `/api/calendar/availability` actually returns.
 *
 * The first version of this suite mocked `available_slots: []` for every test.
 * That made it structurally incapable of noticing the one defect that mattered:
 * `removeOverlappingSlots` sorts by start time and greedily keeps the first
 * non-overlapping slot, so a hand-entered 14:15 always sorts AFTER the
 * generated 14:00-14:30 and was discarded before rendering - while still being
 * selected and still being created. The counter went 20 -> 21, nothing appeared,
 * and Confirm made a session nobody could see. A suite that never puts a
 * generated slot on the grid tests the one state production is never in.
 */
const generatedGridFor = (day: Date, durationMinutes = 30) => {
  const slots = [];
  for (let hour = 8; hour < 18; hour++) {
    for (let minute = 0; minute < 60; minute += durationMinutes) {
      const start = new Date(day);
      start.setHours(hour, minute, 0, 0);
      const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
      slots.push({
        start: start.toISOString(),
        end: end.toISOString(),
        duration_minutes: durationMinutes,
      });
    }
  }
  return slots;
};

vi.mock('../../api/client', () => ({
  getAvailability: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  createSessions: vi.fn(async () => []),
  deleteAllSessions: vi.fn(async () => undefined),
}));

vi.mock('../../utils/navigation', () => ({
  navigation: { toAdmin: vi.fn() },
}));

// Props are typed from the component rather than cast, so an override that
// stops matching the component's contract fails typecheck here instead of
// silently doing nothing at runtime.
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

/**
 * A WEEKDAY at least `minDaysAhead` out.
 *
 * Weekday because weekend columns are suppressed by default, and this suite is
 * measuring the manual control rather than that filter - a fixture that landed
 * on a Saturday would fail on some days of the week and pass on others, which
 * is the worst possible shape for a test.
 */
const futureWeekday = (minDaysAhead = 3) => {
  const d = new Date();
  d.setDate(d.getDate() + minDaysAhead);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
};

// 14:15 - a quarter past, which the 30-minute generated grid (:00 and :30 from
// 07:00 UTC) cannot produce.
const futureDate = () => futureWeekday(3);

const dateInputValue = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const addSlot = (date: Date, time: string) => {
  fireEvent.change(screen.getByLabelText('Add a slot: date'), {
    target: { value: dateInputValue(date) },
  });
  fireEvent.change(screen.getByLabelText('Start time'), { target: { value: time } });
  fireEvent.click(screen.getByRole('button', { name: /Add slot/i }));
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  // Default for every test: the grid production actually serves.
  vi.mocked(getAvailability).mockImplementation(async () => {
    const day = futureWeekday(3);
    const slots = generatedGridFor(day);
    return {
      available_slots: slots,
      total_slots: slots.length,
      duration_minutes: 30,
      time_range: { start: slots[0].start, end: slots[slots.length - 1].end },
    };
  });
});

describe('AdminSessionManager - a slot can be added by hand (#89)', () => {
  it('draws a hand-entered slot the generated grid cannot express', async () => {
    renderManager();
    await settle();

    // The generated grid is already drawn - :00 and :30 - and 14:15 is not on
    // it, which is the whole point of the control.
    expect(await screen.findByText('14:00 - 14:30')).toBeInTheDocument();
    expect(screen.queryByText('14:15 - 14:45')).not.toBeInTheDocument();

    addSlot(futureDate(), '14:15');

    // The hand-entered slot outranks the generated ones it overlaps: it is the
    // researcher's explicit instruction, and they cannot have both.
    expect(await screen.findByText('14:15 - 14:45')).toBeInTheDocument();
    expect(screen.queryByText('14:00 - 14:30')).not.toBeInTheDocument();
  });

  it('creates the hand-entered slot as a real session', async () => {
    const onSessionsChange = vi.fn();
    const created = futureDate();
    renderManager({ onSessionsChange });
    await settle();

    addSlot(created, '14:15');
    await screen.findByText('14:15 - 14:45');

    fireEvent.click(screen.getByRole('button', { name: /Confirm/i }));

    await waitFor(() => expect(createSessions).toHaveBeenCalledTimes(1));

    // The slot reaches the SAME create path the grid uses, at the instants the
    // researcher typed. A control that only painted the grid would satisfy the
    // test above and create nothing.
    const [opportunityId, sessionData] = vi.mocked(createSessions).mock.calls[0];
    expect(opportunityId).toBe('opp-1');
    // createSessions accepts one session or an array; this path always sends an
    // array, and asserting that is part of the contract being pinned.
    expect(Array.isArray(sessionData)).toBe(true);
    const sent = sessionData as CreateSessionRequest[];
    expect(sent).toHaveLength(1);
    const expectedStart = new Date(created);
    expectedStart.setHours(14, 15, 0, 0);
    expect(new Date(sent[0].start_time).getTime()).toBe(expectedStart.getTime());
    expect(new Date(sent[0].end_time).getTime()).toBe(expectedStart.getTime() + 30 * 60 * 1000);
  });

  it('refuses a slot in the past rather than creating an unbookable one', async () => {
    renderManager();
    await settle();

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    addSlot(yesterday, '14:15');

    expect(await screen.findByText(/Choose a time in the future/i)).toBeInTheDocument();
    expect(screen.queryByText('14:15 - 14:45')).not.toBeInTheDocument();
  });

  it('refuses a duplicate of an existing session', async () => {
    const day = futureDate();
    const start = new Date(day);
    start.setHours(14, 15, 0, 0);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    renderManager({
      sessions: [
        {
          id: 'sess-1',
          opportunity_id: 'opp-1',
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          capacity: 1,
          booked_count: 0,
          remaining: 1,
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        },
      ],
    });
    await settle();

    addSlot(day, '14:15');

    // Adding it silently would let the confirm step try to create two sessions
    // at one instant.
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it('moves the visible date range onto a slot beyond it', async () => {
    renderManager();
    await settle();

    // The grid only draws days between startDate and endDate, and paginates
    // them five at a time. A slot three weeks out was addable, selectable,
    // creatable - and on page four, which is just as invisible as being out of
    // range. Widening alone did not fix this; the window has to move.
    const farOut = futureWeekday(21);
    addSlot(farOut, '14:15');

    expect(await screen.findByText('14:15 - 14:45')).toBeInTheDocument();
  });

  it('will not add a slot with no duration chosen', async () => {
    renderManager({ defaultDurationMinutes: undefined });
    await settle();

    // A slot built at some length other than the selected duration is filtered
    // out by CalendarView and never renders - a slot that exists and cannot be
    // seen is worse than a refusal.
    fireEvent.change(screen.getByLabelText('Timeslot (mins)'), { target: { value: '' } });


    fireEvent.change(screen.getByLabelText('Add a slot: date'), {
      target: { value: dateInputValue(futureDate()) },
    });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '14:15' } });

    expect(screen.getByRole('button', { name: /Add slot/i })).toBeDisabled();
  });
});

describe('AdminSessionManager - an off-boundary session survives a reload (#89)', () => {
  const offBoundarySession = () => {
    const day = futureWeekday(3);
    const start = new Date(day);
    start.setHours(14, 15, 0, 0);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    return {
      id: 'sess-1415',
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

  it('draws a 14:15 session with nothing in sessionStorage', async () => {
    // The reload case. `manualSlotKeys` lives in sessionStorage, so before this
    // the slot was drawn only in the tab that created it: a 14:15 session was
    // absent from the calendar in any other tab, browser or after a refresh.
    // The grid draws only what is in `availableSlots`, and `getSessionForSlot`
    // decorates a drawn slot rather than creating one.
    sessionStorage.clear();
    renderManager({ sessions: [offBoundarySession()] });
    await settle();

    expect(await screen.findByText('14:15 - 14:45')).toBeInTheDocument();
  });

  it('keeps drawing it after the duration control moves away from 30', async () => {
    // A real session is a fact, not a suggestion. Filtering it out because the
    // dropdown moved is how a session becomes undeletable from this screen -
    // the per-slot delete needs a drawn slot, Table view is read-only, and
    // Reset All refuses outright once anything is booked.
    sessionStorage.clear();
    renderManager({ sessions: [offBoundarySession()] });
    await settle();

    fireEvent.change(screen.getByLabelText('Timeslot (mins)'), { target: { value: '60' } });
    await settle();

    expect(await screen.findByText('14:15 - 14:45')).toBeInTheDocument();
  });

  it('counts what the grid draws, not what it was handed', async () => {
    // The counter reported the pre-filter, pre-prune length: it read 21 on a
    // grid drawing 20, because the hand-entered slot was counted and then
    // discarded by the overlap prune. Now both come from one function.
    renderManager();
    await settle();

    const readCount = () =>
      Number(/(\d+) slots available/.exec(document.body.textContent ?? '')?.[1]);

    const before = readCount();
    expect(before).toBeGreaterThan(0);

    addSlot(futureDate(), '14:15');
    await screen.findByText('14:15 - 14:45');

    // 14:15-14:45 overlaps the generated 14:00-14:30 AND 14:30-15:00, so it
    // replaces two: the count goes DOWN by one. The old counter went up by one.
    expect(readCount()).toBe(before - 1);

    // And the count equals what is actually on screen, which is the property
    // that matters rather than the arithmetic above.
    const drawn = (document.body.textContent ?? '').match(/\d{2}:\d{2} - \d{2}:\d{2}/g) ?? [];
    expect(drawn).toHaveLength(readCount());
  });

  it('does not count sessions outside the visible window', async () => {
    // Protecting real sessions put every one of them into the counted set - and
    // OpportunityForm fetches with `include_past: true`, so a study with history
    // over-reported by exactly the number of sessions the grid cannot draw. The
    // grid only gives columns to days between startDate and endDate.
    const farFuture = new Date();
    farFuture.setDate(farFuture.getDate() + 40);
    farFuture.setHours(11, 0, 0, 0);
    const longPast = new Date();
    longPast.setDate(longPast.getDate() - 10);
    longPast.setHours(11, 0, 0, 0);

    const outsideWindow = (id: string, start: Date) => ({
      id,
      opportunity_id: 'opp-1',
      start_time: start.toISOString(),
      end_time: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
      capacity: 1,
      booked_count: 0,
      remaining: 1,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    });

    renderManager({
      sessions: [outsideWindow('s-future', farFuture), outsideWindow('s-past', longPast)],
    });
    await settle();

    const counted = Number(/(\d+) slots available/.exec(document.body.textContent ?? '')?.[1]);
    const drawn = (document.body.textContent ?? '').match(/\d{2}:\d{2} - \d{2}:\d{2}/g) ?? [];

    // The assertion is the equality, not a literal: the counter is right when it
    // agrees with the screen, whatever the grid happens to generate.
    expect(counted).toBe(drawn.length);
    expect(counted).toBeGreaterThan(0);
  });
});

describe('AdminSessionManager - a slot that would lose the prune is refused, not lost (#89)', () => {
  /**
   * The first fix made protected slots outrank GENERATED ones. It did nothing
   * for protected-vs-protected: there the prune falls through to start-time
   * order and greedily drops the loser, with no error, no counter movement, and
   * the slot still in `selectedSlots` and persisted to sessionStorage.
   *
   * Confirm then fails server-side - `checkSessionOverlaps` throws
   * `ConflictError` and rolls back the WHOLE batch - naming a time that appears
   * nowhere on the grid, and every later Confirm fails identically until the
   * researcher works out that Clear Selection is the escape.
   *
   * So the gate refuses an OVERLAP rather than only an exact duplicate. That
   * makes "added, selected, creatable, never drawn" structurally impossible
   * rather than merely unlikely.
   */
  const sessionAt = (hour: number, minute: number, durationMinutes = 30) => {
    const start = new Date(futureWeekday(3));
    start.setHours(hour, minute, 0, 0);
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    return {
      id: `sess-${hour}${minute}`,
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

  it('refuses a slot overlapping an existing session, rather than dropping it silently', async () => {
    renderManager({ sessions: [sessionAt(14, 0)] });
    await settle();

    addSlot(futureDate(), '14:15');

    expect(await screen.findByText(/overlaps an existing session/i)).toBeInTheDocument();
    expect(screen.queryByText('14:15 - 14:45')).not.toBeInTheDocument();
    // Not selected either. A refusal that still selects the slot leaves Confirm
    // failing on something invisible, which is the whole defect.
    expect(screen.queryByText(/1 slot selected/i)).not.toBeInTheDocument();
    expect(createSessions).not.toHaveBeenCalled();
  });

  it('refuses a slot overlapping one just added by hand', async () => {
    renderManager();
    await settle();

    addSlot(futureDate(), '14:15');
    await screen.findByText('14:15 - 14:45');

    addSlot(futureDate(), '14:20');

    expect(await screen.findByText(/overlaps a slot you already added/i)).toBeInTheDocument();
    expect(screen.queryByText('14:20 - 14:50')).not.toBeInTheDocument();
  });

  it('refuses a slot that a hand-entered one would have pruned away', async () => {
    // The third shape, and the least obvious. Typing 14:30 after adding 14:15
    // used to find the GENERATED 14:30 already on the grid, so it was never
    // marked protected - then the protected 14:15 pruned it, and it was still
    // selected. Overlap is overlap regardless of which side is generated.
    renderManager();
    await settle();

    addSlot(futureDate(), '14:15');
    await screen.findByText('14:15 - 14:45');

    addSlot(futureDate(), '14:30');

    expect(await screen.findByText(/overlaps a slot you already added/i)).toBeInTheDocument();
  });

  it('still accepts a slot that merely ABUTS another', async () => {
    // The control. A gate that refuses everything nearby satisfies all three
    // tests above and makes the feature useless: 14:45 starts exactly as the
    // 14:15 slot ends, which is adjacency, not overlap.
    renderManager();
    await settle();

    addSlot(futureDate(), '14:15');
    await screen.findByText('14:15 - 14:45');

    addSlot(futureDate(), '14:45');

    expect(await screen.findByText('14:45 - 15:15')).toBeInTheDocument();
    expect(screen.queryByText(/overlaps/i)).not.toBeInTheDocument();
  });
});

describe('AdminSessionManager - a slot the timeline cannot draw is refused (#89)', () => {
  /**
   * The THIRD and last way a slot could be "added, selected, creatable and
   * never drawn", after the date window and the weekend filter.
   *
   * The timeline runs 07:00-23:00. Outside it `getTimePosition` clamps, so the
   * slot renders at height 0% on an edge - and a zero-height div cannot be
   * clicked, so the per-slot delete cannot reach it, Table view is read-only,
   * and Reset All refuses once anything is booked. The session becomes
   * unremovable from this screen.
   *
   * 23:00 is the worst case and the reason a bound on the START hour alone is
   * not enough: the timeline draws a 23:00 label, so the hour reads as in range,
   * while a 23:00-23:30 slot ENDS past the timeline.
   */
  it.each([
    // The two halves get DIFFERENT messages, and which one appears is asserted.
    // One message for both cannot be right: at 30 minutes 22:45 overruns the
    // timeline, and telling the researcher to "pick a time between 07:00 and
    // 23:00" when 22:45 is between them reads as a bug in the form.
    ['23:45', /latest start is 22:30/i],
    ['23:00', /latest start is 22:30/i],
    ['06:30', /calendar starts at 07:00/i],
    ['02:00', /calendar starts at 07:00/i],
  ])('refuses %s rather than drawing it at zero height', async (time, message) => {
    renderManager();
    await settle();

    addSlot(futureDate(), time);

    expect(await screen.findByText(message)).toBeInTheDocument();
    // Not selected either: a refusal that still selects leaves Confirm creating
    // something invisible, which is the whole defect.
    expect(screen.queryByText(/1 slot selected/i)).not.toBeInTheDocument();
    expect(createSessions).not.toHaveBeenCalled();
  });

  it('names the latest legal start for the duration actually chosen', async () => {
    // The derived bound moves with the duration, so a fixed string would be
    // wrong for three of the four durations the control offers.
    renderManager();
    await settle();

    fireEvent.change(screen.getByLabelText('Timeslot (mins)'), { target: { value: '60' } });
    addSlot(futureDate(), '22:45');

    expect(await screen.findByText(/60-minute slot/i)).toBeInTheDocument();
    expect(await screen.findByText(/latest start is 22:00/i)).toBeInTheDocument();
  });

  it.each(['07:00', '22:30', '14:15'])('still accepts %s, which is inside the timeline', async (time) => {
    // The control. A bound with the comparison the wrong way round, or an
    // off-by-one at either edge, would satisfy every arm above and refuse the
    // whole working day. 07:00 and 22:30 are the exact boundaries at 30 minutes.
    renderManager();
    await settle();

    addSlot(futureDate(), time);

    expect(screen.queryByText(/latest start is/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/calendar starts at/i)).not.toBeInTheDocument();
    const [hour, minute] = time.split(':').map(Number);
    const endMinutes = hour * 60 + minute + 30;
    const label = `${time} - ${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
    expect(await screen.findByText(label)).toBeInTheDocument();
  });
});

describe('AdminSessionManager - the counter respects pagination (#89)', () => {
  /**
   * A slot on EVERY weekday in the range, so the count and the screen can be
   * compared at any width.
   *
   * The first version of this suite put its far slots on page 1, so it could not
   * see the half of the defect that survived: the grid's ceiling is not
   * `daysPerPage` but TEN COLUMNS - `renderDayColumns(..., maxColumnsPerRow)`
   * called twice, five each - and `daysPerPage` auto-adjusts as high as 30. A
   * gate re-measured the original numbers through that gap: 40 counted against
   * 20 drawn, and 120 against 40 at thirty weekdays.
   */
  const gridAcrossWeekdays = (count: number) => {
    const slots = [];
    const day = new Date();
    day.setDate(day.getDate() + 1);
    for (let added = 0; added < count; ) {
      if (day.getDay() !== 0 && day.getDay() !== 6) {
        slots.push(...generatedGridFor(new Date(day)));
        added += 1;
      }
      day.setDate(day.getDate() + 1);
    }
    return { slots, lastDay: new Date(day) };
  };

  it.each([12, 15, 30])(
    'counts what is drawn across %s weekdays, past the ten-column ceiling',
    async (weekdays) => {
      const { slots, lastDay } = gridAcrossWeekdays(weekdays);
      vi.mocked(getAvailability).mockImplementation(async () => ({
        available_slots: slots,
        total_slots: slots.length,
        duration_minutes: 30,
        time_range: { start: slots[0].start, end: slots[slots.length - 1].end },
      }));

      renderManager();
      await settle();

      fireEvent.change(screen.getByLabelText('End Date'), {
        target: {
          value: `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`,
        },
      });
      await settle();

      const counted = Number(/(\d+) slots available/.exec(document.body.textContent ?? '')?.[1]);
      const drawn = (document.body.textContent ?? '').match(/\d{2}:\d{2} - \d{2}:\d{2}/g) ?? [];

      // The property is the equality. Asserting a literal would pin whatever the
      // grid happens to render today rather than that the two agree.
      expect(counted).toBe(drawn.length);
      expect(counted).toBeGreaterThan(0);
    }
  );

  it('counts only the page on screen, not the whole range', async () => {
    // `daysPerPage` auto-adjusts to cover the range but CAPS AT 30, so a wider
    // range paginates - and the counter, which bounded only the range, counted
    // days the grid was not drawing. Measured 40 counted against 20 drawn.
    const near = futureWeekday(3);
    const far = futureWeekday(45);

    vi.mocked(getAvailability).mockImplementation(async () => {
      const slots = [...generatedGridFor(near), ...generatedGridFor(far)];
      return {
        available_slots: slots,
        total_slots: slots.length,
        duration_minutes: 30,
        time_range: { start: slots[0].start, end: slots[slots.length - 1].end },
      };
    });

    renderManager();
    await settle();

    // Push End Date out past the 30-day pagination cap.
    const endInput = screen.getByLabelText('End Date');
    fireEvent.change(endInput, {
      target: {
        value: `${far.getFullYear()}-${String(far.getMonth() + 1).padStart(2, '0')}-${String(far.getDate()).padStart(2, '0')}`,
      },
    });
    await settle();

    const counted = Number(/(\d+) slots available/.exec(document.body.textContent ?? '')?.[1]);
    const drawn = (document.body.textContent ?? '').match(/\d{2}:\d{2} - \d{2}:\d{2}/g) ?? [];

    // The property is the equality, not a literal: the counter is right when it
    // agrees with the screen, whatever the range and page happen to be.
    expect(counted).toBe(drawn.length);
    expect(counted).toBeGreaterThan(0);
  });
});

describe('AdminSessionManager - a hand-entered slot stays protected even at a generated instant (#89)', () => {
  it('keeps drawing an on-boundary manual slot after the duration control moves', async () => {
    /*
     * A gate proved this line was load-bearing and unguarded: restoring the old
     * `if (!alreadyOnGrid)` skip - so a manual slot coinciding exactly with a
     * generated one is NOT marked protected - passed all 1562 frontend tests.
     *
     * The defect it re-opens is the original one verbatim. Add 14:00, which is
     * on the generated 30-minute grid, then move the duration control to 60: the
     * slot is dropped by the duration filter because it is not protected, while
     * remaining selected and creatable. Slot vanishes, Confirm still creates it.
     *
     * 14:00 rather than 14:15 is the whole point - the bug only exists where the
     * manual slot and a generated slot share an instant.
     */
    renderManager();
    await settle();

    addSlot(futureDate(), '14:00');
    expect(await screen.findByText('14:00 - 14:30')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Timeslot (mins)'), { target: { value: '60' } });
    await settle();

    expect(await screen.findByText('14:00 - 14:30')).toBeInTheDocument();
  });
});
