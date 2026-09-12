import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getRecordedStudyBrief } from '../../api/client';

// Duration was removed from this page for recorded studies because there was no
// way to set one: `opportunities.default_duration_minutes` is NOT NULL DEFAULT
// 30, so every recorded study said "30 min" above a consent button, chosen by
// nobody. The authoring form has the field now, so the figure comes back - but
// only when it is real, and it must still come from the STUDY rather than from
// the opportunity's default.

const base = {
  id: 'opp-1',
  type: 'unmoderated',
  title: 'Search results relevance walkthrough',
  purpose_one_liner: 'Why did that result rank first',
  status: 'published',
  // The value that must never be shown for a recorded study.
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

// The brief is a SECOND request. Waiting on the title only proves the first
// landed, which passed in isolation and failed in a full run - so every test
// here anchors on something the brief itself renders.
const briefLanded = () => screen.findByText(/2 tasks, worked through one at a time/i);

const brief = (estimated_duration_minutes: number | null) => {
  vi.mocked(getRecordedStudyBrief).mockResolvedValue({
    task_count: 2,
    records_screen_and_voice: true,
    requires_chromium: true,
    estimated_duration_minutes,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOpportunity).mockResolvedValue({ ...base } as never);
  brief(null);
});

describe('recorded study duration', () => {
  it('shows the length a researcher actually chose', async () => {
    brief(20);
    renderDetail();
    await briefLanded();

    expect(screen.getByText('DURATION')).toBeInTheDocument();
    expect(screen.getByText('20 min')).toBeInTheDocument();
  });

  it('says nothing when nobody set one', async () => {
    renderDetail();
    await briefLanded();

    expect(screen.queryByText('DURATION')).toBeNull();
  });

  it('never falls back to the opportunity default, which is 30 for everything', async () => {
    const { container } = renderDetail();
    await briefLanded();

    expect(container.textContent).not.toContain('30 min');
  });

  it('takes the figure from the study, not from the opportunity', async () => {
    // The opportunity says 30 and the study says 45. The study wins, because
    // the opportunity's value is a column default for a field this type never
    // shows.
    brief(45);
    renderDetail();
    await briefLanded();

    expect(screen.getByText('45 min')).toBeInTheDocument();
    expect(screen.queryByText('30 min')).toBeNull();
  });

  it('still shows a bookable study its own duration, which is asked for', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      ...base,
      type: 'test',
      firsthand_study_id: null,
      default_duration_minutes: 45,
      sessions: [],
    } as never);
    renderDetail();
    // A bookable study fetches no brief, so the title IS the loaded signal here.
    await screen.findByText(base.title);

    expect(screen.getByText('DURATION')).toBeInTheDocument();
    expect(screen.getByText('45 min')).toBeInTheDocument();
  });
});
