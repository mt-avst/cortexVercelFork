import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Admin from '../Admin';

/**
 * Row 6: four seeded PUBLISHED studies fail their own publish readiness
 * (zero questions, no external link, two moderated with no meeting location
 * and zero slots), and the dashboard showed every one of them exactly like a
 * working study. This pins the one state word - "Broken" (#157) -
 * on the dashboard row, for the two cases this signal CAN prove from the
 * fields the dashboard's own list response already carries: a moderated
 * study with no venue or no slot, and a hand-off with no link and nothing
 * linked. `step-status.test.ts` covers `isPublishedButNotWorking` itself,
 * including the known gap (a native survey/unmoderated study with no
 * content, which this signal cannot see and does not guess at).
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

const STATS = vi.hoisted(() => ({
  value: {
    total_opportunities: 1,
    published_opportunities: 1,
    draft_opportunities: 0,
    closed_opportunities: 0,
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
  },
}));

const opportunities = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('../../api/client', () => ({
  getOpportunities: vi.fn(() => Promise.resolve(opportunities.value)),
  getDashboardStats: vi.fn(() => Promise.resolve(STATS.value)),
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

const findStudiesTable = async (): Promise<HTMLElement> => {
  const typeHeader = await screen.findByRole('columnheader', { name: /^type/i });
  const table = typeHeader.closest('table');
  expect(table).not.toBeNull();
  return table as HTMLElement;
};

beforeEach(() => {
  vi.clearAllMocks();
  opportunities.value = [];
});

describe('Admin dashboard row: published but not working (row 6)', () => {
  it('shows the shared state word for a published moderated study with no venue', async () => {
    opportunities.value = [
      {
        id: 'opp-broken',
        type: 'test',
        title: 'Test the new Jira board view',
        purpose_one_liner: 'See where reviewers stumble',
        default_duration_minutes: 30,
        status: 'published',
        created_at: '2026-07-01T10:00:00.000Z',
        updated_at: '2026-07-01T10:00:00.000Z',
        meeting_location_optional: '',
        sessions: [],
      },
    ];
    renderAdmin();
    const table = await findStudiesTable();
    const row = (await within(table).findByText('Test the new Jira board view')).closest('tr');
    expect(row).not.toBeNull();

    const label = within(row as HTMLElement).getByText('Broken');
    expect(within(row as HTMLElement).queryByText('PUBLISHED')).not.toBeInTheDocument();

    // #157: the fill and glyph are the Draft pill's, so "published" is said
    // in words - hidden for a screen reader, and as the hover title.
    const pill = label.closest('.admin-study-status') as HTMLElement;
    expect(pill.textContent).toBe('Published, Broken');
    expect(within(pill).getByText('Published,').className).toBe('visually-hidden');
    expect(label).toHaveAttribute('title', 'Published, not working');
  });

  it('shows the ordinary status word for a published study that is actually ready', async () => {
    opportunities.value = [
      {
        id: 'opp-fine',
        type: 'test',
        title: 'A live session that is fully booked',
        purpose_one_liner: 'A working control',
        default_duration_minutes: 30,
        status: 'published',
        created_at: '2026-07-01T10:00:00.000Z',
        updated_at: '2026-07-01T10:00:00.000Z',
        meeting_location_optional: 'Zoom',
        sessions: [
          {
            id: 'sess-1',
            opportunity_id: 'opp-fine',
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
    ];
    renderAdmin();
    const table = await findStudiesTable();
    const row = (await within(table).findByText('A live session that is fully booked')).closest('tr');
    expect(row).not.toBeNull();

    expect(within(row as HTMLElement).getByText('PUBLISHED')).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText('Broken')).not.toBeInTheDocument();
  });

  it('never fires on a draft, however empty its content is', async () => {
    opportunities.value = [
      {
        id: 'opp-draft',
        type: 'test',
        title: 'An unfinished draft',
        purpose_one_liner: 'Not published yet',
        default_duration_minutes: 30,
        status: 'draft',
        created_at: '2026-07-01T10:00:00.000Z',
        updated_at: '2026-07-01T10:00:00.000Z',
        meeting_location_optional: '',
        sessions: [],
      },
    ];
    renderAdmin();
    const table = await findStudiesTable();
    const row = (await within(table).findByText('An unfinished draft')).closest('tr');
    expect(row).not.toBeNull();

    expect(within(row as HTMLElement).getByText('DRAFT')).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText('Broken')).not.toBeInTheDocument();
  });
});
