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
  // Anchor on "Progress", which only the studies table has. The Study and
  // Status columns exist on the Recent bookings table too, and the Type column
  // the anchor used to be is gone (Admin table Step 1).
  const progressHeader = await screen.findByRole('columnheader', { name: /^progress$/i });
  const table = progressHeader.closest('table');
  expect(table).not.toBeNull();
  return table as HTMLElement;
};

describe('Research Studies table: Capacity and Booked said the same thing', () => {
  it('has no Capacity column, because Progress already carries the capacity as its denominator', async () => {
    renderAdmin();
    const table = await findStudiesTable();

    // The old "Booked" column became "Recruitment" and is now "Progress" - same
    // booked/capacity ratio, with the percentage. The guard is unchanged: still
    // no separate Capacity column re-rendering the denominator.
    expect(within(table).getByRole('columnheader', { name: /^progress$/i })).toBeInTheDocument();
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

// The card layout (audit row 14) reflows this table into cards below 1024px,
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
      'Status',
      'Progress',
      'Next / deadline',
      'Created',
      'Actions',
    ]);
  });
});

// Admin table Step 1 (2026-09-23). Under `table-layout: fixed` the <col>
// widths decide the layout, and the CSS hides Created as one unit (col, th,
// td) below 1280px - so the colgroup, the header row and every body row must
// agree on the same six columns in the same order, or a hidden column drags
// the wrong neighbour with it.
describe('Research Studies table: six columns, one colgroup', () => {
  it('declares a <col> per column, in header order, with Study first and Actions last', async () => {
    renderAdmin();
    const table = await findStudiesTable();

    const cols = Array.from(table.querySelectorAll('colgroup > col')).map((c) => c.className);
    expect(cols).toEqual(['col-title', 'col-status', 'col-progress', 'col-next', 'col-date', 'col-actions']);

    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.className.replace('admin-th ', ''));
    expect(headers).toEqual(cols);

    const row = (await within(table).findByText('Checkout usability test')).closest('tr') as HTMLElement;
    expect(Array.from(row.querySelectorAll('td')).map((td) => td.className)).toEqual(cols);
  });

  it('has no Type or Clicks column any more', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    expect(within(table).queryByRole('columnheader', { name: /^type$/i })).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: /^clicks$/i })).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: /^recruitment$/i })).toBeNull();
  });
});

describe('Research Studies table: the Study cell names the row', () => {
  it('carries the type pill on the meta line, before the purpose, and the full strings in title attributes', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    const title = await within(table).findByText('Checkout usability test');
    const cell = title.closest('td') as HTMLElement;
    expect(cell).toHaveClass('col-title');

    // Clamped to two lines and one line by CSS, so the full text must survive
    // somewhere a pointer can reach it.
    expect(title).toHaveAttribute('title', 'Checkout usability test');
    const purpose = within(cell).getByText('See where participants stumble at checkout');
    expect(purpose).toHaveAttribute('title', 'See where participants stumble at checkout');

    // Type pill ("Live" for a `test` study) then purpose, on one meta line.
    const meta = cell.querySelector('.admin-study-meta') as HTMLElement;
    expect(meta).not.toBeNull();
    const pill = within(meta).getByText('Live').closest('.admin-pill') as HTMLElement;
    expect(pill).not.toBeNull();
    expect(meta.firstElementChild).toBe(pill);
    expect(meta.lastElementChild).toBe(purpose);
  });
});

describe('Research Studies table: Progress folds Recruitment and Clicks together', () => {
  const study = (overrides: Record<string, unknown>) => ({
    ...fixtures.opportunity,
    sessions: [],
    clicks_total: 0,
    ...overrides,
  });

  const progressCellFor = async (title: string): Promise<HTMLElement> => {
    const table = await findStudiesTable();
    const row = (await within(table).findByText(title)).closest('tr') as HTMLElement;
    return row.querySelector('td.col-progress') as HTMLElement;
  };

  it('shows clicks for a published study of a type that never has sessions', async () => {
    const client = await import('../../api/client');
    vi.mocked(client.getOpportunities).mockResolvedValueOnce([
      study({ id: 'opp-poll', type: 'poll', title: 'Pick a name', clicks_total: 18 }),
      study({ id: 'opp-one', type: 'survey', title: 'One click survey', clicks_total: 1 }),
    ] as never);
    renderAdmin();

    expect((await progressCellFor('Pick a name')).textContent).toBe('18 clicks');
    // Singular, not "1 clicks".
    expect((await progressCellFor('One click survey')).textContent).toBe('1 click');
  });

  it('shows the muted dash for a draft and for a session type with no sessions yet - never "0 clicks"', async () => {
    const client = await import('../../api/client');
    vi.mocked(client.getOpportunities).mockResolvedValueOnce([
      study({ id: 'opp-draft', type: 'poll', status: 'draft', title: 'Draft poll', clicks_total: 4 }),
      study({ id: 'opp-empty', type: 'interview', title: 'Interview with no slots', clicks_total: 9 }),
    ] as never);
    renderAdmin();

    for (const title of ['Draft poll', 'Interview with no slots']) {
      const cell = await progressCellFor(title);
      expect(cell.textContent, title).toBe('–');
      expect(cell.querySelector('.admin-cell-empty'), title).not.toBeNull();
    }
  });

  it('keeps booked / capacity for a study with sessions, whatever its clicks', async () => {
    const client = await import('../../api/client');
    vi.mocked(client.getOpportunities).mockResolvedValueOnce([
      study({ ...fixtures.opportunity, clicks_total: 40 }),
    ] as never);
    renderAdmin();

    const cell = await progressCellFor('Checkout usability test');
    expect(within(cell).getByText('2 / 3')).toBeInTheDocument();
    expect(cell.textContent).not.toMatch(/click/);
  });
});

// "Thu 24 Sept 2026 · 16:00" on one line measured ~174px against the Next
// column's 152px content box (176px col, 12px padding each side); nowrap
// there spills into Created, wrapping splits the time from its date. The time
// leads the caption line instead (Admin table Step 1).
describe('Research Studies table: Next session / deadline keeps the date on one line', () => {
  it("puts a session's clock time on the caption line, ahead of its relative day - not beside the date", async () => {
    const client = await import('../../api/client');
    vi.mocked(client.getOpportunities).mockResolvedValueOnce([
      {
        ...fixtures.opportunity,
        sessions: [
          {
            ...fixtures.opportunity.sessions[0],
            start_time: '2099-01-15T16:00:00.000Z',
            end_time: '2099-01-15T16:45:00.000Z',
          },
        ],
      },
    ] as never);
    renderAdmin();
    const table = await findStudiesTable();
    const row = (await within(table).findByText('Checkout usability test')).closest('tr') as HTMLElement;
    const next = row.querySelector('td.col-next') as HTMLElement;

    const date = next.querySelector('.admin-next__date') as HTMLElement;
    const note = next.querySelector('.admin-next__note') as HTMLElement;
    expect(date).not.toBeNull();
    expect(note).not.toBeNull();
    // Control: the time is rendered at all (a missing time would pass the
    // "not in the date line" check below trivially).
    const time = next.querySelector('.admin-next__time') as HTMLElement;
    expect(time?.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(date.contains(time)).toBe(false);
    expect(note.contains(time)).toBe(true);
    expect(date.textContent).not.toMatch(/\d{2}:\d{2}/);
    // Beyond a week out there is no relative day, so no dangling separator.
    expect(note.textContent).toBe(time.textContent);
  });
});
