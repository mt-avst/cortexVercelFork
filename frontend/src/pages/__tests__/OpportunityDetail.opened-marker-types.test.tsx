import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, markOpportunityOpened } from '../../api/client';

/**
 * "New since your last visit" (cto/AdaptaLabs#168): `markOpportunityOpened`
 * must fire once, with the loaded id, for a PUBLISHED study of every type
 * (not only the poll/survey/unmoderated subset `trackOpportunityClick(id,
 * 'view')` accepts - the whole reason this route exists) - and must NEVER
 * fire for a draft, a closed study, or a signed-out viewer.
 * `OpportunityDetail.opened-marker.test.tsx` pins the per-study-id ref shape;
 * this file pins the gate itself.
 */

const base = {
  id: 'opp-1',
  title: 'Opened-marker fixture',
  purpose_one_liner: 'Proving the opened marker fires for every type',
  default_duration_minutes: 30,
  participant_type_required: 'any',
  sessions: [] as unknown[],
};

vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/CalendarGrid', () => ({
  default: () => null,
  CALENDAR_LEGEND_ITEMS: [],
}));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(),
  trackOpportunityClick: vi.fn().mockResolvedValue(undefined),
  markOpportunityOpened: vi.fn().mockResolvedValue(undefined),
  bookSession: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  getRecordedStudyBrief: vi.fn().mockResolvedValue({
    task_count: 1,
    records_screen_and_voice: true,
    requires_chromium: true,
    estimated_duration_minutes: null,
  }),
  startRecordedStudySession: vi.fn(),
  startSurveySession: vi.fn(),
}));

let currentUser: { id: string; role: string; name: string } | null = {
  id: 'u1',
  role: 'employee',
  name: 'E',
};
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: currentUser, loading: false }),
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

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'u1', role: 'employee', name: 'E' };
});

describe('OpportunityDetail opened-marker gate (#168)', () => {
  it.each([
    ['test'],
    ['interview'],
    ['poll'],
    ['survey'],
    ['question'],
    ['unmoderated'],
  ])('marks a published %s study opened, once, with the loaded id', async (type) => {
    vi.mocked(getOpportunity).mockResolvedValue({
      ...base,
      type,
      status: 'published',
    } as never);

    renderDetail();
    await screen.findByText('Opened-marker fixture');

    await waitFor(() => expect(vi.mocked(markOpportunityOpened)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(markOpportunityOpened)).toHaveBeenCalledWith('opp-1');
  });

  it('never marks a DRAFT study, whatever its type', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      ...base,
      type: 'unmoderated',
      status: 'draft',
    } as never);

    renderDetail();
    await screen.findByText('Opened-marker fixture');
    await settle();

    expect(vi.mocked(markOpportunityOpened)).not.toHaveBeenCalled();
  });

  it('never marks a CLOSED study', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      ...base,
      type: 'unmoderated',
      status: 'closed',
    } as never);

    renderDetail();
    await screen.findByText('Opened-marker fixture');
    await settle();

    expect(vi.mocked(markOpportunityOpened)).not.toHaveBeenCalled();
  });

  it('never marks a study for a signed-out viewer', async () => {
    currentUser = null;
    vi.mocked(getOpportunity).mockResolvedValue({
      ...base,
      type: 'unmoderated',
      status: 'published',
    } as never);

    renderDetail();
    await screen.findByText('Opened-marker fixture');
    await settle();

    expect(vi.mocked(markOpportunityOpened)).not.toHaveBeenCalled();
  });

  it('marks it once under React.StrictMode (the dev-only double-invoke)', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      ...base,
      type: 'unmoderated',
      status: 'published',
    } as never);

    render(
      <React.StrictMode>
        <MemoryRouter initialEntries={['/opportunities/opp-1']}>
          <Routes>
            <Route path="/opportunities/:id" element={<OpportunityDetail />} />
          </Routes>
        </MemoryRouter>
      </React.StrictMode>
    );
    await screen.findByText('Opened-marker fixture');

    await waitFor(() => expect(vi.mocked(markOpportunityOpened)).toHaveBeenCalledTimes(1));
  });

  it('a rejected /opened call leaves the page rendered - no crash, no error UI', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      ...base,
      type: 'unmoderated',
      status: 'published',
    } as never);
    vi.mocked(markOpportunityOpened).mockRejectedValueOnce(new Error('network down'));

    renderDetail();
    await screen.findByText('Opened-marker fixture');
    await settle();

    // Still on the page, unharmed - markOpportunityOpened's own rejection
    // (client.ts fails closed in production; this simulates a caller that did
    // not) must not take the study title or its content down with it.
    expect(screen.getByText('Opened-marker fixture')).toBeVisible();
  });
});
