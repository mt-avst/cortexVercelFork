import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import MyBookings from '../MyBookings';
import { getMyBookings, getMySessionEvents } from '../../api/client';

// Row 5: "Completed studies" grouped one row per session_events row, so a
// single poll session that fired session_started then session_completed
// rendered as two cards for the same study - and every card said "Recorded
// session" regardless of what was actually run, because the type was
// hard-coded to 'unmoderated' rather than read from the event payload.

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'employee', name: 'E' }, loading: false }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

vi.mock('../../api/client', () => ({
  getMyBookings: vi.fn(),
  cancelBooking: vi.fn(),
  rescheduleBooking: vi.fn(),
  getMySessionEvents: vi.fn(),
}));

const renderPage = () => render(<MemoryRouter><MyBookings /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMyBookings).mockResolvedValue({ upcoming: [], past: [] } as never);
});

describe('MyBookings completed studies grouping', () => {
  it('renders one card per session, latest status wins, two distinct sessions stay two cards', async () => {
    vi.mocked(getMySessionEvents).mockResolvedValue([
      // The real endpoint orders `ORDER BY occurred_at DESC` (backend/src/
      // routes/api.ts) - fed in that same order so a mutation that merely
      // takes the FIRST event per group (rather than the latest by
      // occurred_at) cannot pass by accident of fixture ordering.
      {
        id: 'evt-2',
        opportunity_id: 'opp-poll',
        opportunity_title: 'Quick reaction poll',
        type: 'poll',
        firsthand_session_id: 'sess-1',
        event_type: 'session_completed',
        occurred_at: '2026-08-01T10:05:00.000Z',
        received_at: '2026-08-01T10:05:00.000Z',
      },
      {
        id: 'evt-1',
        opportunity_id: 'opp-poll',
        opportunity_title: 'Quick reaction poll',
        type: 'poll',
        firsthand_session_id: 'sess-1',
        event_type: 'session_started',
        occurred_at: '2026-08-01T10:00:00.000Z',
        received_at: '2026-08-01T10:00:00.000Z',
      },
      // A second, DISTINCT session - the control proving the grouping keys on
      // `firsthand_session_id` rather than collapsing everything into one
      // card regardless of which session an event belongs to.
      {
        id: 'evt-3',
        opportunity_id: 'opp-survey',
        opportunity_title: 'Second study',
        type: 'survey',
        firsthand_session_id: 'sess-2',
        event_type: 'session_started',
        occurred_at: '2026-08-02T09:00:00.000Z',
        received_at: '2026-08-02T09:00:00.000Z',
      },
    ] as never);

    renderPage();
    await screen.findAllByText(/Quick reaction poll/);

    const section = screen.getByText('Completed studies').closest('section')!;
    expect(within(section).getAllByRole('heading', { level: 3 })).toHaveLength(2);

    const pollCard = within(section).getByText('Quick reaction poll').closest('.booking-card') as HTMLElement;
    expect(within(pollCard).getAllByText('Quick reaction poll')).toHaveLength(1);
    expect(within(pollCard).getByText('Quick poll')).toBeVisible();
    // Latest status wins: session_completed, not session_started - even
    // though the started row for this same session is ALSO in the list.
    expect(within(pollCard).getByText('Completed')).toBeVisible();
    expect(within(pollCard).queryByText('Started')).toBeNull();

    const surveyCard = within(section).getByText('Second study').closest('.booking-card') as HTMLElement;
    expect(within(surveyCard).getByText('Survey')).toBeVisible();
    expect(within(surveyCard).getByText('Started')).toBeVisible();
  });
});
