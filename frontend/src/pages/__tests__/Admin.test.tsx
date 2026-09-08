import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Admin from '../Admin';
import { getDashboardStats, getOpportunities } from '../../api/client';

// Admin is an admin-gated, context-heavy page. It gates on `loading || !initialAuthCheck`
// (Admin.tsx:225) BEFORE the user/role checks, so the auth mock MUST provide
// `initialAuthCheck: true` or the page renders only "Loading..." and every assertion
// fails. The role and loading state are held in a hoisted ref so individual tests
// (e.g. the non-admin gate) can swap them before rendering.
const auth = vi.hoisted(() => ({
  value: {
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin', email: 'admin@example.com' },
    loading: false,
    initialAuthCheck: true,
  } as { user: { id: string; role: string; name: string; email: string } | null; loading: boolean; initialAuthCheck: boolean },
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => auth.value,
}));

// Light theme so the WebGL background (rendered only when isDark) never mounts under jsdom.
vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light' }),
}));

// Stub the leaf components that are irrelevant here: SlowNeuralBackground is the genuine
// three.js/WebGL jsdom blocker; PendingApprovals and AdminFeedback each fire a network
// call in useEffect, so stubbing them avoids act() noise. AdminSessionManager is NOT
// imported by Admin.tsx, so there is nothing to stub for it. ErrorState and
// ConfirmationModal are jsdom-safe and left real.
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));
vi.mock('../../components/PendingApprovals', () => ({ default: () => null }));
vi.mock('../../components/AdminFeedback', () => ({ default: () => null }));

// Admin fetches exactly two things on mount for an admin user: getOpportunities and
// getDashboardStats. getDashboardStats resolves a full 13-field DashboardStats;
// getOpportunities resolves one realistic row. The destructive/CSV functions are bare
// spies (the CSV Blob/createObjectURL path lives inside the mocked client, so jsdom
// never touches it). Fixtures are hoisted so the factory and the assertions share them.
const fixtures = vi.hoisted(() => ({
  opportunity: {
    id: 'opp-1',
    type: 'test',
    title: 'Checkout usability test',
    purpose_one_liner: 'See where participants stumble at checkout',
    default_duration_minutes: 30,
    status: 'published',
    created_at: '2026-07-01T10:00:00.000Z',
    updated_at: '2026-07-01T10:00:00.000Z',
  },
  stats: {
    total_opportunities: 7,
    published_opportunities: 4,
    draft_opportunities: 2,
    closed_opportunities: 1,
    total_bookings: 12,
    upcoming_bookings: 5,
    past_bookings: 7,
    total_participants: 9,
    total_sessions: 20,
    sessions_completed: 15,
    total_slots: 40,
    booked_slots: 12,
    available_slots: 28,
    recent_bookings: [],
  },
}));

vi.mock('../../api/client', () => ({
  getOpportunities: vi.fn().mockResolvedValue([fixtures.opportunity]),
  getDashboardStats: vi.fn().mockResolvedValue(fixtures.stats),
  deleteOpportunity: vi.fn().mockResolvedValue(undefined),
  duplicateOpportunity: vi.fn().mockResolvedValue(undefined),
  exportBookingsCsv: vi.fn().mockResolvedValue(undefined),
  getPendingApprovals: vi.fn().mockResolvedValue([]),
  getFeedback: vi.fn().mockResolvedValue({ items: [], has_more: false }),
}));

// The header buttons and the non-admin gate both navigate via react-router. Render Admin
// inside a Routes harness with sentinel elements so navigation is observable: a bare
// MemoryRouter would make navigate() unverifiable, and the non-admin gate renders
// <Navigate to="/" replace> (Admin.tsx:231-236), not null.
const renderAdmin = () =>
  render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route path="/admin" element={<Admin />} />
        <Route path="/" element={<div>HOME SENTINEL</div>} />
        <Route path="/admin/studies" element={<div>STUDIES SENTINEL</div>} />
        <Route path="/admin/settings" element={<div>SETTINGS SENTINEL</div>} />
        <Route path="/admin/opportunities/new" element={<div>NEW STUDY SENTINEL</div>} />
      </Routes>
    </MemoryRouter>
  );

/** A Recent-bookings row. Shape matches RecentBookingItem from the server. */
const recentBooking = (i: number) => ({
  id: `b-${i}`,
  opportunity_id: 'opp-1',
  // Distinct from the studies-table row's title: Bootstrap renders every
  // tab-pane in the DOM, so a shared title makes findByText ambiguous.
  opportunity_title: 'Booked study',
  session_start: '2026-09-13T13:00:00.000Z',
  participant_name: `Participant ${i}`,
  participant_email: `p${i}@example.com`,
  status: 'booked',
  booked_at: '2026-09-01T10:00:00.000Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  // Reset to the admin default; the non-admin test mutates this.
  auth.value = {
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin', email: 'admin@example.com' },
    loading: false,
    initialAuthCheck: true,
  };
});

describe('Admin page', () => {
  it('renders the dashboard for a researcher_admin: header actions, stats and the opportunities row', async () => {
    renderAdmin();

    // Header action row - query by the stable aria-labels (jsdom renders both responsive
    // spans, so text queries would hit duplicates; aria-label is the accessible name).
    expect(screen.getByRole('button', { name: 'Task lists' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create new research study' })).toBeInTheDocument();

    // The VISIBLE text of both responsive spans, which the aria-label queries
    // above do not reach. Pinned because the two senses of "study" diverge
    // here: this button opens the task lists, while its neighbour creates a
    // research study (the opportunity), and only one of them renamed.
    expect(screen.getByText('Task Lists')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('Create Research Study →')).toBeInTheDocument();

    // Opportunities table renders the mocked row once the async load resolves.
    expect(await screen.findByText('Checkout usability test')).toBeInTheDocument();
    expect(screen.getByText('See where participants stumble at checkout')).toBeInTheDocument();

    // "Research Studies" now names only the tab. The stat card that used to
    // share the label is the redesigned "Active studies" (published + draft),
    // so the phrase appears exactly once - the two senses no longer collide.
    expect(screen.getAllByText('Research Studies')).toHaveLength(1);
    expect(screen.getByText('Active studies')).toBeInTheDocument();
  });

  it('offers Analytics in the row menu for a moderated (test) study', async () => {
    // Row 4: Analytics used to be gated to poll/survey/unmoderated, so a
    // moderated study - the fixture is a `test` - had no way through to its
    // Analytics page and therefore no way to its participant roster. Opening
    // the row's kebab must now surface Analytics for it.
    renderAdmin();
    await screen.findByText('Checkout usability test');

    fireEvent.click(screen.getByRole('button', { name: '⋮' }));

    expect(screen.getByRole('button', { name: 'Analytics' })).toBeInTheDocument();
  });

  it('states the truncation when Recent bookings is capped below the total (register #16)', async () => {
    // The table is capped at the 15 most recent server-side while the tab
    // badge counts all 47, so the researcher must be told the 15 are not the
    // whole list.
    const fifteen = Array.from({ length: 15 }, (_, i) => recentBooking(i));
    vi.mocked(getDashboardStats).mockResolvedValue({
      ...fixtures.stats,
      total_bookings: 47,
      recent_bookings: fifteen,
    } as never);
    renderAdmin();
    await screen.findByText('Checkout usability test');

    fireEvent.click(screen.getByRole('tab', { name: /Bookings/ }));

    expect(
      screen.getByText(/Showing the 15 most recent of 47 bookings/i)
    ).toBeInTheDocument();
  });

  it('does not claim truncation when every booking is already shown', async () => {
    // The control: with the same code path but nothing withheld, the note must
    // NOT appear - a `>=` where the fix uses `>` would trip this.
    const three = Array.from({ length: 3 }, (_, i) => recentBooking(i));
    vi.mocked(getDashboardStats).mockResolvedValue({
      ...fixtures.stats,
      total_bookings: 3,
      recent_bookings: three,
    } as never);
    renderAdmin();
    await screen.findByText('Checkout usability test');

    fireEvent.click(screen.getByRole('tab', { name: /Bookings/ }));

    expect(screen.getByText('Participant 0')).toBeInTheDocument();
    expect(screen.queryByText(/most recent of/i)).toBeNull();
  });

  it('navigates to Task Lists from the header', async () => {
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: 'Task lists' }));
    expect(screen.getByText('STUDIES SENTINEL')).toBeInTheDocument();
  });

  it('navigates to Settings from the header', async () => {
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(screen.getByText('SETTINGS SENTINEL')).toBeInTheDocument();
  });

  it('navigates to the new-study form from the header', async () => {
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: 'Create new research study' }));
    expect(screen.getByText('NEW STUDY SENTINEL')).toBeInTheDocument();
  });

  // Both of Admin's effects name loadOpportunities in their dependency arrays.
  // That is only safe because it is memoised on the filters it reads - as the
  // plain function it used to be, it was rebuilt every render, so naming it
  // would re-run the effect on every render and, since it sets state, forever.
  //
  // An infinite loop presents here as an unbounded call count, so these assert
  // how many times the API is hit rather than what is on screen.
  it('loads the dashboard once on mount and does not re-enter', async () => {
    renderAdmin();

    await vi.waitFor(() => {
      expect(vi.mocked(getOpportunities)).toHaveBeenCalled();
    });
    // Let any follow-on renders and their effects settle.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(vi.mocked(getOpportunities)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getDashboardStats)).toHaveBeenCalledTimes(1);
  });

  it('does not refetch when the page re-renders without a filter change', async () => {
    const { rerender } = renderAdmin();
    await vi.waitFor(() => {
      expect(vi.mocked(getOpportunities)).toHaveBeenCalledTimes(1);
    });

    rerender(
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </MemoryRouter>
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(vi.mocked(getOpportunities)).toHaveBeenCalledTimes(1);
  });

  it('redirects a non-admin user to the home route', () => {
    // A generic role that is neither researcher_admin nor superadmin is gated out
    // (Admin.tsx:235) and redirected to "/".
    auth.value = {
      user: { id: 'u-2', role: 'participant', name: 'Pat', email: 'pat@example.com' },
      loading: false,
      initialAuthCheck: true,
    };

    renderAdmin();

    expect(screen.getByText('HOME SENTINEL')).toBeInTheDocument();
    // The admin header must not render for a gated-out user.
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Task lists' })).not.toBeInTheDocument();
  });
});
