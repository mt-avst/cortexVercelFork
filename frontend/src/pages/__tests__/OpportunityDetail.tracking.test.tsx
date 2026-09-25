import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, trackOpportunityClick } from '../../api/client';

// A view-tracking regression is silent: nothing on screen changes, the study
// analytics just drift, and you find out weeks later from a number nobody
// trusts. So this pins the firing behaviour of the effect whose dependencies
// changed - it now reads the id off the LOADED opportunity rather than off the
// route param.
const fixture = {
  id: 'opp-1',
  type: 'unmoderated',
  title: 'Checkout flow walkthrough',
  purpose_one_liner: 'Find out where people stall in the checkout flow',
  status: 'published',
  default_duration_minutes: 30,
  participant_type_required: 'any',
  sessions: [],
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'employee', name: 'E' }, loading: false }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/CalendarGrid', () => ({
  default: () => null,
  CALENDAR_LEGEND_ITEMS: [],
}));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(async () => ({ ...fixture })),
  trackOpportunityClick: vi.fn().mockResolvedValue(undefined),
  markOpportunityOpened: vi.fn().mockResolvedValue(undefined),
  bookSession: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  startRecordedStudySession: vi.fn(),
}));

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={['/opportunities/opp-1']}>
      <Routes>
        <Route path="/opportunities/:id" element={<OpportunityDetail />} />
      </Routes>
    </MemoryRouter>
  );

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

// The load resolves on a microtask, but a loaded machine can push it past any
// fixed sleep - a bare 150ms `settle()` before counting calls flaked a full
// suite run. So wait for the load itself, THEN settle, so "exactly once" still
// gets a window in which a duplicate would have shown up.
const viewCalls = () =>
  vi.mocked(trackOpportunityClick).mock.calls.filter(([, kind]) => kind === 'view');
const loadedAndSettled = async (loads: number) => {
  await waitFor(() => expect(vi.mocked(getOpportunity)).toHaveBeenCalledTimes(loads));
  await waitFor(() => expect(viewCalls().length).toBeGreaterThan(0));
  await settle();
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OpportunityDetail - view tracking', () => {
  it('tracks the view once, against the id of the study actually loaded', async () => {
    renderDetail();
    await loadedAndSettled(1);

    const views = viewCalls();
    expect(views).toHaveLength(1);
    expect(views[0][0]).toBe('opp-1');
  });

  it('does not track again when the same study is genuinely re-fetched', async () => {
    // Drives the REAL refresh path rather than just poking the event: the
    // visibility handler only reloads after the page has been hidden for more
    // than 30 seconds, so the clock has to move. getOpportunity resolves a NEW
    // object each call, so a successful reload changes the loaded opportunity's
    // identity while its id stays the same.
    //
    // The effect keys on `opportunity?.id`, a primitive, so this must not
    // re-fire. Keying on the object would add a phantom view every 30 seconds
    // that an admin left the tab in the background.
    const hidden = vi.spyOn(document, 'hidden', 'get');
    const now = vi.spyOn(Date, 'now');
    let clock = 1_000_000;
    now.mockImplementation(() => clock);

    renderDetail();
    await loadedAndSettled(1);
    expect(vi.mocked(getOpportunity)).toHaveBeenCalledTimes(1);

    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));

    clock += 45_000; // longer than the 30s threshold the handler checks
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await loadedAndSettled(2);

    // The reload actually happened - without this the assertion below would
    // pass vacuously, which is exactly how the first version of this test let
    // a real mutation through.
    expect(vi.mocked(getOpportunity)).toHaveBeenCalledTimes(2);

    expect(viewCalls()).toHaveLength(1);

    hidden.mockRestore();
    now.mockRestore();
  });

  it('does not track anything before the study has loaded', async () => {
    // The guard is `if (!loadedId) return`. Without it the effect would fire on
    // the first render with an undefined id.
    vi.mocked(getOpportunity).mockImplementationOnce(
      () => new Promise(() => {}) as Promise<never>
    );

    renderDetail();
    await settle();

    expect(
      vi.mocked(trackOpportunityClick).mock.calls.filter(([, kind]) => kind === 'view')
    ).toHaveLength(0);
  });
});
