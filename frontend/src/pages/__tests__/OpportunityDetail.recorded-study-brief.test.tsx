import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getRecordedStudyBrief } from '../../api/client';

// The landing page for a recorded study is where a participant decides. Until
// this block existed the page said only what the researcher had typed, so a
// study described as "THIS IS A TEST" asked someone to start a screen-and-voice
// recording having told them nothing. These pin the disclosure to the page
// rather than to the description.

const recordedStudy = {
  id: 'opp-1',
  type: 'unmoderated',
  title: 'Triage a failing Bitbucket pipeline',
  purpose_one_liner: 'Twenty minutes on your own, recorded',
  status: 'published',
  default_duration_minutes: 30,
  participant_type_required: 'any',
  firsthand_study_id: 'study_abc123',
  sessions: [],
};

const poll = {
  ...recordedStudy,
  type: 'poll',
  firsthand_study_id: null,
  external_link_optional: 'https://forms.gle/example',
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOpportunity).mockResolvedValue({ ...recordedStudy } as never);
  vi.mocked(getRecordedStudyBrief).mockResolvedValue({
    task_count: 4,
    records_screen_and_voice: true,
    requires_chromium: true,
    estimated_duration_minutes: null,
  });
});

describe('OpportunityDetail - recorded study brief', () => {
  it('discloses the recording before the button that starts it', async () => {
    renderDetail();

    expect(await screen.findByText(/records your screen and your voice/i)).toBeVisible();
    expect(screen.getByText(/never your camera/i)).toBeVisible();
  });

  it('states the study shape from the brief rather than from the description', async () => {
    renderDetail();

    expect(await screen.findByText(/4 tasks, worked through one at a time/i)).toBeVisible();
  });

  // Queried through the specs item rather than by text: the expectations copy
  // also contains "4 tasks", so a getByText would pass with this whole block
  // deleted. It was, and the mutation survived.
  it('puts the task count in the specs box', async () => {
    renderDetail();

    const label = await screen.findByText('TASKS');
    expect(label.parentElement).toHaveTextContent('4');
  });

  // Unmoderated has no duration field in the authoring form, so any number here
  // is the column default rather than anything a researcher chose.
  it('shows no duration for a recorded study, because none was ever authored', async () => {
    renderDetail();

    await screen.findByText('TASKS');
    expect(screen.queryByText('DURATION')).toBeNull();
    expect(screen.queryByText(/30 min/)).toBeNull();
  });

  // The disclosure must not be contingent on a second network call. If it were,
  // an API blip would produce a page that asks for a recording without saying so.
  it('still discloses the recording when the brief request fails', async () => {
    vi.mocked(getRecordedStudyBrief).mockRejectedValue(new Error('network'));
    renderDetail();

    expect(await screen.findByText(/records your screen and your voice/i)).toBeVisible();
    expect(screen.queryByText(/4 tasks/i)).toBeNull();
  });

  it('labels the button in participant vocabulary, not "Start Test"', async () => {
    renderDetail();

    const cta = await screen.findByRole('button', { name: /start recorded study/i });
    expect(cta).toBeVisible();
    // The accessible name comes from the aria-label, so asserting on the role
    // name alone passes even when the visible text still reads "Start Test"
    // (this mutation survived). The text a participant actually reads has to be
    // asserted separately.
    expect(cta).toHaveTextContent(/^Start recorded study$/);
  });

  it('asks for no brief, and shows no expectations, for a poll', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({ ...poll } as never);
    renderDetail();

    expect(await screen.findByRole('button', { name: /open poll/i })).toBeVisible();
    expect(screen.queryByText(/records your screen and your voice/i)).toBeNull();
    expect(getRecordedStudyBrief).not.toHaveBeenCalled();
  });

  // The poll fixture is BOTH the wrong type AND has no study id, so it is
  // satisfied by either guard alone. These two isolate them. Without the type
  // guard a question-type opportunity carrying a linked study would fetch a
  // brief and tell the participant it records their screen.
  it('asks for no brief for a non-unmoderated type that still carries a linked study', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      ...recordedStudy,
      type: 'question',
      external_link_optional: 'https://forms.gle/example',
    } as never);
    renderDetail();

    // A question renders an anchor, not a button.
    await screen.findByRole('link', { name: /answer question/i });
    expect(getRecordedStudyBrief).not.toHaveBeenCalled();
    expect(screen.queryByText(/records your screen and your voice/i)).toBeNull();
  });

  it('asks for no brief for an unmoderated opportunity with no study linked', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      ...recordedStudy,
      firsthand_study_id: null,
      external_link_optional: 'https://example.com/study',
    } as never);
    renderDetail();

    // And it must not call itself a recorded study: this path opens a link and
    // records nothing at all.
    const cta = await screen.findByRole('button', { name: /open study in new tab/i });
    expect(cta).toHaveTextContent(/^Open Study$/);
    expect(getRecordedStudyBrief).not.toHaveBeenCalled();
    expect(screen.queryByText(/records your screen and your voice/i)).toBeNull();
  });
});
