import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getRecordedStudyBrief } from '../../api/client';

// Every surface renames types for participants - `unmoderated` reads as
// "Recorded study" - but this page kept calling the old admin formatter and
// printed the raw type name in its hero badge. That is the
// one word participant copy is not allowed to use, and it lands on the page
// that IS the entry point: the shareable link goes straight here, so most
// participants never see the browse index at all.
//
// The role-gated status badge beside it is a separate thing and stays: an admin
// checking a draft needs to know it is a draft.

const recordedStudy = {
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

const auth = vi.hoisted(() => ({
  value: { user: { id: 'u1', role: 'employee', name: 'E' }, loading: false } as {
    user: { id: string; role: string; name: string } | null;
    loading: boolean;
  },
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }));
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

beforeEach(() => {
  vi.clearAllMocks();
  auth.value = { user: { id: 'u1', role: 'employee', name: 'E' }, loading: false };
  vi.mocked(getOpportunity).mockResolvedValue({ ...recordedStudy } as never);
  vi.mocked(getRecordedStudyBrief).mockResolvedValue({
    task_count: 1,
    records_screen_and_voice: true,
    requires_chromium: true,
    estimated_duration_minutes: null,
  });
});

describe('OpportunityDetail type badge', () => {
  // Scoped to the hero badge row: "recorded session" also appears in the
  // disclosure block and on the start button, so a page-wide text query would
  // pass without the badge ever changing.
  it('names the type in its hero badge the way a participant is told everywhere else', async () => {
    const { container } = renderDetail();
    await screen.findByText(recordedStudy.title);

    const badgeRow = container.querySelector('.mission-brief-content > div');
    expect(badgeRow).not.toBeNull();
    expect(badgeRow?.textContent).toMatch(/recorded session/i);
  });

  it('never shows a participant the word "unmoderated"', async () => {
    const { container } = renderDetail();
    await screen.findByText(recordedStudy.title);
    expect(container.textContent).not.toMatch(/unmoderated/i);
  });

  it('shows an admin the same participant-facing name, because this is the participant page', async () => {
    auth.value = { user: { id: 'a1', role: 'researcher_admin', name: 'A' }, loading: false };
    const { container } = renderDetail();
    await screen.findByText(recordedStudy.title);
    expect(container.textContent).not.toMatch(/unmoderated/i);
  });

  it('still shows an admin the status, which is admin-only and stays', async () => {
    auth.value = { user: { id: 'a1', role: 'researcher_admin', name: 'A' }, loading: false };
    renderDetail();
    expect(await screen.findByText('published')).toBeInTheDocument();
  });

  it('does not show a participant the status', async () => {
    const { container } = renderDetail();
    await screen.findByText(recordedStudy.title);
    expect(container.textContent).not.toMatch(/published/i);
  });

  it('renders a lucide glyph in the hero badge (Decision 6), not just a label', async () => {
    // studyTypeIcons.test.ts tests the type-to-glyph map in isolation; a
    // review gate found that removing the glyph from this page's own JSX
    // would keep the whole suite green regardless.
    const { container } = renderDetail();
    await screen.findByText(recordedStudy.title);

    const badgeRow = container.querySelector('.mission-brief-content > div');
    expect(badgeRow?.querySelector('svg.lozenge__glyph')).not.toBeNull();
  });
});
