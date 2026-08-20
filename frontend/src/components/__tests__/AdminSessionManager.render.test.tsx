import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { getAvailability, getMyCalendarEvents } from '../../api/client';

// The riskiest of the exhaustive-deps fixes lives here. The sync effect both
// READS confirmedSlots and WRITES it, so making it depend on that state is
// exactly the shape that loops. It depends on `confirmedSlots.size` - a
// primitive - precisely because a write producing a new Set of the same size
// then cannot re-trigger it.
//
// A render loop in React surfaces as "Maximum update depth exceeded", which
// fails these tests loudly, and as an unbounded number of calendar fetches.
// Both are asserted rather than assumed.
vi.mock('../../api/client', () => ({
  // A FRESH array per call, matching a real parsed HTTP response. A shared
  // mockResolvedValue hands back the same reference every time, so
  // setAvailableSlots bails out and the identity churn that production
  // actually has never appears in the test.
  getAvailability: vi.fn(async () => ({ available_slots: [] })),
  getMyCalendarEvents: vi.fn(async () => []),
  createSessions: vi.fn().mockResolvedValue([]),
  deleteAllSessions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/navigation', () => ({
  navigation: { toAdmin: vi.fn() },
}));

const session = (id: string, startIso: string, endIso: string) => ({
  id,
  opportunity_id: 'opp-1',
  start_time: startIso,
  end_time: endIso,
  capacity: 1,
  booked_count: 0,
  remaining: 1,
});

const renderManager = (props: Record<string, unknown> = {}) =>
  render(
    <MemoryRouter>
      <AdminSessionManager
        opportunityId="opp-1"
        sessions={[]}
        onSessionsChange={vi.fn()}
        defaultDurationMinutes={30}
        {...(props as never)}
      />
    </MemoryRouter>
  );

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('AdminSessionManager - the backward control names its destination', () => {
  it('names the step it returns to rather than saying a bare "Back"', async () => {
    renderManager({ onBack: vi.fn(), onBackLabel: 'Content & Details' });
    await settle();

    // This is the sixth backward control in the opportunity form and the only
    // one outside the shared StepActions row. While it said "Back" it was
    // indistinguishable from the control at the top of the page that leaves
    // the form entirely, which is the confusion the rename exists to remove.
    expect(
      screen.getByRole('button', { name: 'Previous: Content & Details' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Back$/ })).not.toBeInTheDocument();
  });

  it('goes back when it is pressed', async () => {
    const onBack = vi.fn();
    renderManager({ onBack, onBackLabel: 'Content & Details' });
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Previous: Content & Details' }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders no backward control at all when there is nowhere to go', async () => {
    renderManager();
    await settle();

    expect(screen.queryByRole('button', { name: /^Previous/ })).not.toBeInTheDocument();
  });
});

describe('AdminSessionManager - effect stability', () => {
  it('mounts and settles without re-entering the calendar load', async () => {
    renderManager();
    await settle();

    // EXACTLY one load for the initial date range. An upper bound with slack
    // let a real mutation through - splitting the date-change effect back into
    // two, which double-fetches the calendar on every date change, still came
    // in under a bound of 2.
    expect(vi.mocked(getAvailability)).toHaveBeenCalledTimes(1);
  });

  it('settles with sessions present, which is what drives the confirmed-slot sync', async () => {
    // Sessions are what the sync effect turns into confirmed slots, so this is
    // the path where a size-keyed dependency could oscillate.
    renderManager({
      sessions: [
        session('s1', '2026-09-01T09:00:00.000Z', '2026-09-01T09:30:00.000Z'),
        session('s2', '2026-09-01T10:00:00.000Z', '2026-09-01T10:30:00.000Z'),
      ],
    });
    await settle();

    // Two: the initial date-range load, plus the one the sessions-refresh
    // effect deliberately fires to pick up booking updates.
    expect(vi.mocked(getAvailability)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getMyCalendarEvents)).toHaveBeenCalledTimes(2);
  });

  it('does not refetch on a re-render with unchanged props', async () => {
    const sessions = [session('s1', '2026-09-01T09:00:00.000Z', '2026-09-01T09:30:00.000Z')];
    const onSessionsChange = vi.fn();

    const { rerender } = render(
      <MemoryRouter>
        <AdminSessionManager
          opportunityId="opp-1"
          sessions={sessions}
          onSessionsChange={onSessionsChange}
          defaultDurationMinutes={30}
        />
      </MemoryRouter>
    );
    await settle();
    const afterMount = vi.mocked(getAvailability).mock.calls.length;

    // Same array identity and same handler: nothing the effects key on changed.
    rerender(
      <MemoryRouter>
        <AdminSessionManager
          opportunityId="opp-1"
          sessions={sessions}
          onSessionsChange={onSessionsChange}
          defaultDurationMinutes={30}
        />
      </MemoryRouter>
    );
    await settle();

    expect(vi.mocked(getAvailability).mock.calls.length).toBe(afterMount);
  });

  it('cleans its persisted slots up on unmount', async () => {
    // The cleanup effect now depends on getStorageKey rather than on the two
    // values that build the key. Guards that the key it removes is still the
    // key it wrote, which is what that indirection could have broken.
    sessionStorage.setItem('selectedSlots_opp-1', JSON.stringify(['a|b']));
    sessionStorage.setItem('confirmedSlots_opp-1', JSON.stringify(['a|b']));

    const { unmount } = renderManager();
    await settle();
    unmount();

    expect(sessionStorage.getItem('selectedSlots_opp-1')).toBeNull();
    expect(sessionStorage.getItem('confirmedSlots_opp-1')).toBeNull();
  });

  it('settles on the temporary-opportunity restore path, which writes a fresh Set every run', async () => {
    // THE loop-prone branch. With no sessions and isTemporary, the effect calls
    // getStoredConfirmedSlots() and setConfirmedSlots(stored) - a BRAND NEW Set
    // object on every run, unconditionally. If this effect depended on
    // confirmedSlots itself rather than on confirmedSlots.size, each write would
    // change the identity, re-trigger the effect, and never converge.
    sessionStorage.setItem(
      'confirmedSlots_temp',
      JSON.stringify(['2026-09-01T09:00:00.000Z|2026-09-01T09:30:00.000Z'])
    );

    render(
      <MemoryRouter>
        <AdminSessionManager
          opportunityId=""
          sessions={[]}
          onSessionsChange={vi.fn()}
          defaultDurationMinutes={30}
          isTemporary
        />
      </MemoryRouter>
    );
    await settle();

    // Reaching here at all means React did not blow the update depth, and an
    // exact count confirms the effects are not quietly driving each other.
    expect(vi.mocked(getAvailability)).toHaveBeenCalledTimes(1);
  });

  it('reloads the calendar ONCE per sessions change, not twice', async () => {
    // A separate effect deliberately reloads when sessions change, to pick up
    // booking updates - so a new sessions array SHOULD cost one fetch. The
    // failure this guards is a second one on top: if loadCalendarData depended
    // on `sessions` (it reads the prop nowhere that matters), its identity
    // would change too, and the date-change effect that names it would fire as
    // well. Two API round trips per booking update instead of one, which no
    // same-identity re-render can reveal.
    const mk = () => [session('s1', '2026-09-01T09:00:00.000Z', '2026-09-01T09:30:00.000Z')];
    const onSessionsChange = vi.fn();

    const { rerender } = render(
      <MemoryRouter>
        <AdminSessionManager
          opportunityId="opp-1"
          sessions={mk()}
          onSessionsChange={onSessionsChange}
          defaultDurationMinutes={30}
        />
      </MemoryRouter>
    );
    await settle();
    const afterMount = vi.mocked(getAvailability).mock.calls.length;

    rerender(
      <MemoryRouter>
        <AdminSessionManager
          opportunityId="opp-1"
          sessions={mk()}
          onSessionsChange={onSessionsChange}
          defaultDurationMinutes={30}
        />
      </MemoryRouter>
    );
    await settle();

    expect(vi.mocked(getAvailability).mock.calls.length - afterMount).toBe(1);
  });
});
