import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getRecordedStudyBrief } from '../../api/client';

// Roles/skills wanted (display-only): the advertised audience shows in the
// mission data panel as "LOOKING FOR". It describes; it does not gate.

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
vi.mock('../../components/CalendarGrid', () => ({
  default: () => null,
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

describe('OpportunityDetail roles/skills wanted', () => {
  it('shows the advertised roles under "LOOKING FOR"', async () => {
    load({ target_roles: ['Product Manager', 'ScriptRunner admin'] });
    renderDetail();
    await screen.findByText(base.title);

    expect(screen.getByText('LOOKING FOR')).toBeInTheDocument();
    expect(screen.getByText('Product Manager, ScriptRunner admin')).toBeInTheDocument();
  });

  it('shows no "LOOKING FOR" row when there are no roles', async () => {
    load({ target_roles: [] });
    renderDetail();
    await screen.findByText(base.title);

    expect(screen.queryByText('LOOKING FOR')).toBeNull();
  });
});
