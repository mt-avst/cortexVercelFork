import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getRecordedStudyBrief } from '../../api/client';

// The data panel printed "PARTICIPANTS / Any" on a recorded study whose own
// share panel says it needs a Cortex account and will not work for anyone
// outside the organisation. The panel already hides PRODUCT, DURATION and TASKS
// when they carry nothing; eligibility now follows the same rule, and the rule
// itself lives in getEligibilityNote so the browse row and this page cannot
// drift apart again.

const base = {
  id: 'opp-1',
  type: 'unmoderated',
  title: 'Search results relevance walkthrough',
  purpose_one_liner: 'Find out whether people can tell why a result ranked where it did',
  status: 'published',
  default_duration_minutes: 30,
  participant_type_required: 'any',
  firsthand_study_id: 'study_abc123',
  sessions: [],
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'employee', name: 'E' }, loading: false }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));
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

describe('OpportunityDetail eligibility', () => {
  it('does not tell a participant that a recorded study is open to "Any"', async () => {
    renderDetail();
    await screen.findByText(base.title);

    expect(screen.queryByText('PARTICIPANTS')).toBeNull();
    expect(screen.queryByText('Any')).toBeNull();
  });

  it('drops the row for "internal" too', async () => {
    load({ participant_type_required: 'internal' });
    renderDetail();
    await screen.findByText(base.title);

    expect(screen.queryByText('PARTICIPANTS')).toBeNull();
    expect(screen.queryByText(/internal only/i)).toBeNull();
  });

  it('keeps the row when eligibility genuinely narrows: external', async () => {
    load({ type: 'poll', firsthand_study_id: null, external_link_optional: 'https://forms.gle/x', participant_type_required: 'external' });
    renderDetail();
    await screen.findByText(base.title);

    expect(screen.getByText('PARTICIPANTS')).toBeInTheDocument();
    expect(screen.getByText('External participants only')).toBeInTheDocument();
  });

  it('keeps the row for "specific" and shows the researcher\'s own criteria', async () => {
    load({
      participant_type_required: 'specific',
      participant_type_specific_details: 'Jira admins who have run a migration',
    });
    renderDetail();
    await screen.findByText(base.title);

    expect(screen.getByText('PARTICIPANTS')).toBeInTheDocument();
    expect(screen.getByText('Jira admins who have run a migration')).toBeInTheDocument();
  });

  it('keeps showing the rows that do carry information', async () => {
    renderDetail();
    // TASKS is the panel's other row for a recorded study, so this proves the
    // panel itself still renders rather than the whole thing having vanished.
    expect(await screen.findByText('TASKS')).toBeInTheDocument();
  });
});
