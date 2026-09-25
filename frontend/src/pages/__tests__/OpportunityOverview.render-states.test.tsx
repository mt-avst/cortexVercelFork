import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { getOpportunity, getOpportunityBookings } from '../../api/client';
import { CREATE_AND_MANAGE } from '@shared/pageNames';
import {
  MANAGER_USER,
  OTHER_USER,
  deferred,
  overviewTree,
  renderOverview,
  study,
} from './helpers/opportunity-overview';

/**
 * The study overview page's own shell states (cto/AdaptaLabs#163): loading,
 * a transport error, a 404, the owner-only gate (every study type, no
 * bookings fetch), the Back link, the "Ready to take part" case, and the
 * Results section's two shapes. Setup-status reasons live in
 * `.publish-problems.test.tsx`; sessions/bookings content lives in
 * `.sessions-bookings.test.tsx`.
 */
// The initial value is a placeholder, not MANAGER_USER: `vi.hoisted` runs
// above every import, so the fixture constants are not yet initialised here.
// `beforeEach` below sets the real starting value.
const auth = vi.hoisted(() => ({
  value: { user: null, loading: true, initialAuthCheck: false } as {
    user: { id: string; role: string; name: string; email: string } | null;
    loading: boolean;
    initialAuthCheck: boolean;
  },
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(),
  getOpportunityBookings: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  auth.value = { user: MANAGER_USER, loading: false, initialAuthCheck: true };
  vi.mocked(getOpportunityBookings).mockResolvedValue([]);
});

describe('loading', () => {
  it('shows the spinner until the study resolves, then the page', async () => {
    const pending = deferred<ReturnType<typeof study>>();
    vi.mocked(getOpportunity).mockReturnValue(pending.promise as never);
    renderOverview();

    expect(screen.getByText('Loading study...')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Ready study$/ })).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve(study({ title: 'Ready study', firsthand_study_id: 'fh-1' }));
      await pending.promise;
    });

    expect(await screen.findByRole('heading', { name: 'Ready study' })).toBeInTheDocument();
    expect(screen.queryByText('Loading study...')).not.toBeInTheDocument();
  });
});

describe('a transport failure', () => {
  it('shows "Unable to load study" with Retry, and Retry re-fetches', async () => {
    vi.mocked(getOpportunity).mockRejectedValueOnce({ response: { status: 500 } });
    renderOverview();

    expect(await screen.findByText('Unable to load study')).toBeInTheDocument();
    expect(screen.getByText('Failed to load this study')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry' });

    vi.mocked(getOpportunity).mockResolvedValueOnce(study({ title: 'Recovered study', firsthand_study_id: 'fh-1' }));
    fireEvent.click(retry);

    expect(await screen.findByRole('heading', { name: 'Recovered study' })).toBeInTheDocument();
    expect(getOpportunity).toHaveBeenCalledTimes(2);
  });

  it('names a 404 as "Study not found"', async () => {
    vi.mocked(getOpportunity).mockRejectedValueOnce({ response: { status: 404 } });
    renderOverview();

    expect(await screen.findByText('Study not found')).toBeInTheDocument();
  });
});

describe('the owner-only gate (every study type, no bookings fetch)', () => {
  it('a non-manager gets the owner-only page for a NON-moderated study, and no bookings request is made', async () => {
    auth.value = { user: OTHER_USER, loading: false, initialAuthCheck: true };
    vi.mocked(getOpportunity).mockResolvedValue(
      study({ title: "Someone else's poll", type: 'poll', delivery_mode: 'external', external_link_optional: 'https://example.com' })
    );
    renderOverview();

    expect(await screen.findByText('Study overview is owner-only')).toBeInTheDocument();
    // A real <h1>, not only ErrorState's own <h2>.
    expect(screen.getByRole('heading', { level: 1, name: "Someone else's poll" })).toBeInTheDocument();
    expect(screen.getByText(/Only Admin can view this study's overview\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Back to ${CREATE_AND_MANAGE}` })).toBeInTheDocument();

    // The gate fires right after the study loads, for every type, including
    // a poll that never carries bookings - so no bookings request is made
    // for a non-owner.
    await waitFor(() => expect(getOpportunity).toHaveBeenCalledTimes(1));
    expect(getOpportunityBookings).not.toHaveBeenCalled();
    // None of the manager-only content renders underneath.
    expect(screen.queryByText('Setup status')).not.toBeInTheDocument();
    expect(screen.queryByText('Results')).not.toBeInTheDocument();
  });

  it('makes no bookings request for a non-manager on a MODERATED study either - the bookings effect has its own canManage guard', async () => {
    auth.value = { user: OTHER_USER, loading: false, initialAuthCheck: true };
    vi.mocked(getOpportunity).mockResolvedValue(
      study({ title: "Someone else's live session", type: 'test', meeting_location_optional: 'Room 4' })
    );
    renderOverview();

    expect(await screen.findByText('Study overview is owner-only')).toBeInTheDocument();
    // Moderated types are the ONLY ones that ever carry bookings - the
    // bookings effect's own `canManage` guard (separate from the type
    // guard the non-moderated test above proves) is what has to hold here.
    await waitFor(() => expect(getOpportunity).toHaveBeenCalledTimes(1));
    expect(getOpportunityBookings).not.toHaveBeenCalled();
  });

  it('falls back to the generic owner line when the study carries no owner name', async () => {
    auth.value = { user: OTHER_USER, loading: false, initialAuthCheck: true };
    vi.mocked(getOpportunity).mockResolvedValue(
      study({ title: 'Unnamed owner study', owner_name: undefined, owner_email: undefined })
    );
    renderOverview();

    expect(await screen.findByText("Only the study owner can view this study's overview.")).toBeInTheDocument();
  });
});

describe('"Ready to take part"', () => {
  it('renders Ready with the Edit (not Fix) action, and the Results fallback link when the study has no sessions', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      study({ title: 'Ready study', type: 'unmoderated', firsthand_study_id: 'fh-1' })
    );
    renderOverview();

    expect(await screen.findByText('Ready to take part')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/admin/opportunities/opp-1/edit');
    expect(screen.queryByRole('link', { name: 'Fix' })).not.toBeInTheDocument();
    // The type/status pills read PUBLISHED, not Broken.
    expect(screen.getByText('PUBLISHED')).toBeInTheDocument();

    // Results: no sessions -> no `total_booked`/`total_capacity` and
    // `getRecruitment` sees an empty sessions array, so Results falls back
    // to the Analytics link rather than a booked/capacity figure. Scoped to
    // the Results card: the header carries its own "Analytics" link too.
    expect(screen.getByText('See Analytics for participation figures.')).toBeInTheDocument();
    const resultsCard = screen.getByRole('heading', { name: 'Results' }).closest('.card') as HTMLElement;
    expect(within(resultsCard).getByRole('link', { name: /Analytics/ })).toHaveAttribute(
      'href',
      '/admin/opportunities/opp-1/analytics'
    );
  });

  it('shows the booked/capacity figure in Results for a study with sessions', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      study({
        title: 'Session study',
        type: 'test',
        sessions: [
          {
            id: 's-1',
            opportunity_id: 'opp-1',
            start_time: '2026-10-01T10:00:00.000Z',
            end_time: '2026-10-01T11:00:00.000Z',
            capacity: 4,
            booked_count: 3,
            remaining: 1,
            created_at: '2026-07-01T10:00:00.000Z',
            updated_at: '2026-07-01T10:00:00.000Z',
          },
        ],
        meeting_location_optional: 'Room 4',
      })
    );
    renderOverview();

    const resultsCard = (await screen.findByRole('heading', { name: 'Results' })).closest('.card') as HTMLElement;
    // Scoped to the Results card: the session itself also carries a "3 / 4"
    // ratio in the Sessions section above. The full sentence spans a ratio
    // span plus two raw text nodes ("booked", "(75%)") in the same <p> -
    // `toHaveTextContent` normalises whitespace and reads the whole node,
    // where `getByText` would need a single element carrying that exact text.
    const ratio = within(resultsCard).getByText('3 / 4');
    expect(ratio.closest('p')).toHaveTextContent('3 / 4 booked (75%)');
  });
});

describe('the Back link', () => {
  it('reads "Back to Create & Manage" and navigates to /admin from the main page', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(study({ title: 'Ready study', firsthand_study_id: 'fh-1' }));
    renderOverview();

    const back = await screen.findByRole('button', { name: `Back to ${CREATE_AND_MANAGE}` });
    fireEvent.click(back);
    expect(await screen.findByTestId('probe')).toHaveTextContent('ADMIN /admin');
  });
});

describe('the cold-load auth race (owner-only must not stick once auth catches up)', () => {
  it('makes no request while auth is still resolving, then fetches once the real user is known - never showing owner-only', async () => {
    // AuthContext's own `fetchUser` sets `loading: true` synchronously,
    // before its `/api/me` call resolves `user` - so this page's very first
    // render can see `loading: true, user: null` at once, before the real
    // signed-in user is known. `renderOverview`'s default auth (set in
    // `beforeEach`) is the settled state; this test starts from the cold one.
    auth.value = { user: null, loading: true, initialAuthCheck: false };

    const cold = study({ title: 'Cold load study', type: 'test', meeting_location_optional: 'Room 4', sessions: [] });
    const pending = deferred<typeof cold>();
    vi.mocked(getOpportunity).mockImplementationOnce(() => pending.promise as never);

    const { rerender } = renderOverview();
    // The fetch is gated on auth being settled (`loading || !user || !id`
    // returns) - while auth is mid-resolve there is nothing to gate
    // `canManageStudy` with, so no request fires at all rather than firing
    // one against a `null` user.
    expect(getOpportunity).not.toHaveBeenCalled();
    expect(screen.getByText('Loading study...')).toBeInTheDocument();

    // Auth settles to the real owner.
    auth.value = { user: MANAGER_USER, loading: false, initialAuthCheck: true };
    rerender(overviewTree());
    expect(getOpportunity).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(cold);
      await pending.promise;
    });

    // The owner sees the full page - never a permission state that was only
    // ever true because the user was not known yet.
    expect(await screen.findByRole('heading', { level: 2, name: 'Setup status' })).toBeInTheDocument();
    expect(screen.queryByText('Study overview is owner-only')).not.toBeInTheDocument();

    // One load, one call each - the fix closes the race at the source
    // (nothing fires until auth is settled) rather than firing twice and
    // discarding the stale one.
    expect(getOpportunity).toHaveBeenCalledTimes(1);
    expect(getOpportunityBookings).toHaveBeenCalledTimes(1);
  });
});
