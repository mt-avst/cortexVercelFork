import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Admin from '../Admin';

/**
 * #131: the "Sort by" control stands in for sort headers that are out of view:
 * below 1024px the Research Studies table reflows to cards (ROW 14,
 * `_components.css`) and hides `<thead>`; between 1024 and 1279.98px the
 * Created column, and so its sort button, is dropped (Admin table Step 1,
 * 2026-09-23). The control is wired to the SAME sortField/sortDirection state
 * and the SAME handleSort the header buttons use - never a parallel mechanism.
 *
 * jsdom applies no layout, so nothing here can see those breakpoints (they
 * are pinned as literals in Admin.card-sort.css.test.ts instead). What is
 * asserted is behaviour: selecting a field re-orders the rendered rows, the
 * direction button reverses them, the header cells and the control never
 * disagree about which field/direction is active, and the control offers
 * exactly the fields the headers do (sort parity, AC14).
 *
 * Three fixtures, each field's ascending order a DIFFERENT permutation, so a
 * control wired to the wrong field is caught by the rendered order rather
 * than merely "it re-sorted to something". Each case also asserts the
 * select's value and the matching header's aria-sort.
 *
 *   title       (alpha):  Alpha, Beta, Gamma
 *   status      (rank):   Beta (broken), Alpha (draft), Gamma (closed)
 *   created_at  (asc):    Alpha (Jan), Gamma (Feb), Beta (Mar)
 *
 * Status sorts by triage rank since Admin table Step 2 (Petra 3.2: Broken 0,
 * Draft 1, Published 2, Closed 3), not alphabetically as it did before
 * (closed, draft, published). Beta is a published `interview` with no
 * sessions, so it is Broken - which keeps status's order a permutation of its
 * own: a published-and-working Beta would sort Alpha, Beta, Gamma, the same as
 * title, and a control wired to title would pass the status case. The
 * Published rank between Draft and Closed is pinned in
 * Admin.triage.test.tsx and adminDashboard.triage.test.ts.
 */

const auth = vi.hoisted(() => ({
  value: {
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin', email: 'admin@example.com' },
    loading: false,
    initialAuthCheck: true,
  },
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/PendingApprovals', () => ({ default: () => null }));
vi.mock('../../components/AdminFeedback', () => ({ default: () => null }));

const opportunities = vi.hoisted(() => ([
  {
    id: 'opp-alpha',
    title: 'Alpha study',
    type: 'test',
    status: 'draft',
    created_at: '2026-01-05T10:00:00.000Z',
    purpose_one_liner: 'See where participants stumble',
    default_duration_minutes: 30,
    updated_at: '2026-01-05T10:00:00.000Z',
    sessions: [],
  },
  {
    id: 'opp-beta',
    title: 'Beta study',
    type: 'interview',
    status: 'published',
    created_at: '2026-03-05T10:00:00.000Z',
    purpose_one_liner: 'See where participants stumble',
    default_duration_minutes: 30,
    updated_at: '2026-03-05T10:00:00.000Z',
    sessions: [],
  },
  {
    id: 'opp-gamma',
    title: 'Gamma study',
    type: 'poll',
    status: 'closed',
    created_at: '2026-02-05T10:00:00.000Z',
    purpose_one_liner: 'See where participants stumble',
    default_duration_minutes: 30,
    updated_at: '2026-02-05T10:00:00.000Z',
    sessions: [],
  },
]));

const stats = vi.hoisted(() => ({
  total_opportunities: 3,
  published_opportunities: 1,
  draft_opportunities: 1,
  closed_opportunities: 1,
  total_bookings: 0,
  upcoming_bookings: 0,
  past_bookings: 0,
  total_participants: 0,
  total_sessions: 0,
  sessions_completed: 0,
  total_slots: 0,
  booked_slots: 0,
  available_slots: 0,
  recent_bookings: [],
}));

vi.mock('../../api/client', () => ({
  getOpportunities: vi.fn().mockResolvedValue(opportunities),
  getDashboardStats: vi.fn().mockResolvedValue(stats),
  deleteOpportunity: vi.fn().mockResolvedValue(undefined),
  duplicateOpportunity: vi.fn().mockResolvedValue(undefined),
  exportBookingsCsv: vi.fn().mockResolvedValue(undefined),
  getPendingApprovals: vi.fn().mockResolvedValue([]),
  getFeedback: vi.fn().mockResolvedValue({ items: [], has_more: false }),
}));

const renderAdmin = () =>
  render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route path="/admin" element={<Admin />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  auth.value = {
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin', email: 'admin@example.com' },
    loading: false,
    initialAuthCheck: true,
  };
});

// Anchor on "Progress" - a header only the studies table has (Recent bookings
// has its own Study and Status headers).
const findStudiesTable = async (): Promise<HTMLElement> => {
  const progressHeader = await screen.findByRole('columnheader', { name: /^progress$/i });
  const table = progressHeader.closest('table');
  expect(table).not.toBeNull();
  return table as HTMLElement;
};

/** The rendered study titles, in DOM order, read from the table body. */
const renderedTitles = (table: HTMLElement): string[] =>
  Array.from(table.querySelectorAll('tbody tr')).map(
    (row) => row.querySelector('.row-title')?.textContent ?? ''
  );

const HEADER_NAME = {
  title: /^study$/i,
  status: /^status$/i,
  created_at: /^created$/i,
} as const;

describe('Research Studies card-view sort control (#131)', () => {
  it.each([
    ['title', ['Alpha study', 'Beta study', 'Gamma study']],
    ['status', ['Beta study', 'Alpha study', 'Gamma study']],
    ['created_at', ['Alpha study', 'Gamma study', 'Beta study']],
  ] as const)('selecting %s in the card control sorts the rows to that field ascending', async (field, expected) => {
    renderAdmin();
    const table = await findStudiesTable();
    const select = await screen.findByLabelText('Sort by') as HTMLSelectElement;

    fireEvent.change(select, { target: { value: field } });

    expect(renderedTitles(table)).toEqual(expected);
    expect(select.value).toBe(field);
    const header = within(table).getByRole('columnheader', { name: HEADER_NAME[field] });
    expect(header).toHaveAttribute('aria-sort', 'ascending');
  });

  it('the direction button reverses the rendered order and flips its visible word', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    const select = await screen.findByLabelText('Sort by');

    fireEvent.change(select, { target: { value: 'title' } });
    expect(renderedTitles(table)).toEqual(['Alpha study', 'Beta study', 'Gamma study']);

    const dirButton = screen.getByRole('button', { name: /Ascending/ });
    fireEvent.click(dirButton);

    expect(renderedTitles(table)).toEqual(['Gamma study', 'Beta study', 'Alpha study']);
    expect(screen.getByRole('button', { name: /Descending/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ascending/ })).toBeNull();
  });

  it('the direction button reverses whichever field is selected, not a fixed one', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    const select = await screen.findByLabelText('Sort by') as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'status' } });
    fireEvent.click(screen.getByRole('button', { name: /Ascending/ }));

    // status descending, by rank: closed, draft, broken.
    expect(renderedTitles(table)).toEqual(['Gamma study', 'Alpha study', 'Beta study']);
    expect(select.value).toBe('status');
    expect(screen.getByRole('button', { name: /Descending/ })).toBeInTheDocument();
  });

  it('changing field resets to ascending, even from a descending state', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    const select = await screen.findByLabelText('Sort by') as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'title' } });
    fireEvent.click(screen.getByRole('button', { name: /Ascending/ }));
    expect(renderedTitles(table)).toEqual(['Gamma study', 'Beta study', 'Alpha study']);

    fireEvent.change(select, { target: { value: 'created_at' } });

    // created_at ascending, not descending - parity with a header click on a
    // new column.
    expect(renderedTitles(table)).toEqual(['Alpha study', 'Gamma study', 'Beta study']);
    expect(screen.getByRole('button', { name: /Ascending/ })).toBeInTheDocument();
  });

  it('shares state with the header buttons - never a parallel mechanism', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    const select = await screen.findByLabelText('Sort by') as HTMLSelectElement;

    // Card select -> header th reflects it.
    fireEvent.change(select, { target: { value: 'status' } });
    const statusHeader = within(table).getByRole('columnheader', { name: /^status$/i });
    const titleHeader = within(table).getByRole('columnheader', { name: /^study$/i });
    const createdHeader = within(table).getByRole('columnheader', { name: /^created$/i });

    expect(statusHeader).toHaveAttribute('aria-sort', 'ascending');
    expect(titleHeader).toHaveAttribute('aria-sort', 'none');
    expect(createdHeader).toHaveAttribute('aria-sort', 'none');

    // Header click -> card select and direction word follow.
    const titleSortButton = within(titleHeader).getByRole('button', { name: /^Study/ });
    fireEvent.click(titleSortButton);

    expect(select.value).toBe('title');
    expect(screen.getByRole('button', { name: /Ascending/ })).toBeInTheDocument();
    expect(titleHeader).toHaveAttribute('aria-sort', 'ascending');
    expect(statusHeader).toHaveAttribute('aria-sort', 'none');

    // Clicking the same header again flips to descending; the card control
    // follows without a second click on it.
    fireEvent.click(titleSortButton);
    expect(screen.getByRole('button', { name: /Descending/ })).toBeInTheDocument();
    expect(titleHeader).toHaveAttribute('aria-sort', 'descending');
  });

  it('offers exactly the fields the headers sort by - no more, no fewer (sort parity, AC14)', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    const select = await screen.findByLabelText('Sort by') as HTMLSelectElement;

    const selectFields = Array.from(select.options).map((o) => o.value);
    // The header side: every <th> carrying a sort button, named by the field
    // its aria-sort follows. Clicking each and reading the select back maps a
    // header to its field without trusting the header's label text.
    const sortHeaders = within(table)
      .getAllByRole('columnheader')
      .filter((th) => th.querySelector('button.admin-th-sort'));
    const headerFields = sortHeaders.map((th) => {
      fireEvent.click(th.querySelector('button.admin-th-sort') as HTMLElement);
      return select.value;
    });

    // Pinned as literals: a set derived from either side could not see the
    // other drift. Type left with its column (Step 1); Next session / deadline
    // became sortable in Step 2 (AC13), on BOTH sides (AC14).
    expect([...selectFields].sort()).toEqual(['created_at', 'next', 'status', 'title']);
    expect([...headerFields].sort()).toEqual(['created_at', 'next', 'status', 'title']);
  });

  it('is absent when there are no studies', async () => {
    const client = await import('../../api/client');
    vi.mocked(client.getOpportunities).mockResolvedValueOnce([]);

    renderAdmin();

    await screen.findByText('No research studies found');
    expect(screen.queryByLabelText('Sort by')).toBeNull();
    expect(screen.queryByRole('group', { name: /sort studies/i })).toBeNull();
  });
});
