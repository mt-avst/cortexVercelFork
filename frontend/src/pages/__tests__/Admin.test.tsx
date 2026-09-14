import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
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

// Stub the leaf components that are irrelevant here: PendingApprovals and
// AdminFeedback each fire a network call in useEffect, so stubbing them avoids
// act() noise. AdminSessionManager is NOT imported by Admin.tsx, so there is
// nothing to stub for it. ErrorState and ConfirmationModal are jsdom-safe and
// left real.
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
    owner_user_id: 'admin-1',
    owner_name: 'Admin',
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
    // The trailing arrow moved from unicode text onto a lucide icon (Lane E
    // icon system), so the accessible name is the label alone now.
    expect(screen.getByText('Create Research Study')).toBeInTheDocument();

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

    fireEvent.click(screen.getByRole('button', { name: /Actions for Checkout usability test/i }));

    // The row actions are now a real menu (#117): items carry role="menuitem".
    const item = screen.getByRole('menuitem', { name: 'Analytics' });
    expect(item).toBeInTheDocument();
    // The fixture study is owned by the acting admin, so it is live, not disabled.
    expect(item).not.toBeDisabled();
  });

  it('disables Analytics and names the owner for a study the viewer does not own (row 8)', async () => {
    // Analytics is owner-scoped on the server; the menu must not offer a live
    // item that only leads to a 403. Under the beta all-admin switch this is
    // the common case: every admin sees a colleague's studies as unowned.
    vi.mocked(getOpportunities).mockResolvedValue([
      { ...fixtures.opportunity, owner_user_id: 'someone-else', owner_name: 'Dana Owner' },
    ] as never);
    renderAdmin();
    await screen.findByText('Checkout usability test');

    fireEvent.click(screen.getByRole('button', { name: /Actions for Checkout usability test/i }));

    const item = screen.getByRole('menuitem', { name: 'Analytics' });
    expect(item).toBeDisabled();
    expect(item.getAttribute('title')).toContain('Dana Owner');
  });

  it('keeps Analytics live for a superadmin even on a study they do not own (row 8)', async () => {
    auth.value = {
      user: { id: 'super-1', role: 'superadmin', name: 'Super', email: 'super@example.com' },
      loading: false,
      initialAuthCheck: true,
    };
    vi.mocked(getOpportunities).mockResolvedValue([
      { ...fixtures.opportunity, owner_user_id: 'someone-else', owner_name: 'Dana Owner' },
    ] as never);
    renderAdmin();
    await screen.findByText('Checkout usability test');

    fireEvent.click(screen.getByRole('button', { name: /Actions for Checkout usability test/i }));

    expect(screen.getByRole('menuitem', { name: 'Analytics' })).not.toBeDisabled();
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

  it('names the collateral destroyed by a study delete (DA-24)', async () => {
    // The confirm dialog used to say only "cannot be undone" - true but silent
    // on WHAT else the DB cascade takes with it. It must now spell out the
    // real collateral (sessions/bookings, recordings/transcripts, analytics),
    // while still asking the original question and offering the original button.
    renderAdmin();
    await screen.findByText('Checkout usability test');

    fireEvent.click(screen.getByRole('button', { name: /Actions for Checkout usability test/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    // Scoped to the dialog: a document-wide /analytics/i would also match the
    // row menu's "Analytics" item if the menu ever stayed mounted alongside
    // the dialog.
    const dialog = within(screen.getByRole('dialog'));

    // Control: the dialog still asks its original question and still offers
    // its original confirm button - this test must not pass by replacing them.
    expect(
      dialog.getByText(/Are you sure you want to delete "Checkout usability test"/)
    ).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Yes, Delete' })).toBeInTheDocument();

    // The collateral itself: bookings/sessions, recordings/transcripts and
    // analytics data all cascade-delete with the opportunity row (verified
    // against backend/src/db/migrate.ts's ON DELETE CASCADE chain).
    expect(dialog.getByText(/sessions and any bookings/i)).toBeInTheDocument();
    expect(dialog.getByText(/recordings and transcripts/i)).toBeInTheDocument();
    expect(dialog.getByText(/analytics/i)).toBeInTheDocument();
  });

  it('announces the delete-dialog collateral to assistive tech via aria-describedby (DA-24 a11y)', async () => {
    // A screen-reader user hears aria-labelledby (the title) and
    // aria-describedby (the description) on dialog focus - NOT everything
    // rendered inside it. The collateral list is only actually announced if
    // its container's id is included in aria-describedby. This fails BY NAME
    // if that wiring regresses, rather than silently degrading to an
    // unannounced paragraph a sighted reviewer would never notice missing.
    renderAdmin();
    await screen.findByText('Checkout usability test');

    fireEvent.click(screen.getByRole('button', { name: /Actions for Checkout usability test/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    const dialogEl = screen.getByRole('dialog');
    const describedBy = dialogEl.getAttribute('aria-describedby') ?? '';
    const describedIds = describedBy.split(/\s+/).filter(Boolean);

    expect(describedIds).toContain('modal-custom-content');

    const customContentEl = document.getElementById('modal-custom-content');
    expect(customContentEl).not.toBeNull();
    expect(customContentEl).toHaveTextContent(/recordings and transcripts/i);
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

describe('Admin dashboard accessibility (row 13)', () => {
  it('exposes each sortable Studies column as a button with a live aria-sort', async () => {
    renderAdmin();
    await screen.findByText('Checkout usability test');

    // The sortable header is a real button (keyboard-operable), not a click-only th.
    const studySort = screen.getByRole('button', { name: /^Study/ });
    const studyHeader = studySort.closest('th') as HTMLElement;

    // Default sort is created_at desc, so Study starts unsorted and Created starts descending -
    // aria-sort carries that state to a screen reader, which the bare ↑/↓ glyph never did.
    expect(studyHeader).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: /^Created/ })).toHaveAttribute('aria-sort', 'descending');

    fireEvent.click(studySort);
    expect(studySort.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(studySort);
    expect(studySort.closest('th')).toHaveAttribute('aria-sort', 'descending');
  });

  it('marks the Studies column headers as column headers with scope', async () => {
    renderAdmin();
    await screen.findByText('Checkout usability test');
    // A non-sortable header and a sortable one both carry scope=col; a plain <th>
    // without scope is what the audit flagged.
    expect(screen.getByRole('columnheader', { name: 'Recruitment' })).toHaveAttribute('scope', 'col');
    expect(screen.getByRole('button', { name: /^Study/ }).closest('th')).toHaveAttribute('scope', 'col');
  });

  it('names the row actions menu after the study, not the ⋮ glyph', async () => {
    renderAdmin();
    await screen.findByText('Checkout usability test');

    expect(
      screen.getByRole('button', { name: /Actions for Checkout usability test/i })
    ).toBeInTheDocument();
    // The glyph is no longer any button's accessible name.
    expect(screen.queryByRole('button', { name: '⋮' })).not.toBeInTheDocument();
  });
});
