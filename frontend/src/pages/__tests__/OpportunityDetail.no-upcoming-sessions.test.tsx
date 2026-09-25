import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getRecordedStudyBrief } from '../../api/client';

/**
 * #113: a published live-session study whose sessions are all in the past used
 * to render past, unbookable columns on the participant view - the deliberate
 * #112 fallback that anchors on the true earliest day when nothing is upcoming.
 * That is right for a mid-run study; for an all-past study it strands the
 * participant on unbookable slots with no forward affordance.
 *
 * The participant view must instead say, plainly, that there are no upcoming
 * sessions, and must NOT mount the booking calendar. The control is a study
 * with any upcoming session, which must still mount the calendar unchanged.
 */

const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const session = (startMs: number, durationMs: number = HOUR) => ({
  id: `sess-${startMs}`,
  opportunity_id: 'opp-1',
  start_time: iso(startMs),
  end_time: iso(startMs + durationMs),
  capacity: 5,
  booked_count: 0,
  created_at: iso(-100 * HOUR),
  updated_at: iso(-100 * HOUR),
  remaining: 5,
});

const base = {
  id: 'opp-1',
  type: 'test',
  title: 'Usability walkthrough',
  purpose_one_liner: 'Thirty minutes on the new dashboard',
  status: 'published',
  default_duration_minutes: 30,
  participant_type_required: 'any',
  sessions: [] as ReturnType<typeof session>[],
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'employee', name: 'E' }, loading: false }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

// A sentinel, not null: the whole point is asserting the booking calendar is
// NOT mounted for an all-past study, so it has to be distinguishable when it is.
vi.mock('../../components/CalendarGrid', () => ({
  default: () => <div data-testid="calendar-grid" />,
  CALENDAR_LEGEND_ITEMS: [],
}));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(),
  getRecordedStudyBrief: vi.fn(),
  trackOpportunityClick: vi.fn().mockResolvedValue(undefined),
  markOpportunityOpened: vi.fn().mockResolvedValue(undefined),
  bookSession: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  startRecordedStudySession: vi.fn(),
  startSurveySession: vi.fn(),
}));

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={['/opportunities/opp-1']}>
      <Routes>
        <Route path="/opportunities/:id" element={<OpportunityDetail />} />
      </Routes>
    </MemoryRouter>
  );

const load = (overrides: Record<string, unknown> = {}) => {
  vi.mocked(getOpportunity).mockResolvedValue({ ...base, ...overrides } as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRecordedStudyBrief).mockResolvedValue({
    task_count: 1,
    records_screen_and_voice: true,
    requires_chromium: true,
    estimated_duration_minutes: null,
  } as never);
});

describe('OpportunityDetail with no upcoming sessions (#113)', () => {
  it('shows a "No upcoming sessions" empty state and does not mount the calendar', async () => {
    load({ sessions: [session(-72 * HOUR), session(-48 * HOUR), session(-24 * HOUR)] });
    renderDetail();
    await screen.findByText(base.title);

    expect(await screen.findByText(/no upcoming sessions/i)).toBeInTheDocument();
    expect(screen.queryByTestId('calendar-grid')).toBeNull();
    // The legend and the Calendar/Table toggle key a grid nobody is being
    // shown, so they are suppressed too. Pinned by role so deleting either
    // guard fails here by name rather than passing on the body branch alone.
    expect(screen.queryByRole('list', { name: /calendar legend/i })).toBeNull();
    expect(screen.queryByRole('group', { name: /view mode selection/i })).toBeNull();
  });

  it('still mounts the calendar when any session is upcoming (the #112 control)', async () => {
    load({ sessions: [session(-24 * HOUR), session(+24 * HOUR)] });
    renderDetail();
    await screen.findByText(base.title);

    // Calendar is no longer the default view, so switch to it to assert the
    // grid mounts. The toggle itself is the #113 control below.
    await userEvent.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    expect(await screen.findByTestId('calendar-grid')).toBeInTheDocument();
    expect(screen.queryByText(/no upcoming sessions/i)).toBeNull();
    // The positive control for the two suppressions above.
    expect(screen.getByRole('list', { name: /calendar legend/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /view mode selection/i })).toBeInTheDocument();
  });

  it('keeps the "not added yet" message for a study with no sessions at all', async () => {
    load({ sessions: [] });
    renderDetail();
    await screen.findByText(base.title);

    expect(await screen.findByText(/sessions will appear here/i)).toBeInTheDocument();
    expect(screen.queryByText(/no upcoming sessions/i)).toBeNull();
    expect(screen.queryByTestId('calendar-grid')).toBeNull();
  });

  it('treats a session ending in the future as upcoming, boundary of end_time', async () => {
    // Starts in the past, still running: end_time >= now, so it is bookable-ish
    // and the calendar (which draws the live "now" line) must still mount.
    load({ sessions: [session(-0.5 * HOUR, HOUR)] });
    renderDetail();
    await screen.findByText(base.title);

    await userEvent.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    expect(await screen.findByTestId('calendar-grid')).toBeInTheDocument();
    expect(screen.queryByText(/no upcoming sessions/i)).toBeNull();
  });
});
