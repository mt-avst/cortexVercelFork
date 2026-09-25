import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { bookSession, getOpportunity } from '../../api/client';

/**
 * Which errors are allowed to take the page away.
 *
 * A bare `if (error)` early return meant ANY error replaced the whole page with
 * a lone alert - so an ordinary "Session is full", the commonest failure on this
 * page, cost the participant the study description, the calendar and every
 * session on it, with a full reload as the only way back. It also made the
 * page's own inline error banner unreachable.
 *
 * The rule now is what the participant can still do, not how bad the error is:
 * no opportunity means the error IS the page, an opportunity in hand means the
 * error is about one action.
 */

const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const end = new Date(start.getTime() + 60 * 60 * 1000);

const fixture = {
  id: 'opp-1',
  type: 'test',
  title: 'Checkout flow walkthrough',
  purpose_one_liner: 'Find out where people stall in the checkout flow',
  status: 'published',
  default_duration_minutes: 60,
  participant_type_required: 'any',
  sessions: [
    {
      id: 'sess-1',
      opportunity_id: 'opp-1',
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      capacity: 3,
      remaining: 3,
    },
  ],
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', role: 'employee', name: 'E' },
    loading: false,
    initialAuthCheck: true,
  }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

vi.mock('../../components/CalendarGrid', () => ({
  CALENDAR_LEGEND_ITEMS: [],
  default: ({ onBookSession }: { onBookSession: (id: string) => void }) => (
    <button type="button" onClick={() => { void Promise.resolve(onBookSession('sess-1')).catch(() => undefined); }}>
      stub book
    </button>
  ),
}));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(),
  trackOpportunityClick: vi.fn().mockResolvedValue(undefined),
  markOpportunityOpened: vi.fn().mockResolvedValue(undefined),
  bookSession: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  getMyBookings: vi.fn(async () => ({ upcoming: [], past: [] })),
  getCalendarConnectionStatus: vi.fn(async () => ({ connected: false, connectedAt: null })),
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

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.clearAllMocks();
  user = userEvent.setup();
  vi.mocked(getOpportunity).mockImplementation(async () => ({ ...fixture }) as never);
});

describe('OpportunityDetail - what an error takes away', () => {
  it('keeps the study and its calendar when a booking fails', async () => {
    vi.mocked(bookSession).mockRejectedValue({
      response: { status: 409, data: { error: 'Session is full' } },
    });

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(await screen.findByRole('button', { name: 'stub book' }));
    // Audit row 9: a moderated booking now goes through the baseline consent
    // modal first; accept it to reach the booking call this test is about.
    await user.click(await screen.findByRole('button', { name: 'Accept and book' }));

    await waitFor(() => expect(screen.getByText(/Session is full/i)).toBeInTheDocument());

    // The page is still a study page, not a bare alert.
    expect(screen.getByText('Checkout flow walkthrough')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'stub book' })).toBeInTheDocument();
  });

  it('puts the message in the dismissible inline banner, not the page-level one', async () => {
    vi.mocked(bookSession).mockRejectedValue({
      response: { status: 409, data: { error: 'Session is full' } },
    });

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(await screen.findByRole('button', { name: 'stub book' }));
    // Audit row 9: a moderated booking now goes through the baseline consent
    // modal first; accept it to reach the booking call this test is about.
    await user.click(await screen.findByRole('button', { name: 'Accept and book' }));

    const dismiss = await screen.findByRole('button', { name: 'Close error message' });
    await user.click(dismiss);

    // Dismissing is only reachable at all because the page did not take over,
    // and it has to actually clear the message rather than just hide a copy.
    await waitFor(() => {
      expect(screen.queryByText(/Session is full/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText('Checkout flow walkthrough')).toBeInTheDocument();
  });

  it('offers no one-click retry that could book a different slot', async () => {
    vi.mocked(bookSession).mockRejectedValue({
      response: { status: 409, data: { error: 'Session is full' } },
    });

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(await screen.findByRole('button', { name: 'stub book' }));
    // Audit row 9: a moderated booking now goes through the baseline consent
    // modal first; accept it to reach the booking call this test is about.
    await user.click(await screen.findByRole('button', { name: 'Accept and book' }));
    await screen.findByText(/Session is full/i);

    // The removed button retried the FIRST session with space rather than the
    // one that failed, so restoring the banner without removing it would have
    // started booking participants into slots they never chose.
    expect(screen.queryByRole('button', { name: /retry booking/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh study data' })).toBeInTheDocument();
  });

  it('still takes the page over when there is no study to show', async () => {
    vi.mocked(getOpportunity).mockRejectedValue({
      response: { status: 404, data: { error: 'not found' } },
    });

    renderDetail();

    // Nothing loaded, so the error IS the page - the full-page view is correct
    // here and must not be lost while making the inline one reachable.
    //
    // Asserted on the takeover's OWN sentence, which the separate
    // `if (!opportunity)` fallback ("Opportunity not found") does not share, so
    // this cannot pass against a build where the takeover has been removed and
    // the fallback shows through. Row 3: a genuine 404 is terminal, so it offers
    // no dead Retry that would reload straight into the same 404.
    expect(
      await screen.findByText(/could not be found\. It may have been removed/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'stub book' })).not.toBeInTheDocument();
  });

  it('shows a calm "closed" state with no dead Retry when the study has closed', async () => {
    vi.mocked(getOpportunity).mockRejectedValue({
      response: {
        status: 410,
        data: { error: 'This study has closed and is no longer accepting participants.', code: 'OPPORTUNITY_CLOSED' },
      },
    });

    renderDetail();

    // The server's own participant-facing sentence is kept, and Retry is gone:
    // reloading a closed study answers the same way. Evidence e10-detail-live-session-closed.
    expect(await screen.findByText(/this study has closed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'stub book' })).not.toBeInTheDocument();
  });

  it('shows a "not open yet" state with no dead Retry for a draft study', async () => {
    vi.mocked(getOpportunity).mockRejectedValue({
      response: {
        status: 404,
        data: { error: "This study isn't open yet. Check back once the researcher publishes it.", code: 'OPPORTUNITY_NOT_OPEN' },
      },
    });

    renderDetail();

    // Evidence e10-detail-interview-draft: a draft link must read as "not open
    // yet", not as the old "deleted or no permission" 404.
    expect(await screen.findByText(/isn't open yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('keeps a readable page when the refresh from the banner also fails', async () => {
    vi.mocked(bookSession).mockRejectedValue({
      response: { status: 409, data: { error: 'Session is full' } },
    });

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(await screen.findByRole('button', { name: 'stub book' }));
    // Audit row 9: a moderated booking now goes through the baseline consent
    // modal first; accept it to reach the booking call this test is about.
    await user.click(await screen.findByRole('button', { name: 'Accept and book' }));
    await screen.findByText(/Session is full/i);

    // Second failure, on a page that is already on screen and readable. A
    // failed reload must annotate the study, not replace it - loadOpportunity
    // leaves the previously loaded opportunity in place for a 5xx, so there is
    // still something to show and the page-level takeover must stay away.
    vi.mocked(getOpportunity).mockRejectedValue({
      response: { status: 500, data: { error: 'upstream exploded' } },
    });
    await user.click(screen.getByRole('button', { name: 'Refresh study data' }));

    await waitFor(() => expect(screen.getByText(/upstream exploded/i)).toBeInTheDocument());
    expect(screen.getByText('Checkout flow walkthrough')).toBeInTheDocument();
  });

  it('keeps the study on screen WHILE a refresh is in flight, not just after it', async () => {
    // Asserting only the settled state is not enough, and this is the second
    // time that shape has hidden a real defect here. The `if (loading)` branch
    // runs BEFORE the error gate, so the page can be perfectly correct once the
    // request lands while having blanked to a spinner for the whole interval
    // the participant actually experiences.
    // A 500 rather than a 409 deliberately: the capacity path awaits a reload
    // of its own, which would consume the deferred mock below before the click
    // under test ever reaches it.
    vi.mocked(bookSession).mockRejectedValue({
      response: { status: 500, data: { error: 'boom' } },
    });

    renderDetail();
    await screen.findByText('Checkout flow walkthrough');
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(screen.getByRole('button', { name: 'stub book' }));
    // Audit row 9: accept the baseline consent to reach the booking call.
    await user.click(await screen.findByRole('button', { name: 'Accept and book' }));
    await screen.findByText(/Server error occurred/i);

    let release: (value: unknown) => void = () => {};
    vi.mocked(getOpportunity).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }) as never
    );
    await user.click(screen.getByRole('button', { name: 'Refresh study data' }));

    // Mid-flight: the request has not resolved and must not have taken the page.
    expect(screen.getByText('Checkout flow walkthrough')).toBeInTheDocument();
    expect(screen.queryByText(/Loading study/i)).not.toBeInTheDocument();

    release({ ...fixture });
    await waitFor(() => expect(screen.getByText('Checkout flow walkthrough')).toBeInTheDocument());
  });

  it('moves focus to the banner, since the thing that failed is below the fold', async () => {
    vi.mocked(bookSession).mockRejectedValue({
      response: { status: 409, data: { error: 'Session is full' } },
    });

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(await screen.findByRole('button', { name: 'stub book' }));
    // Audit row 9: a moderated booking now goes through the baseline consent
    // modal first; accept it to reach the booking call this test is about.
    await user.click(await screen.findByRole('button', { name: 'Accept and book' }));

    // The old takeway was destructive but never missable. Now the banner sits
    // above the brief while the calendar and Start Test are below the fold, so
    // without this a participant who scrolled down sees nothing change at all.
    const banner = await screen.findByRole('alert');
    await waitFor(() => expect(banner).toHaveFocus());
    expect(banner).toHaveAttribute('aria-live', 'assertive');
  });

  it('does not leave a success message contradicting the error', async () => {
    vi.mocked(bookSession).mockResolvedValue({ id: 'booking-1' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(await screen.findByRole('button', { name: 'stub book' }));
    // Audit row 9: a moderated booking now goes through the baseline consent
    // modal first; accept it to reach the booking call this test is about.
    await user.click(await screen.findByRole('button', { name: 'Accept and book' }));
    await screen.findByText(/Successfully booked/i);

    // bookingSuccess lives in a different panel and nothing else clears it, so
    // a later failure could show green and red at once. Impossible while any
    // error removed the page; possible the moment it stopped doing that.
    vi.mocked(getOpportunity).mockRejectedValue({
      response: { status: 500, data: { error: 'upstream exploded' } },
    });
    await user.click(screen.getByRole('button', { name: 'Refresh sessions data' }));

    await waitFor(() => expect(screen.getByText(/upstream exploded/i)).toBeInTheDocument());
    expect(screen.queryByText(/Successfully booked/i)).not.toBeInTheDocument();
  });

  it('drops a study the server has stopped serving, rather than showing it stale', async () => {
    vi.mocked(bookSession).mockRejectedValue({
      response: { status: 409, data: { error: 'Session is full' } },
    });

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(await screen.findByRole('button', { name: 'stub book' }));
    // Audit row 9: a moderated booking now goes through the baseline consent
    // modal first; accept it to reach the booking call this test is about.
    await user.click(await screen.findByRole('button', { name: 'Accept and book' }));
    await screen.findByText(/Session is full/i);

    // Deleted, unpublished, closed, or a draft whose reader lost the role that
    // let them see it: all arrive as a 404 here. Keeping the page would leave a
    // bookable calendar up for something that is not bookable, forever, because
    // nothing else clears it. A 5xx is the opposite case and is covered above.
    vi.mocked(getOpportunity).mockRejectedValue({
      response: { status: 404, data: { error: 'not found' } },
    });
    await user.click(screen.getByRole('button', { name: 'Refresh study data' }));

    await waitFor(() => {
      expect(screen.queryByText('Checkout flow walkthrough')).not.toBeInTheDocument();
    });
    // A 404 on refresh is terminal - the study is gone, so no dead Retry.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'stub book' })).not.toBeInTheDocument();
  });
});

// #169: the participant page is called Participate, and both ways back from a
// study say so. The loaded page's button used to carry an aria-label ("Navigate
// back to Cortex home") that did not contain its visible text; the accessible
// name is now the visible label, exactly.
describe('OpportunityDetail - the way back (#169)', () => {
  it('names Participate on the loaded page', async () => {
    renderDetail();
    expect(await screen.findByRole('button', { name: 'Back to Participate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cortex home/i })).not.toBeInTheDocument();
  });

  it('names Participate when the study cannot be loaded', async () => {
    vi.mocked(getOpportunity).mockRejectedValue({ response: { status: 500 } });
    renderDetail();
    expect(await screen.findByRole('button', { name: 'Back to Participate' })).toBeInTheDocument();
  });
});
