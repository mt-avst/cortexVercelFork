import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityAnalytics from '../OpportunityAnalytics';
import {
  getOpportunityAnalytics,
  getOpportunity,
  getOpportunitySessionEvents,
  getOpportunitySurveyResults,
  opportunitySurveyResultsCsvUrl,
} from '../../api/client';

/**
 * Phase 4e: where a researcher reads the answers their own opportunity
 * collected.
 *
 * The component that renders them has existed since phase 3 with no route to
 * it, so everything here is about the wiring - which opportunities offer the
 * tab, what it fetches, and where its export points.
 */

// One object, returned by identity. The page's load effect lists `user` in its
// dependencies, so a mock that builds a fresh object per render re-runs the
// effect on every render - the page flips back to its spinner forever, and a
// query that happened to land in a rendered frame passes while the next one
// does not.
const AUTH = {
  user: { id: 'a1', role: 'researcher_admin', name: 'A', email: 'a@example.com' },
  loading: false,
  initialAuthCheck: true,
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => AUTH,
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));

// Named individually rather than spread from the real module: an incomplete
// factory leaves an import undefined, and a click test then passes by
// asserting the generic failure it caused itself.
vi.mock('../../api/client', () => ({
  getOpportunityAnalytics: vi.fn(),
  getOpportunity: vi.fn(),
  getOpportunitySessionEvents: vi.fn(),
  getOpportunitySurveyResults: vi.fn(),
  opportunitySurveyResultsCsvUrl: vi.fn(),
}));

const OPPORTUNITY_TITLE = 'How was the checkout';

const nativeSurvey = {
  id: 'opp-1',
  type: 'survey',
  title: OPPORTUNITY_TITLE,
  status: 'published',
  delivery_mode: 'native',
  firsthand_study_id: 'study_x',
};

const results = {
  title: 'How was the checkout',
  results: {
    respondents: 3,
    questions: [
      {
        step_id: 'q1',
        prompt: 'How easy was that?',
        type: 'rating',
        answered: 3,
        mean: 4.3,
        distribution: [
          { value: 4, count: 2 },
          { value: 5, count: 1 },
        ],
      },
    ],
  },
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-1/analytics']}>
      <Routes>
        <Route path="/admin/opportunities/:id/analytics" element={<OpportunityAnalytics />} />
      </Routes>
    </MemoryRouter>
  );

/** The page renders a spinner until the opportunity resolves. */
const settled = async () => {
  await screen.findByText(new RegExp(OPPORTUNITY_TITLE), {}, { timeout: 3000 });
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(getOpportunityAnalytics).mockResolvedValue({
    clicks_by_day: [],
    clicks_by_hour: [],
    clicks_by_weekday: [],
    week_over_week_change: null,
  } as never);
  vi.mocked(getOpportunitySessionEvents).mockResolvedValue([] as never);
  vi.mocked(getOpportunitySurveyResults).mockResolvedValue(results as never);
  vi.mocked(opportunitySurveyResultsCsvUrl).mockReturnValue(
    '/api/opportunities/opp-1/survey-results.csv'
  );
  vi.mocked(getOpportunity).mockResolvedValue(nativeSurvey as never);
});

describe('which opportunities offer a Responses tab', () => {
  // Both, not just survey. "Poll" is half of what the feature is called, and
  // every fixture here used to be a survey - narrowing the gate to `'survey'`
  // alone left all nineteen tests passing.
  it.each(['poll', 'survey'])('offers it for a native %s', async (type) => {
    vi.mocked(getOpportunity).mockResolvedValue({ ...nativeSurvey, type } as never);

    renderPage();
    await settled();

    expect(screen.getByRole('tab', { name: 'Responses' })).toBeTruthy();
  });

  it('still offers it after a switch to external delivery', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      ...nativeSurvey,
      delivery_mode: 'external',
    } as never);

    renderPage();
    await settled();

    // Switching delivery leaves the study linked and every answer already
    // collected exactly where it was, and the backend serves them regardless
    // of mode. Hiding the tab lost a researcher the only route to their own
    // data, silently, with the rows still in the database.
    expect(screen.getByRole('tab', { name: 'Responses' })).toBeTruthy();
  });

  it('does not offer it when no questions are linked', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      ...nativeSurvey,
      firsthand_study_id: null,
    } as never);

    renderPage();
    await settled();

    expect(screen.queryByRole('tab', { name: 'Responses' })).toBeNull();
  });

  it('leaves a recorded study with its Sessions tab and no Responses tab', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      ...nativeSurvey,
      type: 'unmoderated',
      delivery_mode: undefined,
    } as never);

    renderPage();
    await settled();

    expect(screen.getByRole('tab', { name: 'Sessions' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Responses' })).toBeNull();
  });
});

describe('reading the answers', () => {
  it('fetches nothing until the tab is opened', async () => {
    renderPage();
    await settled();

    expect(getOpportunitySurveyResults).not.toHaveBeenCalled();
  });

  it('asks for the answers of THIS opportunity', async () => {
    renderPage();
    await settled();
    await userEvent.click(screen.getByRole('tab', { name: 'Responses' }));

    // The opportunity id, not the study id. The study-wide read spans every
    // opportunity that reused the study and is superadmin-only.
    await waitFor(() => {
      expect(getOpportunitySurveyResults).toHaveBeenCalledWith('opp-1');
    });
  });

  it('renders the tallies it was given', async () => {
    renderPage();
    await settled();
    await userEvent.click(screen.getByRole('tab', { name: 'Responses' }));

    expect(await screen.findByText('3 participants')).toBeTruthy();
    expect(screen.getByText('Average 4.3')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'How easy was that?' })).toBeTruthy();
  });

  it('does not print the study title under the page title that already says it', async () => {
    renderPage();
    await settled();
    await userEvent.click(screen.getByRole('tab', { name: 'Responses' }));

    await screen.findByText('3 participants');

    // The page header already says which opportunity this is - in its context
    // line, not as a heading. Rendering the STUDY's title as an h2 here showed
    // the same words twice when they matched, which is every real case, and two
    // different names for one screen when they did not, on a study reused by an
    // opportunity its author did not create.
    expect(screen.queryByRole('heading', { name: OPPORTUNITY_TITLE })).toBeNull();

    // Still named once, where it belongs.
    expect(screen.getByText(OPPORTUNITY_TITLE)).toBeTruthy();
  });

  it('keeps a heading there, so the level is not skipped', async () => {
    renderPage();
    await settled();
    await userEvent.click(screen.getByRole('tab', { name: 'Responses' }));

    // The page is h1 and the questions are h3; dropping this outright would
    // skip a level rather than fix the duplication.
    expect(await screen.findByRole('heading', { level: 2, name: 'Responses' })).toBeTruthy();
  });

  it('points the export at the per-opportunity CSV', async () => {
    renderPage();
    await settled();
    await userEvent.click(screen.getByRole('tab', { name: 'Responses' }));

    const link = await screen.findByRole('link', { name: 'Download CSV' });
    expect(link.getAttribute('href')).toBe('/api/opportunities/opp-1/survey-results.csv');
    expect(opportunitySurveyResultsCsvUrl).toHaveBeenCalledWith('opp-1');
  });

  it('re-reads on every visit, because answers arrive while the page is open', async () => {
    renderPage();
    await settled();

    await userEvent.click(screen.getByRole('tab', { name: 'Responses' }));
    await screen.findByText('3 participants');
    await userEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Responses' }));

    // A tally cached from the first visit is the one thing this view must not
    // show: it reads as a finding rather than as stale data.
    await waitFor(() => {
      expect(vi.mocked(getOpportunitySurveyResults).mock.calls).toHaveLength(2);
    });
  });

  it('says a refusal is a refusal rather than showing no answers', async () => {
    // Defensive: the page's own analytics load is gated the same way, so a
    // non-owner is stopped before the tab exists. It is still the status this
    // route answers, and "no answers yet" would be a different finding.
    vi.mocked(getOpportunitySurveyResults).mockRejectedValue({
      response: { status: 403 },
    } as never);

    renderPage();
    await settled();
    await userEvent.click(screen.getByRole('tab', { name: 'Responses' }));

    expect(
      await screen.findByText(/Only the opportunity owner can view these responses/i)
    ).toBeTruthy();
    expect(screen.queryByText(/participants/)).toBeNull();
  });

  /**
   * THE STATUS IS NOT ENOUGH, and the first version of these tests proved it by
   * mocking `{ response: { status: 503 } }` with no body - asserting exactly
   * the field that cannot tell these cases apart.
   *
   * This route answers 503 for congestion, which clears in seconds, and for a
   * backend with no runtime persistence configured, which does not clear at
   * all. Only the first two carry a code.
   */
  it.each([
    ['RESULTS_READ_QUEUE_FULL'],
    ['RUNTIME_POOL_ADMISSION_TIMEOUT'],
  ])('tells the reader to try again when refused with %s', async (code) => {
    vi.mocked(getOpportunitySurveyResults).mockRejectedValue({
      response: { status: 503, data: { code } },
    } as never);

    renderPage();
    await settled();
    await userEvent.click(screen.getByRole('tab', { name: 'Responses' }));

    expect(await screen.findByText(/busy being read right now/i)).toBeTruthy();
    expect(screen.queryByText(/Could not load the responses/i)).toBeNull();
  });

  it('does not promise a retry for a 503 that will never clear', async () => {
    // `surveyResultsAreReadable()` false - no runtime persistence configured,
    // a condition this codebase has had last for a week. Same status, no code.
    // "Wait a few seconds and try again" would be advice that never comes true.
    vi.mocked(getOpportunitySurveyResults).mockRejectedValue({
      response: { status: 503, data: { error: 'Survey results are not available' } },
    } as never);

    renderPage();
    await settled();
    await userEvent.click(screen.getByRole('tab', { name: 'Responses' }));

    expect(await screen.findByText(/Could not load the responses/i)).toBeTruthy();
    expect(screen.queryByText(/busy being read right now/i)).toBeNull();
  });

  it('says so when the read fails for any other reason', async () => {
    vi.mocked(getOpportunitySurveyResults).mockRejectedValue({
      response: { status: 500 },
    } as never);

    renderPage();
    await settled();
    await userEvent.click(screen.getByRole('tab', { name: 'Responses' }));

    expect(await screen.findByText(/Could not load the responses/i)).toBeTruthy();
  });

  it('opens the CSV export in its own tab, so a refusal cannot take the page', async () => {
    // The export route is gated too, and a refusal is a JSON body. Followed in
    // this tab it would replace the results the researcher is reading.
    renderPage();
    await settled();
    await userEvent.click(screen.getByRole('tab', { name: 'Responses' }));

    const link = await screen.findByRole('link', { name: 'Download CSV' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});
