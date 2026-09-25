import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getRecordedStudyBrief } from '../../api/client';

// DT-8: every external hand-off on the detail page discloses where it goes.
// The anchor case (external question) is covered by the ExternalHandoff unit
// test; these pin the COMMON case - the poll/survey/study window.open button -
// and confirm the disclosure appears for external hand-offs only, never for an
// in-app native run or a recorded study (which do not leave Cortex).

const base = {
  id: 'opp-1',
  title: 'Release cadence poll',
  purpose_one_liner: 'One click to vote',
  status: 'published',
  default_duration_minutes: 30,
  participant_type_required: 'any',
  product_optional: null,
  sessions: [],
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'employee', name: 'E' }, loading: false }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/CalendarGrid', () => ({ default: () => null, CALENDAR_LEGEND_ITEMS: [] }));

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

const load = (overrides: Record<string, unknown>) =>
  vi.mocked(getOpportunity).mockResolvedValue({ ...base, ...overrides } as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRecordedStudyBrief).mockResolvedValue({
    task_count: 2,
    records_screen_and_voice: true,
    requires_chromium: true,
    estimated_duration_minutes: null,
  } as never);
});

describe('external hand-off buttons disclose their destination (DT-8)', () => {
  it('an external poll names the host and says you are leaving Cortex', async () => {
    load({
      type: 'poll',
      delivery_mode: 'external',
      firsthand_study_id: null,
      external_link_optional: 'https://forms.example.com/vote?token=abc',
    });
    const { container } = renderDetail();
    await screen.findByText('Release cadence poll');

    expect(screen.getByRole('button', { name: /open poll/i })).toBeInTheDocument();
    expect(screen.getByText(/forms\.example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/leaving Cortex/i)).toBeInTheDocument();
    // The token is never shown as visible copy.
    expect(container.textContent).not.toContain('abc');
  });

  it('a NATIVE survey run makes no leaving-Cortex claim (it stays in Cortex)', async () => {
    load({
      type: 'survey',
      delivery_mode: 'native',
      firsthand_study_id: 'study_x',
      external_link_optional: null,
      title: 'Native in-app survey',
    });
    const { container } = renderDetail();
    await screen.findByText('Native in-app survey');

    expect(container.textContent).not.toContain('leaving Cortex');
  });

  it('a recorded study (in-app) makes no leaving-Cortex claim', async () => {
    load({
      type: 'unmoderated',
      firsthand_study_id: 'study_x',
      external_link_optional: null,
      title: 'A recorded walkthrough',
    });
    const { container } = renderDetail();
    await screen.findByText('A recorded walkthrough');

    expect(container.textContent).not.toContain('leaving Cortex');
  });
});
