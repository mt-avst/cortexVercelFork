import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity } from '../../api/client';

// DT-7: poll, survey and question carried NO time expectation on the detail
// page - they have no duration source (the form only collects minutes for
// test/interview), so their metadata box either omitted the row or, when it
// had no other rows, did not render at all (DT-6). Every type should say
// roughly how long taking part takes. These pin an HONEST QUALITATIVE
// expectation - no invented minute figure - shown under DURATION for the three
// native short-form types, and confirm the deliberately-omitted cases (a
// recorded study with no chosen length) are left alone.

const base = {
  id: 'opp-1',
  title: 'A quick question about your workflow',
  purpose_one_liner: 'One thing we want to know',
  status: 'published',
  default_duration_minutes: 30, // the column default that must never surface
  participant_type_required: 'any',
  // NATIVE delivery: Cortex runs the interaction, so it can honestly say how
  // long it takes. An external hand-off (delivery_mode: 'external') gets no
  // expectation - see the external-delivery test below.
  delivery_mode: 'native',
  firsthand_study_id: null,
  external_link_optional: null,
  product_optional: null,
  sessions: [],
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'employee', name: 'E' }, loading: false }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));
vi.mock('../../components/CalendarGrid', () => ({ default: () => null, CALENDAR_LEGEND_ITEMS: [] }));

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

const load = (overrides: Record<string, unknown>) => {
  vi.mocked(getOpportunity).mockResolvedValue({ ...base, ...overrides } as never);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('native short-form types carry an honest time expectation', () => {
  it('a poll says "Under a minute", never the column default of 30', async () => {
    load({ type: 'poll', title: 'Release cadence poll' });
    const { container } = renderDetail();
    await screen.findByText('Release cadence poll');

    expect(screen.getByText('DURATION')).toBeInTheDocument();
    expect(screen.getByText('Under a minute')).toBeInTheDocument();
    expect(container.textContent).not.toContain('30 min');
  });

  it('a single question says "Under a minute"', async () => {
    load({ type: 'question', title: 'One quick question' });
    renderDetail();
    await screen.findByText('One quick question');

    expect(screen.getByText('DURATION')).toBeInTheDocument();
    expect(screen.getByText('Under a minute')).toBeInTheDocument();
  });

  it('a survey says "A few minutes"', async () => {
    load({ type: 'survey', title: 'Short satisfaction survey' });
    renderDetail();
    await screen.findByText('Short satisfaction survey');

    expect(screen.getByText('DURATION')).toBeInTheDocument();
    expect(screen.getByText('A few minutes')).toBeInTheDocument();
  });

  it('renders the metadata box for a bare poll that would otherwise be empty (the expectation is a real row)', async () => {
    load({ type: 'poll', title: 'Bare poll' });
    const { container } = renderDetail();
    await screen.findByText('Bare poll');

    // DT-6 hid the box when every row was empty; the expectation is a genuine
    // row, so the box returns with content rather than empty.
    expect(container.querySelector('.mission-data-box')).not.toBeNull();
  });
});

describe('deliberately-omitted durations are left alone', () => {
  it('a test still shows its real chosen minutes, not the expectation copy', async () => {
    load({ type: 'test', default_duration_minutes: 45, sessions: [] });
    const { container } = renderDetail();
    await screen.findByText(base.title);

    expect(screen.getByText('DURATION')).toBeInTheDocument();
    expect(screen.getByText('45 min')).toBeInTheDocument();
    expect(container.textContent).not.toContain('Under a minute');
    expect(container.textContent).not.toContain('A few minutes');
  });

  it('an EXTERNAL survey makes no time claim, because Cortex does not run it', async () => {
    // The exact fabrication DT-7 must avoid: a third-party form of unknown
    // length would otherwise read "A few minutes". Gated on native delivery,
    // so an external survey says nothing.
    load({
      type: 'survey',
      delivery_mode: 'external',
      external_link_optional: 'https://forms.example.com/s',
      title: 'External satisfaction survey',
    });
    const { container } = renderDetail();
    await screen.findByText('External satisfaction survey');

    expect(container.textContent).not.toContain('A few minutes');
    expect(container.textContent).not.toContain('Under a minute');
  });
});
