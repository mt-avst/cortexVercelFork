import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import {
  getOpportunity,
  getRecordedStudyBrief,
  startRecordedStudySession,
  startSurveySession,
  trackOpportunityClick
} from '../../api/client';

/**
 * cto/AdaptaLabs#129, the participant half.
 *
 * TWO THINGS LIVE HERE, both found by the review gate on the backend commit:
 *
 * 1. HIGH - the Resume affordance. Nick's product decision is that somebody
 *    part-way through a survey when the deadline passes may come back and
 *    finish, and the server now delivers it: the mint route's deadline gate
 *    sits BELOW its resume lookup, and the detail read serves a `closed` study
 *    at 200 with `completion.inProgress: true` to that one participant instead
 *    of the 410 everybody else gets. Without a control on this page the
 *    exemption was reachable only by calling the API by hand.
 *
 * 2. MEDIUM-5 - the closed-study message in BOTH start handlers had no test at
 *    all. Dropping either `readClosedStudyRefusal` branch, or making the helper
 *    return null, survived the whole frontend suite: a participant clicking
 *    Start on a study that has closed was told "This study is not yet
 *    available. Please try again later", which is the one sentence on the page
 *    that is actively false. Each test below asserts the server's own sentence
 *    renders AND that the not-yet-available wording does not.
 *
 * The assertions are keyed on the server's `completion.inProgress`, never on a
 * locally-derived guess, because that flag is the same `isInFlightRuntimeSession`
 * predicate the mint route's resume lookup uses - so a page offering Resume is
 * a page whose click that route actually resumes.
 */

const base = {
  id: 'opp-1',
  type: 'survey',
  title: 'Developer experience pulse',
  purpose_one_liner: 'Ten questions about the tools you use every day',
  status: 'published',
  default_duration_minutes: 10,
  participant_type_required: 'any',
  delivery_mode: 'native',
  firsthand_study_id: 'study_questions',
  sessions: [],
};

const CLOSED_LONG_AGO = new Date(Date.now() - 40 * 86400000).toISOString();
const CLOSES_IN_FOUR_DAYS = new Date(Date.now() + 4 * 86400000).toISOString();

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

/**
 * `runTakePart` navigates with `window.location.assign`, which jsdom does not
 * implement - it logs "Not implemented: navigation" and goes nowhere. Swapping
 * in a spy is what makes the destination assertable: without it a test can only
 * observe that the mint was called, which passes just as well when the returned
 * url is dropped on the floor.
 */
const realLocation = window.location;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  load();
  vi.mocked(getRecordedStudyBrief).mockResolvedValue({
    task_count: 1,
    records_screen_and_voice: true,
    requires_chromium: true,
    estimated_duration_minutes: null,
  });
  assign = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...realLocation, assign },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: realLocation,
  });
});

describe('OpportunityDetail resume on a closed study', () => {
  it('offers Resume when the server says this participant is mid-survey', async () => {
    load({
      end_date: CLOSED_LONG_AGO,
      completion: { completed: false, completedAt: null, inProgress: true },
    });
    renderDetail();
    await screen.findByText(base.title);

    expect(
      screen.getByRole('button', { name: 'Resume survey in Cortex' })
    ).toBeEnabled();
    // The label says resume, not start - a fresh start is exactly what the
    // server refuses past the deadline.
    expect(screen.queryByRole('button', { name: /start survey/i })).toBeNull();
  });

  it('keeps the closed-on date beside the Resume button', async () => {
    load({
      end_date: CLOSED_LONG_AGO,
      completion: { completed: false, completedAt: null, inProgress: true },
    });
    renderDetail();
    await screen.findByText(base.title);

    const note = await screen.findByTestId('closed-study-resume-note');
    expect(note).toHaveTextContent(/this study closed on/i);
    expect(note).toHaveTextContent(/you can still finish the survey you already started/i);
  });

  it('sends a Resume click to the session url the mint route hands back', async () => {
    load({
      end_date: CLOSED_LONG_AGO,
      completion: { completed: false, completedAt: null, inProgress: true },
    });
    vi.mocked(startSurveySession).mockResolvedValue({ session_url: '/survey/fh_resume_tok' } as never);
    renderDetail();
    await screen.findByText(base.title);

    fireEvent.click(screen.getByRole('button', { name: 'Resume survey in Cortex' }));

    await waitFor(() => expect(startSurveySession).toHaveBeenCalledWith('opp-1'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/survey/fh_resume_tok'));
  });

  it('names the poll and the one-question study in the Resume label', async () => {
    load({
      type: 'poll',
      end_date: CLOSED_LONG_AGO,
      completion: { completed: false, completedAt: null, inProgress: true },
    });
    const { unmount } = renderDetail();
    expect(
      await screen.findByRole('button', { name: 'Resume poll in Cortex' })
    ).toBeVisible();
    unmount();

    load({
      type: 'question',
      end_date: CLOSED_LONG_AGO,
      completion: { completed: false, completedAt: null, inProgress: true },
    });
    renderDetail();
    expect(
      await screen.findByRole('button', { name: 'Resume question in Cortex' })
    ).toBeVisible();
  });

  it('shows no control on a closed study when inProgress is false', async () => {
    load({
      end_date: CLOSED_LONG_AGO,
      completion: { completed: false, completedAt: null, inProgress: false },
    });
    renderDetail();
    await screen.findByText(base.title);

    expect(screen.queryByRole('button', { name: /resume survey/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /start survey/i })).toBeNull();
    expect(screen.getByText(/this study closed on/i)).toBeVisible();
    expect(screen.queryByTestId('closed-study-resume-note')).toBeNull();
  });

  it('shows no control on a closed study when completion is absent altogether', async () => {
    load({ end_date: CLOSED_LONG_AGO });
    renderDetail();
    await screen.findByText(base.title);

    expect(screen.queryByRole('button', { name: /resume survey/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /start survey/i })).toBeNull();
    expect(screen.getByText(/this study closed on/i)).toBeVisible();
  });

  /**
   * A completed session and an in-flight one are mutually exclusive server
   * side, but the page must not fall apart if they ever arrive together: an
   * answered survey is refused a second mint with a 409, so the completion
   * state wins and no Resume button is offered.
   */
  it('prefers the completed state over Resume when both flags arrive', async () => {
    load({
      end_date: CLOSED_LONG_AGO,
      completion: { completed: true, completedAt: '2026-09-02T09:00:00.000Z', inProgress: true },
    });
    renderDetail();
    await screen.findByText(base.title);

    expect(await screen.findByTestId('survey-completed-state')).toBeVisible();
    expect(screen.queryByRole('button', { name: /resume survey/i })).toBeNull();
  });

  /**
   * The resume exemption is for the NATIVE runtime only - an external survey
   * hands off with window.open, the server never sees the navigation, and
   * there is no runtime session to resume. An `inProgress` flag on one of
   * those must not conjure a control on a closed study.
   */
  it('ignores inProgress on an external survey that has closed', async () => {
    load({
      delivery_mode: 'external',
      firsthand_study_id: undefined,
      external_link_optional: 'https://example.com/survey',
      end_date: CLOSED_LONG_AGO,
      completion: { completed: false, completedAt: null, inProgress: true },
    });
    renderDetail();
    await screen.findByText(base.title);

    expect(screen.queryByRole('button', { name: /resume/i })).toBeNull();
    expect(screen.getByText(/this study closed on/i)).toBeVisible();
  });
});

/**
 * WHAT THE OPEN-STUDY CASE ALREADY DID, pinned rather than changed in silence.
 *
 * The mint route resumes an in-flight session BEFORE it looks at the deadline,
 * so a returning participant on an OPEN study was already being resumed - the
 * button just said "Start survey" while doing it. The action is unchanged here;
 * only the wording now matches what the click does, on both sides of the
 * deadline.
 */
describe('OpportunityDetail resume on an open study', () => {
  it('labels the button Resume for a mid-survey participant before the deadline', async () => {
    load({
      end_date: CLOSES_IN_FOUR_DAYS,
      completion: { completed: false, completedAt: null, inProgress: true },
    });
    renderDetail();
    await screen.findByText(base.title);

    expect(
      screen.getByRole('button', { name: 'Resume survey in Cortex' })
    ).toBeEnabled();
    // No closed-study wording: the study is open, the participant is simply
    // coming back to it.
    expect(screen.queryByText(/this study closed on/i)).toBeNull();
  });

  it('resumes through the same survey route the Start button uses', async () => {
    load({
      end_date: CLOSES_IN_FOUR_DAYS,
      completion: { completed: false, completedAt: null, inProgress: true },
    });
    vi.mocked(startSurveySession).mockResolvedValue({ session_url: '/survey/fh_open_tok' } as never);
    renderDetail();
    await screen.findByText(base.title);

    fireEvent.click(screen.getByRole('button', { name: 'Resume survey in Cortex' }));

    await waitFor(() => expect(startSurveySession).toHaveBeenCalledWith('opp-1'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/survey/fh_open_tok'));
    expect(trackOpportunityClick).toHaveBeenCalledWith('opp-1', 'action');
  });

  it('still says Start for a participant with no session in flight', async () => {
    load({
      end_date: CLOSES_IN_FOUR_DAYS,
      completion: { completed: false, completedAt: null, inProgress: false },
    });
    renderDetail();
    await screen.findByText(base.title);

    expect(
      screen.getByRole('button', { name: 'Start survey in Cortex' })
    ).toBeEnabled();
    expect(screen.queryByRole('button', { name: /resume survey/i })).toBeNull();
  });
});

/**
 * MEDIUM-5: the refusal message, on both handlers. `readClosedStudyRefusal`
 * keys on the CODE rather than the 403, because the two 403s a mint route sends
 * mean opposite things - one is terminal, the other is a study that may yet
 * open - and both used to render the same "not yet available" sentence.
 */
describe('OpportunityDetail closed-study refusal on the native survey handler', () => {
  const clickStart = async () => {
    renderDetail();
    await screen.findByText(base.title);
    fireEvent.click(screen.getByRole('button', { name: 'Start survey in Cortex' }));
  };

  it('renders the servers closed sentence when the survey mint is refused', async () => {
    load({ end_date: CLOSES_IN_FOUR_DAYS });
    vi.mocked(startSurveySession).mockRejectedValue({
      response: {
        status: 403,
        data: {
          code: 'OPPORTUNITY_CLOSED',
          error: 'This study closed on 2 September 2026 and is no longer accepting responses.'
        }
      }
    });

    await clickStart();

    expect(
      await screen.findByText(/no longer accepting responses/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/not yet available/i)).toBeNull();
  });

  it('falls back to its own closed wording when the survey refusal carries no sentence', async () => {
    load({ end_date: CLOSES_IN_FOUR_DAYS });
    vi.mocked(startSurveySession).mockRejectedValue({
      response: { status: 403, data: { code: 'OPPORTUNITY_CLOSED' } }
    });

    await clickStart();

    expect(
      await screen.findByText(/this study has closed and is no longer accepting participants/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/not yet available/i)).toBeNull();
  });

  it('keeps the not-yet-open wording for a 403 without the closed code', async () => {
    load({ end_date: CLOSES_IN_FOUR_DAYS });
    vi.mocked(startSurveySession).mockRejectedValue({
      response: { status: 403, data: { error: 'Study is not published' } }
    });

    await clickStart();

    expect(await screen.findByText(/not yet available/i)).toBeInTheDocument();
    expect(screen.queryByText(/no longer accepting/i)).toBeNull();
  });
});

describe('OpportunityDetail closed-study refusal on the recorded study handler', () => {
  const recorded = {
    type: 'unmoderated',
    delivery_mode: undefined,
    firsthand_study_id: 'study_tasks',
    end_date: CLOSES_IN_FOUR_DAYS,
  };

  const clickStart = async () => {
    renderDetail();
    await screen.findByText(base.title);
    fireEvent.click(screen.getByRole('button', { name: 'Start recorded study' }));
  };

  it('renders the servers closed sentence when the recorded mint is refused', async () => {
    load(recorded);
    vi.mocked(startRecordedStudySession).mockRejectedValue({
      response: {
        status: 403,
        data: {
          code: 'OPPORTUNITY_CLOSED',
          error: 'This study closed on 2 September 2026 and is no longer accepting responses.'
        }
      }
    });

    await clickStart();

    expect(
      await screen.findByText(/no longer accepting responses/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/not yet available/i)).toBeNull();
  });

  it('falls back to its own closed wording when the recorded refusal carries no sentence', async () => {
    load(recorded);
    vi.mocked(startRecordedStudySession).mockRejectedValue({
      response: { status: 403, data: { code: 'OPPORTUNITY_CLOSED' } }
    });

    await clickStart();

    expect(
      await screen.findByText(/this study has closed and is no longer accepting participants/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/not yet available/i)).toBeNull();
  });

  it('keeps the not-yet-open wording for a recorded 403 without the closed code', async () => {
    load(recorded);
    vi.mocked(startRecordedStudySession).mockRejectedValue({
      response: { status: 403, data: { error: 'Study is not published' } }
    });

    await clickStart();

    expect(await screen.findByText(/not yet available/i)).toBeInTheDocument();
    expect(screen.queryByText(/no longer accepting/i)).toBeNull();
  });
});
