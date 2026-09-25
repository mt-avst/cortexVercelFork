import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Admin from '../Admin';
import { getOpportunities } from '../../api/client';

/**
 * #167: the Create & Manage subtitle, pinned literally. `Admin.test.tsx`
 * already pins the page's own H1; this file is the standalone proof for the
 * standfirst beneath it, which #167 changed from "Manage research studies,
 * bookings, and participant feedback" to the exact sentence below - a
 * minimal harness rather than an addition to the shared, heavily set-up
 * `Admin.test.tsx`.
 */

const auth = vi.hoisted(() => ({
  value: {
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin', email: 'admin@example.com' },
    loading: false,
    initialAuthCheck: true,
  },
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => auth.value,
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light' }),
}));

vi.mock('../../components/PendingApprovals', () => ({ default: () => null }));
vi.mock('../../components/AdminFeedback', () => ({ default: () => null }));

vi.mock('../../api/client', () => ({
  getOpportunities: vi.fn().mockResolvedValue([]),
  getDashboardStats: vi.fn().mockResolvedValue({
    total_opportunities: 0,
    published_opportunities: 0,
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
  }),
  deleteOpportunity: vi.fn().mockResolvedValue(undefined),
  duplicateOpportunity: vi.fn().mockResolvedValue(undefined),
  exportBookingsCsv: vi.fn().mockResolvedValue(undefined),
  getPendingApprovals: vi.fn().mockResolvedValue([]),
  getFeedback: vi.fn().mockResolvedValue({ items: [], has_more: false }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOpportunities).mockResolvedValue([] as never);
});

const renderAdmin = () =>
  render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route path="/admin" element={<Admin />} />
      </Routes>
    </MemoryRouter>
  );

describe('Admin - the Create & Manage subtitle (#167)', () => {
  it('reads exactly "Run your research studies, bookings and participant feedback"', async () => {
    renderAdmin();

    await screen.findByRole('heading', { level: 1, name: 'Create & Manage' });

    // Exact text, not a substring match: a serial Oxford comma dropped from
    // the old copy ("bookings, and participant feedback" -> "bookings and
    // participant feedback") alongside the "Manage" -> "Run" swap, and a
    // substring check tolerant of either half would miss a partial revert.
    expect(
      screen.getByText('Run your research studies, bookings and participant feedback')
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Manage research studies/i)
    ).not.toBeInTheDocument();
  });
});
