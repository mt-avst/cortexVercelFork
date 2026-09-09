import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Admin from '../Admin';
import { formatTimeZoneLabel } from '../../utils/datetime';

// Both defects here are LAYOUT defects that jsdom cannot measure, so each test
// asserts the structural property that makes the layout possible rather than
// the pixels themselves. What was on screen:
//
//  - "Wed 19 Aug 2026 · 23:00 GMT+1" drawn ON TOP of "Demo User 2". The admin
//    tables are `table-layout: fixed` with `overflow-x: hidden` above 992px,
//    so a cell that cannot wrap does not widen its column - it spills into the
//    next one. The cell needed 224px and had 186px.
//  - "Capacity" and "Booked" printing the same number one column apart: both
//    reduce `sessions` over `capacity`, and Booked renders that sum as the
//    denominator of its own ratio. The duplicate column also squeezed Booked
//    hard enough that every ratio wrapped mid-value - "2 /" then "3".

const auth = vi.hoisted(() => ({
  value: {
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin', email: 'admin@example.com' },
    loading: false,
    initialAuthCheck: true,
  },
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));
vi.mock('../../components/PendingApprovals', () => ({ default: () => null }));
vi.mock('../../components/AdminFeedback', () => ({ default: () => null }));

// A bookable study with a single 3-capacity session holding 2 bookings, so the
// Booked ratio has a value ("2 / 3") that a Capacity column would repeat.
const SESSION_START = '2026-08-19T22:00:00.000Z';

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
    sessions: [
      {
        id: 'sess-1',
        opportunity_id: 'opp-1',
        start_time: '2026-08-19T22:00:00.000Z',
        end_time: '2026-08-19T22:45:00.000Z',
        capacity: 3,
        booked_count: 2,
        created_at: '2026-07-01T10:00:00.000Z',
        updated_at: '2026-07-01T10:00:00.000Z',
        remaining: 1,
      },
    ],
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
    recent_bookings: [
      {
        id: 'bk-1',
        opportunity_id: 'opp-1',
        opportunity_title: 'Checkout usability test',
        session_start: '2026-08-19T22:00:00.000Z',
        participant_name: 'Demo User 2',
        participant_email: 'demo2@example.com',
        status: 'booked',
        booked_at: '2026-08-16T09:00:00.000Z',
      },
    ],
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

describe('Recent bookings: the session cell must be able to wrap', () => {
  it('renders the time zone as its own element, so the value breaks across lines instead of over the participant', async () => {
    renderAdmin();

    // The zone the reader's own browser would show. Which zone that is does not
    // matter here and is pinned exhaustively in datetime.test.ts; what matters
    // is that it is a whole element's text and not a fragment of a longer one.
    const zone = formatTimeZoneLabel(SESSION_START);
    expect(zone).toBeTruthy();

    // `getByText` defaults to an exact, whole-element match, so this can only
    // pass if the zone sits in an element of its own. With the date, time and
    // zone in one text node - the state that overlapped the next column - the
    // only candidate element's text is the full string and this fails.
    const zoneEl = await screen.findByText(zone as string);
    expect(zoneEl.textContent).toBe(zone);

    // ...and it is still part of the session cell, not orphaned somewhere else.
    const cell = zoneEl.closest('td');
    expect(cell).not.toBeNull();
    expect(cell?.textContent).toContain(zone as string);

    // The participant is a different cell entirely. This is the collision the
    // fix is about: these two must never be the same td.
    const participant = screen.getByText('Demo User 2').closest('td');
    expect(participant).not.toBeNull();
    expect(participant).not.toBe(cell);
  });
});

// The study title appears in BOTH tables on this page - Recent bookings carries
// it as `opportunity_title` - so every query below is scoped to the studies
// table, reached through the one column header the other table does not have.
const findStudiesTable = async (): Promise<HTMLElement> => {
  // Anchor on "Type", which only the studies table has. Since the redesign the
  // Study column exists on the Recent bookings table too, so "Study" no longer
  // distinguishes them - Type still does.
  const typeHeader = await screen.findByRole('columnheader', { name: /^type/i });
  const table = typeHeader.closest('table');
  expect(table).not.toBeNull();
  return table as HTMLElement;
};

describe('Research Studies table: Capacity and Booked said the same thing', () => {
  it('has no Capacity column, because Recruitment already carries the capacity as its denominator', async () => {
    renderAdmin();
    const table = await findStudiesTable();

    // The old "Booked" column is now "Recruitment" - same booked/capacity ratio,
    // now with the percentage. The guard is unchanged: still no separate Capacity
    // column re-rendering the denominator.
    expect(within(table).getByRole('columnheader', { name: /^recruitment$/i })).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: /^capacity$/i })).toBeNull();
  });

  it('still shows booked against capacity as a single ratio', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    const row = (await within(table).findByText('Checkout usability test')).closest('tr');
    expect(row).not.toBeNull();

    // 2 of 3 booked. The denominator is the capacity, which is why a separate
    // Capacity column was a second rendering of the same number.
    expect(within(row as HTMLElement).getByText('2 / 3')).toBeInTheDocument();
  });
});

// The phone layout (audit row 14) reflows this table into cards below 768px,
// showing each value under its column name. That name comes from the cell's
// `data-label`, so a cell added or a label renamed without updating it would
// leave a phone card field silently unlabelled. jsdom cannot see the CSS, so
// this pins the labels as literals instead - it fails by name if the reflow's
// labels drift from the columns.
describe('Research Studies table: every body cell is labelled for the phone card reflow', () => {
  it('gives each cell a data-label matching its column, in order', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    const row = (await within(table).findByText('Checkout usability test')).closest('tr');
    expect(row).not.toBeNull();

    const cells = Array.from((row as HTMLElement).querySelectorAll('td'));
    expect(cells.length).toBeGreaterThan(0);
    for (const td of cells) {
      expect(td.getAttribute('data-label')?.trim()).toBeTruthy();
    }

    expect(cells.map((td) => td.getAttribute('data-label'))).toEqual([
      'Study',
      'Type',
      'Status',
      'Recruitment',
      'Clicks',
      'Next / deadline',
      'Created',
      'Actions',
    ]);
  });
});
