import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getRecordedStudyBrief } from '../../api/client';

/**
 * Audit row 10: once a participant has answered a native survey/poll/one
 * question, the detail page must show the completion and drop the Start button.
 * The server already refuses a second answer (409), so a live button here would
 * only ever hand back an error - and byte-identical-before-and-after was the
 * finding.
 */

const base = {
  id: 'opp-1',
  type: 'survey',
  title: 'Developer experience pulse',
  purpose_one_liner: 'Ten questions about the tools you use every day',
  status: 'published',
  default_duration_minutes: 10,
  participant_type_required: 'any',
  delivery_mode: 'native',
  firsthand_study_id: 'study_questions',
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
  getOpportunity: vi.fn(),
  getRecordedStudyBrief: vi.fn(),
  trackOpportunityClick: vi.fn().mockResolvedValue(undefined),
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
  load();
  vi.mocked(getRecordedStudyBrief).mockResolvedValue({
    task_count: 1,
    records_screen_and_voice: true,
    requires_chromium: true,
    estimated_duration_minutes: null,
  });
});

describe('OpportunityDetail completion trace (audit row 10)', () => {
  it('shows the completion and drops the Start button once answered', async () => {
    load({ completion: { completed: true, completedAt: '2026-09-02T09:00:00.000Z' } });
    renderDetail();

    const state = await screen.findByTestId('survey-completed-state');
    expect(state).toBeVisible();
    expect(screen.getByText(/you have completed this survey on/i)).toBeVisible();
    expect(screen.getByText(/you can only take part once/i)).toBeVisible();

    // The Start button is gone - not merely disabled.
    expect(screen.queryByRole('button', { name: /start survey/i })).toBeNull();
  });

  it('names the right object for a poll and a one-question study', async () => {
    load({ type: 'poll', completion: { completed: true, completedAt: null } });
    const { unmount } = renderDetail();
    expect(await screen.findByText(/you have completed this poll/i)).toBeVisible();
    // No date clause when the completion has no timestamp.
    expect(screen.queryByText(/completed this poll on/i)).toBeNull();
    unmount();

    load({ type: 'question', completion: { completed: true, completedAt: null } });
    renderDetail();
    expect(await screen.findByText(/you have answered this question/i)).toBeVisible();
  });

  it('still offers the Start button when not yet completed', async () => {
    load({ completion: { completed: false, completedAt: null } });
    renderDetail();

    expect(await screen.findByRole('button', { name: /start survey/i })).toBeVisible();
    expect(screen.queryByTestId('survey-completed-state')).toBeNull();
  });

  it('offers the Start button when there is no completion object at all', async () => {
    // A signed-out or first-time view carries no `completion`.
    load({ completion: undefined });
    renderDetail();

    expect(await screen.findByRole('button', { name: /start survey/i })).toBeVisible();
    expect(screen.queryByTestId('survey-completed-state')).toBeNull();
  });

  it('does not show a completion panel on a bookable study', async () => {
    // A completion object could only arrive on a native type, but guard anyway:
    // a test is bookable and its trace lives in bookings, never here.
    load({ type: 'test', delivery_mode: 'external', firsthand_study_id: null, completion: undefined });
    renderDetail();

    await waitFor(() => expect(vi.mocked(getOpportunity)).toHaveBeenCalled());
    expect(screen.queryByTestId('survey-completed-state')).toBeNull();
  });
});
