import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import {
  getOpportunity,
  getRecordedStudyBrief,
  startSurveySession,
  trackOpportunityClick
} from '../../api/client';

/**
 * The call to action must not be offered when pressing it does nothing.
 *
 * The handoff branch runs only for an unmoderated opportunity with a linked
 * study, and everything else falls through to opening the external link. A
 * NATIVE poll or survey used to have a study and no link, so it satisfied the
 * old "has one or the other" test: the button rendered enabled and the click
 * fell through both branches and returned silently, without even recording the
 * click. It has its own branch and its own route now, so what this file pins is
 * that each type reaches the right one.
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
  // Without this the import is undefined at the call site, and a click test
  // passes by asserting the GENERIC error message - the TypeError has no
  // err.response.status, so it never reaches the API at all. A naive click test
  // reads as coverage it does not have.
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
  });
});

describe('OpportunityDetail call to action', () => {
  /**
   * The premise of this test changed rather than disappearing. It used to
   * assert the button was DISABLED, because a native survey had no runner and
   * an enabled control would have done nothing on click. Now there is one, so
   * the surviving guarantee is that the button is offered, says it starts here,
   * and does not claim to open a new tab.
   */
  it('offers a native survey a start button that stays in Cortex', async () => {
    load({ delivery_mode: 'native', firsthand_study_id: 'study_questions' });
    renderDetail();
    await screen.findByText(base.title);

    expect(
      screen.getByRole('button', { name: /start survey in Cortex/i })
    ).toBeEnabled();
    expect(screen.queryByText(/Opens in a new tab/i)).toBeNull();
  });

  it('still refuses a native survey with no questions linked', async () => {
    load({ delivery_mode: 'native', firsthand_study_id: undefined });
    renderDetail();
    await screen.findByText(base.title);

    expect(
      screen.getByRole('button', { name: /start survey in Cortex/i })
    ).toBeDisabled();
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

describe('OpportunityDetail starting a native survey', () => {
  beforeEach(() => {
    load({ delivery_mode: 'native', firsthand_study_id: 'study_questions' });
  });

  const start = async () => {
    renderDetail();
    await screen.findByText(base.title);
    fireEvent.click(screen.getByRole('button', { name: /start survey in Cortex/i }));
  };

  /**
   * The endpoint matters and nothing else asserted it: pointing this at
   * startRecordedStudySession passed all 659 tests while 404ing in production,
   * because that route refuses anything that is not an unmoderated study.
   */
  it('mints through the survey route, not the recorded one', async () => {
    vi.mocked(startSurveySession).mockResolvedValue({ session_url: '/survey/fh_tok' });

    await start();

    await waitFor(() => expect(startSurveySession).toHaveBeenCalledWith('opp-1'));
    expect(trackOpportunityClick).toHaveBeenCalledWith('opp-1', 'action');
  });

  it('says the survey is unavailable when the API refuses it', async () => {
    vi.mocked(startSurveySession).mockRejectedValue({ response: { status: 404 } });

    await start();

    expect(await screen.findByText(/survey is not available/i)).toBeInTheDocument();
  });

  it('distinguishes an opportunity that is not open yet', async () => {
    vi.mocked(startSurveySession).mockRejectedValue({ response: { status: 403 } });

    await start();

    expect(await screen.findByText(/not yet available/i)).toBeInTheDocument();
  });

  it('falls back to a generic message, and re-enables the button', async () => {
    vi.mocked(startSurveySession).mockRejectedValue(new Error('offline'));

    await start();

    expect(await screen.findByText(/Could not open the survey/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /start survey in Cortex/i })
    ).toBeEnabled();
  });

  // The API refuses a second mint once a session is completed or uploading
  // (re-answering would silently overwrite the stored responses), but this
  // fell through to the same unhelpful generic message as an actual failure -
  // nothing here told the participant they had simply already answered.
  it('says so when the participant has already answered', async () => {
    vi.mocked(startSurveySession).mockRejectedValue({ response: { status: 409 } });

    await start();

    expect(
      await screen.findByText(/already answered this survey/i)
    ).toBeInTheDocument();
  });
});
