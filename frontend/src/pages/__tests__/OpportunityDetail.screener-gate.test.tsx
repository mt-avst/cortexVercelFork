import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import {
  bookSession,
  getOpportunity,
  startRecordedStudySession,
  startSurveySession,
  submitScreener
} from '../../api/client';

/**
 * The screener gate on the participant page (MR2).
 *
 * A screener gates EVERY take-part path, fail-closed:
 *  - booking (both surfaces funnel through handleBookSession)
 *  - a native survey / poll / one-question run
 *  - a recorded study
 *  - a window.open hand-off to an external tool (the one client-only gate)
 *
 * Each path, in both directions: nothing happens until the participant
 * qualifies, and a screen-out blocks it entirely.
 */

const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const end = new Date(start.getTime() + 60 * 60 * 1000);

const SCREENER = {
  questions: [
    {
      id: 'q1',
      prompt: 'Which best describes your role?',
      options: [
        { id: 'o1', label: 'Engineer' },
        { id: 'o2', label: 'Something else' }
      ]
    }
  ],
  screenedOutMessage: 'Thanks, but not a match this round.'
};

const base = (over: Record<string, unknown> = {}) => ({
  id: 'opp-1',
  title: 'Checkout flow walkthrough',
  purpose_one_liner: 'Find out where people stall in the checkout flow',
  status: 'published',
  participant_type_required: 'any',
  screener: SCREENER,
  screenerStatus: { answered: false },
  ...over
});

const bookableFixture = () =>
  base({
    type: 'test',
    default_duration_minutes: 60,
    // No own wording: the moderated baseline consent applies after the screener.
    consent_text: null,
    consent_template_id: null,
    consent_template_version: null,
    sessions: [
      {
        id: 'sess-1',
        opportunity_id: 'opp-1',
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        capacity: 3,
        remaining: 3
      }
    ]
  });

const nativeSurveyFixture = () =>
  base({ type: 'survey', delivery_mode: 'native', firsthand_study_id: 'study-1' });

const recordedFixture = () =>
  base({ type: 'unmoderated', firsthand_study_id: 'study-1' });

const externalPollFixture = () =>
  base({ type: 'poll', delivery_mode: 'external', external_link_optional: 'https://survey.test/poll' });

// An external `question` renders the ExternalHandoff anchor branch, not the
// take-part button - the fifth path the first cut of this gate missed.
const externalQuestionFixture = () =>
  base({ type: 'question', delivery_mode: 'external', external_link_optional: 'https://survey.test/q' });

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', role: 'employee', name: 'E' },
    loading: false,
    initialAuthCheck: true
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', isDarkMode: false })
}));

vi.mock('../../components/CalendarGrid', () => ({
  CALENDAR_LEGEND_ITEMS: [],
  default: ({ onBookSession }: { onBookSession: (id: string) => void }) => (
    <button
      type="button"
      onClick={() => {
        void Promise.resolve(onBookSession('sess-1')).catch(() => undefined);
      }}
    >
      stub book
    </button>
  )
}));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(),
  trackOpportunityClick: vi.fn().mockResolvedValue(undefined),
  markOpportunityOpened: vi.fn().mockResolvedValue(undefined),
  bookSession: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  getMyBookings: vi.fn(async () => ({ upcoming: [], past: [] })),
  getCalendarConnectionStatus: vi.fn(async () => ({ connected: false, connectedAt: null })),
  getRecordedStudyBrief: vi.fn(async () => null),
  startRecordedStudySession: vi.fn(),
  startSurveySession: vi.fn(),
  submitScreener: vi.fn()
}));

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={['/opportunities/opp-1']}>
      <Routes>
        <Route path="/opportunities/:id" element={<OpportunityDetail />} />
      </Routes>
    </MemoryRouter>
  );

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.clearAllMocks();
  user = userEvent.setup();
  // startSurveySession / startRecordedStudySession assign window.location; keep
  // jsdom from throwing "not implemented".
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign: vi.fn() }
  });
  vi.spyOn(window, 'open').mockImplementation(() => null);
});

/** Answer the one screener question and run the check. */
const answerAndCheck = async (optionName: RegExp) => {
  await screen.findByTestId('screener-check');
  await user.click(screen.getByRole('radio', { name: optionName }));
  await user.click(screen.getByRole('button', { name: /check eligibility/i }));
};

describe('the screener gate on booking', () => {
  it('intercepts a booking, and books nothing until the participant qualifies', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(bookableFixture() as never);
    vi.mocked(submitScreener).mockResolvedValue({ outcome: 'qualified' } as never);
    vi.mocked(bookSession).mockResolvedValue({ id: 'booking-1' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(await screen.findByRole('button', { name: 'stub book' }));

    // Screener first, and nothing booked yet.
    await answerAndCheck(/engineer/i);
    await waitFor(() =>
      expect(submitScreener).toHaveBeenCalledWith('opp-1', { q1: 'o1' })
    );
    expect(bookSession).not.toHaveBeenCalled();

    // On qualify the booking resumes - into the consent gate, since a moderated
    // booking always presents consent - which the participant then accepts.
    await user.click(await screen.findByRole('button', { name: 'Accept and book' }));
    await waitFor(() =>
      expect(bookSession).toHaveBeenCalledWith('sess-1', expect.objectContaining({ consentAccepted: true }))
    );
  });

  it('blocks the booking on a screen-out, showing the not-a-match message', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(bookableFixture() as never);
    vi.mocked(submitScreener).mockResolvedValue({ outcome: 'screened_out' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(await screen.findByRole('button', { name: 'stub book' }));

    await answerAndCheck(/something else/i);

    expect(
      await screen.findByText('Thanks, but not a match this round.')
    ).toBeInTheDocument();
    expect(bookSession).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Accept and book' })).not.toBeInTheDocument();
  });
});

describe('the screener gate on a native survey', () => {
  it('checks eligibility before minting the survey session', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(nativeSurveyFixture() as never);
    vi.mocked(submitScreener).mockResolvedValue({ outcome: 'qualified' } as never);
    vi.mocked(startSurveySession).mockResolvedValue({ session_url: '/run/1' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: /start survey/i }));

    expect(startSurveySession).not.toHaveBeenCalled();
    await answerAndCheck(/engineer/i);

    await waitFor(() => expect(startSurveySession).toHaveBeenCalledWith('opp-1'));
  });

  it('does not mint a survey session on a screen-out', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(nativeSurveyFixture() as never);
    vi.mocked(submitScreener).mockResolvedValue({ outcome: 'screened_out' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: /start survey/i }));
    await answerAndCheck(/something else/i);

    expect(await screen.findByText('Thanks, but not a match this round.')).toBeInTheDocument();
    expect(startSurveySession).not.toHaveBeenCalled();
  });
});

describe('the screener gate on a recorded study', () => {
  it('checks eligibility before minting the recorded session', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedFixture() as never);
    vi.mocked(submitScreener).mockResolvedValue({ outcome: 'qualified' } as never);
    vi.mocked(startRecordedStudySession).mockResolvedValue({ session_url: '/run/1' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: /start recorded study/i }));

    expect(startRecordedStudySession).not.toHaveBeenCalled();
    await answerAndCheck(/engineer/i);

    await waitFor(() => expect(startRecordedStudySession).toHaveBeenCalledWith('opp-1'));
  });
});

describe('the screener gate on an external hand-off (client-only ceiling)', () => {
  it('checks eligibility before opening the external tool', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(externalPollFixture() as never);
    vi.mocked(submitScreener).mockResolvedValue({ outcome: 'qualified' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: /open poll/i }));

    expect(window.open).not.toHaveBeenCalled();
    await answerAndCheck(/engineer/i);

    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        'https://survey.test/poll',
        '_blank',
        'noopener,noreferrer'
      )
    );
  });

  it('does not open the external tool on a screen-out', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(externalPollFixture() as never);
    vi.mocked(submitScreener).mockResolvedValue({ outcome: 'screened_out' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: /open poll/i }));
    await answerAndCheck(/something else/i);

    expect(await screen.findByText('Thanks, but not a match this round.')).toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();
  });

  // The external `question` type renders the ExternalHandoff anchor rather than
  // the take-part button, so it is a separate path - and the first cut of this
  // gate left it a plain <a href> that navigated with no check at all. It must
  // be gated the same way, and must not render a raw navigable link.
  it('gates the external-question hand-off, which renders an anchor not the button', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(externalQuestionFixture() as never);
    vi.mocked(submitScreener).mockResolvedValue({ outcome: 'qualified' } as never);

    renderDetail();
    // No raw navigable link is offered while the screener gates.
    expect(
      screen.queryByRole('link', { name: /answer question/i })
    ).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /answer question/i }));
    expect(window.open).not.toHaveBeenCalled();

    await answerAndCheck(/engineer/i);
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        'https://survey.test/q',
        '_blank',
        'noopener,noreferrer'
      )
    );
  });

  it('does not open the external-question tool on a screen-out', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(externalQuestionFixture() as never);
    vi.mocked(submitScreener).mockResolvedValue({ outcome: 'screened_out' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: /answer question/i }));
    await answerAndCheck(/something else/i);

    expect(await screen.findByText('Thanks, but not a match this round.')).toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();
  });
});

describe('an opportunity the participant has already qualified for', () => {
  it('does not gate again', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      base({
        type: 'survey',
        delivery_mode: 'native',
        firsthand_study_id: 'study-1',
        screenerStatus: { answered: true, outcome: 'qualified' }
      }) as never
    );
    vi.mocked(startSurveySession).mockResolvedValue({ session_url: '/run/1' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: /start survey/i }));

    // Straight through - no screener modal.
    await waitFor(() => expect(startSurveySession).toHaveBeenCalledWith('opp-1'));
    expect(screen.queryByTestId('screener-check')).not.toBeInTheDocument();
  });
});

describe('the admin/owner payload shape (screener present, screenerStatus absent)', () => {
  it('still gates, because the server enforces the screener for admins too', async () => {
    // Since #134 the admin/owner payload DOES carry `screenerStatus`, but this
    // test pins the fail-closed property for the case where it is absent: the
    // gate keys on screener PRESENCE, not status presence, so it must still fire.
    // `assertScreenerPassed` 403s admins just like anyone else, so the gate MUST
    // fire for this shape - otherwise an admin (every internal beta tester, via
    // CORTEX_BETA_ALL_ADMIN) clicks straight to a server 403 with no modal to
    // answer through. Keyed on screener presence, deliberately (cto/AdaptaLabs#134).
    vi.mocked(getOpportunity).mockResolvedValue(
      base({
        type: 'survey',
        delivery_mode: 'native',
        firsthand_study_id: 'study-1',
        // Admin shape: the full screener with owner-only flags, and no status.
        screener: {
          ...SCREENER,
          questions: SCREENER.questions.map((q) => ({
            ...q,
            options: q.options.map((o, i) => ({ ...o, disqualifies: i === 1 }))
          }))
        },
        screenerStatus: undefined
      }) as never
    );
    vi.mocked(submitScreener).mockResolvedValue({ outcome: 'qualified' } as never);
    vi.mocked(startSurveySession).mockResolvedValue({ session_url: '/run/1' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: /start survey/i }));

    // The gate fires so the admin can answer, rather than hitting a raw 403.
    expect(startSurveySession).not.toHaveBeenCalled();
    await answerAndCheck(/engineer/i);
    await waitFor(() => expect(startSurveySession).toHaveBeenCalledWith('opp-1'));

    // And the owner-only disqualifies flag never renders in the modal.
    expect(screen.queryByText(/screen out/i)).not.toBeInTheDocument();
  });
});
