import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { getAvailability, deleteSession } from '../../api/client';

/**
 * Row 6 of the Mav/Petra experience audit - the Session Management step.
 *
 * Five defects under one row, each guarded here:
 *   1. slot time labels were opacity:0 until hover, so the grid read as blank
 *      tiles at rest;
 *   2. the tiles were plain divs - no role, colour-only selected state, no
 *      keyboard reach;
 *   3. the forward control while a selection was pending called `onContinue`
 *      directly, dropping the uncommitted selection silently;
 *   4. "Clear Selection" was absolutely positioned over the forward button;
 *   5. the step opened on the calendar grid, whose window is tomorrow..+7 days,
 *      so a study's existing sessions outside that window were shown nowhere at
 *      rest. The list is the default now, and can manage sessions itself.
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

const switchToCalendar = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
  await settle();
};

/** A weekday, so it lands in a drawn column (weekends are suppressed). */
const futureWeekday = (minDaysAhead = 3) => {
  const d = new Date();
  d.setDate(d.getDate() + minDaysAhead);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
};

/** One 30-minute slot at `hour:00` on a future weekday, inside 07:00-23:00. */
const oneSlotAt = (hour: number) => {
  const start = futureWeekday(3);
  start.setHours(hour, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString(), duration_minutes: 30 };
};

const sessionRow = (
  id: string,
  startIso: string,
  endIso: string,
  overrides: Partial<{ booked_count: number; remaining: number; capacity: number }> = {}
) => ({
  id,
  opportunity_id: 'opp-1',
  start_time: startIso,
  end_time: endIso,
  capacity: overrides.capacity ?? 1,
  booked_count: overrides.booked_count ?? 0,
  remaining: overrides.remaining ?? 1,
  location_or_meet_link_optional: '',
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(getAvailability).mockResolvedValue({
    available_slots: [oneSlotAt(10)],
    total_slots: 1,
    duration_minutes: 30,
    time_range: { start: new Date().toISOString(), end: new Date().toISOString() },
  } as never);
});

describe('Row 6 defect 5 - the list is the default view and shows existing sessions first', () => {
  it('opens on the Table picker with the existing-sessions list, not the calendar grid', async () => {
    renderManager({
      sessions: [sessionRow('s1', '2026-08-18T18:00:00.000Z', '2026-08-18T19:00:00.000Z')] as never,
    });
    await settle();

    // The Table view is the default: its slot picker (the per-day "Select all"
    // is table-only) sits above the existing-sessions list - not the calendar.
    expect(await screen.findByRole('button', { name: /^Select all/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Existing Sessions' })).toBeInTheDocument();
    // The Table is a PICKER now, so the slot controls it needs are on screen at
    // rest. They used to be gated to the calendar, when the Table was read-only.
    expect(screen.getByLabelText('Start Date')).toBeInTheDocument();
    expect(screen.getByLabelText('Add a slot: date')).toBeInTheDocument();
  });

  it('lists a session that falls OUTSIDE the grid window (which never drew it at rest)', async () => {
    // 18 Aug 2026 is well before the grid's tomorrow..+7 window, so the grid
    // showed nothing for it. The list shows it because the list shows sessions,
    // not a date range.
    renderManager({
      sessions: [sessionRow('past', '2026-08-18T18:00:00.000Z', '2026-08-18T19:00:00.000Z')] as never,
    });
    await settle();

    const table = screen.getByRole('table');
    expect(within(table).getByRole('button', { name: /Remove session on/i })).toBeInTheDocument();
  });

  it('opens straight into the picker when there are no sessions, not a dead-end list', async () => {
    renderManager({ sessions: [] });
    await settle();

    // Zero sessions: the Table opens directly on the picker, so slots are chosen
    // here with no detour. The old "No sessions yet -> Add slots -> calendar"
    // dead-end is gone (Mav & Petra: pick from the table, not the calendar).
    expect(screen.queryByText('No sessions yet')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Select all/i })).toBeInTheDocument();
    // A pickable slot is a real, named button, and the picker's controls are up.
    expect(screen.getByRole('button', { name: /available time slot/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Start Date')).toBeInTheDocument();
  });
});

describe('Row 6 defect 5 - the list can remove sessions', () => {
  it('removes an unbooked real session server-side and drops it from the list', async () => {
    const onSessionsChange = vi.fn();
    renderManager({
      onSessionsChange,
      sessions: [sessionRow('s1', '2027-03-01T10:00:00.000Z', '2027-03-01T10:30:00.000Z')] as never,
    });
    await settle();

    fireEvent.click(screen.getByRole('button', { name: /Remove session on/i }));
    await settle();

    expect(vi.mocked(deleteSession)).toHaveBeenCalledWith('s1');
    expect(onSessionsChange).toHaveBeenCalledWith([]);
  });

  it('refuses to remove a booked session - the button is disabled', async () => {
    const onSessionsChange = vi.fn();
    renderManager({
      onSessionsChange,
      sessions: [
        sessionRow('booked', '2027-03-01T10:00:00.000Z', '2027-03-01T10:30:00.000Z', {
          booked_count: 1,
          remaining: 0,
        }),
      ] as never,
    });
    await settle();

    const remove = screen.getByRole('button', { name: /Remove session on/i });
    expect(remove).toBeDisabled();
    // And nothing is deleted even if a click is forced past the disabled state.
    fireEvent.click(remove);
    expect(vi.mocked(deleteSession)).not.toHaveBeenCalled();
    expect(onSessionsChange).not.toHaveBeenCalled();
  });
});

describe('Row 6 defects 1 & 2 - grid tiles are labelled buttons', () => {
  it('shows the time label at rest, not only on hover', async () => {
    renderManager();
    await switchToCalendar();

    const label = await screen.findByText('10:00 - 10:30');
    // The defect was an inline `opacity: 0` on the label until hover. Its
    // absence is what makes the label visible at rest; asserting the inline
    // style has no opacity:0 fails against the pre-row-6 component, which set
    // exactly that on every unselected available slot.
    expect(label.getAttribute('style') || '').not.toMatch(/opacity:\s*0(\D|$)/);
  });

  it('renders each tile as a real button reachable by keyboard', async () => {
    renderManager();
    await switchToCalendar();

    // Announced with its full time span, and focusable - the tile was a bare
    // div with no role and a colour-only selected state before.
    const tile = await screen.findByRole('button', { name: /Available time slot/i });
    expect(tile).toHaveAttribute('tabindex', '0');
    expect(tile).toHaveAttribute('aria-pressed', 'false');
  });

  it('selects a slot from the keyboard and reflects it in aria-pressed', async () => {
    renderManager();
    await switchToCalendar();

    const tile = await screen.findByRole('button', { name: /Available time slot/i });
    fireEvent.keyDown(tile, { key: 'Enter' });
    await settle();

    expect(screen.getByText(/slot selected/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Selected for session creation/i })
    ).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Row 6 defects 3 & 4 - the pending-selection footer', () => {
  const preselectOneSlot = () => {
    sessionStorage.setItem(
      'selectedSlots_opp-1',
      JSON.stringify(['2030-01-07T10:00:00.000Z|2030-01-07T10:30:00.000Z'])
    );
  };

  it('commits the pending selection before advancing, rather than dropping it', async () => {
    preselectOneSlot();
    const onSessionsChange = vi.fn();
    const onContinue = vi.fn();
    renderManager({ isTemporary: true, onSessionsChange, onContinue, onContinueLabel: 'Review' });
    await settle();

    // The forward control names its commit, and there is NO bare "Continue"
    // here - that button is what silently dropped the selection.
    expect(
      screen.queryByRole('button', { name: 'Continue: Review' })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm & continue: Review' }));
    await settle();

    // The selection was committed (handed up as a temp session) AND we advanced.
    expect(onSessionsChange).toHaveBeenCalledTimes(1);
    const handedUp = onSessionsChange.mock.calls[0][0] as Array<{ id: string }>;
    expect(handedUp.some((s) => s.id.startsWith('temp-session-'))).toBe(true);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('lays Clear Selection out beside the forward control, not absolutely over it', async () => {
    preselectOneSlot();
    const { container } = renderManager({ onContinue: vi.fn(), onContinueLabel: 'Review' });
    await settle();

    // The overlap came from `.selection-actions-center`, an inset:0 absolute
    // layer that painted Clear Selection across the forward button. It is gone,
    // replaced by a flex spacer, and both controls are ordinary siblings.
    expect(container.querySelector('.selection-actions-center')).toBeNull();
    expect(container.querySelector('.selection-actions-spacer')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Clear Selection' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Confirm & continue: Review' })
    ).toBeInTheDocument();
  });
});
