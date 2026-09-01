import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Admin from '../Admin';
import { OPPORTUNITY_TYPES } from '@shared/constants';
import { getParticipantFacingType } from '../../utils/opportunityUtils';

// One name per type, everywhere. A `test` was "User Test" in the authoring
// form, "APP TESTING" on this dashboard's badge and "Usability test" on browse
// - three words for one thing, so a researcher and a participant could not
// discuss the same study without translating. `getParticipantFacingType` is now
// the only place a type is turned into words.
//
// The filter also silently omitted `unmoderated`, so recorded studies - the
// whole reason the type exists - could not be filtered for at all.

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

const fixtures = vi.hoisted(() => ({
  opportunities: [
    {
      id: 'opp-1',
      type: 'test',
      title: 'Checkout usability test',
      purpose_one_liner: 'See where participants stumble',
      default_duration_minutes: 30,
      status: 'published',
      created_at: '2026-07-01T10:00:00.000Z',
      updated_at: '2026-07-01T10:00:00.000Z',
    },
    {
      id: 'opp-2',
      type: 'unmoderated',
      title: 'Search relevance walkthrough',
      purpose_one_liner: 'Why did that result rank first',
      default_duration_minutes: 30,
      status: 'published',
      created_at: '2026-07-02T10:00:00.000Z',
      updated_at: '2026-07-02T10:00:00.000Z',
    },
  ],
  stats: {
    total_opportunities: 2,
    published_opportunities: 2,
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

vi.mock('../../api/client', () => ({
  getOpportunities: vi.fn().mockResolvedValue(fixtures.opportunities),
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

const allTypes = Object.values(OPPORTUNITY_TYPES);

describe('Admin dashboard type names', () => {
  it('uses the short admin type label in the dense table', async () => {
    renderAdmin();
    // Anchor on "Type" - unique to the studies table since the Recent bookings
    // table gained its own "Study" header in the redesign.
    const typeHeader = await screen.findByRole('columnheader', { name: /^type/i });
    const table = typeHeader.closest('table') as HTMLElement;

    // The two "... session" names are shortened for the admin table only
    // (getAdminTypeLabel), so the type pill does not crowd the status pill.
    // The full "Live session"/"Recorded session" still live on the participant
    // browse via getParticipantFacingType - and the filter dropdown below still
    // uses the full names, asserted in the filter tests.
    expect(within(table).getByText('Live')).toBeInTheDocument();
    expect(within(table).getByText('Recorded')).toBeInTheDocument();
    expect(within(table).queryByText('Live session')).toBeNull();
    expect(within(table).queryByText('Recorded session')).toBeNull();
  });

  it('never badges a study with the admin-only taxonomy', async () => {
    renderAdmin();
    // Anchor on "Type" - unique to the studies table since the Recent bookings
    // table gained its own "Study" header in the redesign.
    const typeHeader = await screen.findByRole('columnheader', { name: /^type/i });
    const table = typeHeader.closest('table') as HTMLElement;

    expect(table.textContent).not.toMatch(/app testing/i);
    expect(table.textContent).not.toMatch(/unmoderated/i);
  });
});

describe('Admin study type filter', () => {
  it('offers every type a researcher can create - including unmoderated, which it used to omit', async () => {
    renderAdmin();
    const filter = await screen.findByLabelText(/study type/i);

    const values = [...filter.querySelectorAll('option')].map((o) => (o as HTMLOptionElement).value);
    for (const type of allTypes) {
      expect(values, `no filter option for "${type}"`).toContain(type);
    }
  });

  it('labels each option with the one name that type has', async () => {
    renderAdmin();
    const filter = await screen.findByLabelText(/study type/i);

    for (const type of allTypes) {
      const option = [...filter.querySelectorAll('option')].find(
        (o) => (o as HTMLOptionElement).value === type
      );
      expect(option?.textContent).toContain(getParticipantFacingType(type));
    }
  });

  it('keeps an unfiltered default', async () => {
    renderAdmin();
    const filter = (await screen.findByLabelText(/study type/i)) as HTMLSelectElement;
    expect(filter.value).toBe('');
  });
});
