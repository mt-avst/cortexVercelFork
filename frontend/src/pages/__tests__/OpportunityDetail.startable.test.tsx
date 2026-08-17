import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getRecordedStudyBrief } from '../../api/client';

/**
 * The call to action must not be offered when pressing it does nothing.
 *
 * The handoff branch runs only for an unmoderated opportunity with a linked
 * study, and everything else falls through to opening the external link. A
 * NATIVE poll or survey has a study and no link, so it satisfied the old "has
 * one or the other" test: the button rendered enabled and the click fell
 * through both branches and returned silently, without even recording the
 * click. The backend can publish that state now, so the page has to be honest
 * about it until the survey runner is routed.
 */

const base = {
  id: 'opp-1',
  type: 'survey',
  title: 'Developer experience pulse',
  purpose_one_liner: 'Ten questions about the tools you use every day',
  status: 'published',
  default_duration_minutes: 10,
  participant_type_required: 'any',
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
  });
});

describe('OpportunityDetail call to action', () => {
  it('does not offer a working button for a native survey with no runner yet', async () => {
    load({ delivery_mode: 'native', firsthand_study_id: 'study_questions' });
    renderDetail();
    await screen.findByText(base.title);

    expect(screen.getByRole('button', { name: /open survey/i })).toBeDisabled();
  });

  it('offers it for an external survey, which is what the link is for', async () => {
    load({
      delivery_mode: 'external',
      external_link_optional: 'https://example.com/survey',
    });
    renderDetail();
    await screen.findByText(base.title);

    expect(screen.getByRole('button', { name: /open survey/i })).toBeEnabled();
  });

  /**
   * The recorded path reads the other field, and must keep working: its start
   * button is enabled by the linked study, with no external link anywhere.
   */
  it('still offers a recorded study its start button', async () => {
    load({
      type: 'unmoderated',
      firsthand_study_id: 'study_abc123',
      external_link_optional: undefined,
    });
    renderDetail();
    await screen.findByText(base.title);

    expect(
      screen.getByRole('button', { name: /start recorded study/i })
    ).toBeEnabled();
  });

  it('disables it for a recorded study with nothing linked at all', async () => {
    load({ type: 'unmoderated', firsthand_study_id: undefined });
    renderDetail();
    await screen.findByText(base.title);

    expect(screen.getByRole('button', { name: /open study/i })).toBeDisabled();
  });
});
