import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

import OpportunityOverview from '../../OpportunityOverview';
import type { Opportunity, OpportunityBookingRow } from '../../../api/types';

/**
 * Shared fixture and render helpers for the study overview page's own specs
 * (cto/AdaptaLabs#163): `OpportunityOverview.render-states.test.tsx`,
 * `.publish-problems.test.tsx`, `.sessions-bookings.test.tsx`.
 *
 * As with `helpers/admin-triage.tsx`, each spec file keeps its own
 * `vi.mock('../../api/client', ...)` and `vi.mock('../../contexts/AuthContext', ...)`
 * calls - `vi.mock` factories can only close over `vi.hoisted()` bindings in
 * their OWN file, so the mutable `auth` wrapper cannot live here. What this
 * file exports is pure data plus a render function that assumes those two
 * mocks are already in place.
 */

export const NOW = new Date('2026-09-25T12:00:00.000Z');

export const MANAGER_USER = { id: 'admin-1', role: 'researcher_admin', name: 'Admin', email: 'admin@example.com' };
export const SUPERADMIN_USER = { id: 'super-1', role: 'superadmin', name: 'Super', email: 'super@example.com' };
export const OTHER_USER = { id: 'other-1', role: 'researcher_admin', name: 'Other', email: 'other@example.com' };

const DAY = 24 * 60 * 60 * 1000;
export const inDays = (days: number): string => new Date(NOW.getTime() + days * DAY).toISOString();

export const session = (
  id: string,
  daysFromNow: number,
  capacity: number,
  booked: number,
  durationMinutes = 60
): NonNullable<Opportunity['sessions']>[number] => ({
  id,
  opportunity_id: 'opp-1',
  start_time: inDays(daysFromNow),
  end_time: new Date(NOW.getTime() + daysFromNow * DAY + durationMinutes * 60 * 1000).toISOString(),
  capacity,
  booked_count: booked,
  remaining: capacity - booked,
  created_at: '2026-07-01T10:00:00.000Z',
  updated_at: '2026-07-01T10:00:00.000Z',
});

const base = {
  id: 'opp-1',
  purpose_one_liner: 'See where participants stumble',
  default_duration_minutes: 30,
  created_at: '2026-07-01T10:00:00.000Z',
  updated_at: '2026-07-01T10:00:00.000Z',
  owner_user_id: MANAGER_USER.id,
  owner_name: MANAGER_USER.name,
  owner_email: MANAGER_USER.email,
  sessions: [],
};

export const study = (over: Partial<Opportunity> & Pick<Opportunity, 'title'>): Opportunity => ({
  ...base,
  type: 'unmoderated',
  status: 'published',
  ...over,
});

export const booking = (
  id: string,
  sessionStartIso: string,
  over: Partial<OpportunityBookingRow> = {}
): OpportunityBookingRow => ({
  id,
  user_id: `user-${id}`,
  session_id: `sess-${id}`,
  status: 'confirmed',
  completion_status: null,
  session_start_time: sessionStartIso,
  session_end_time: new Date(new Date(sessionStartIso).getTime() + 60 * 60 * 1000).toISOString(),
  participant_name: `Participant ${id}`,
  participant_email: `${id}@example.com`,
  business_unit: null,
  role_title: null,
  researcher_notes: null,
  researcher_notes_updated_at: null,
  consent_accepted_at: null,
  created_at: '2026-07-01T10:00:00.000Z',
  updated_at: '2026-07-01T10:00:00.000Z',
  ...over,
});

/** Renders where navigation went, so the Back button's destination is observable. */
const Probe: React.FC<{ label: string }> = ({ label }) => {
  const location = useLocation();
  return <div data-testid="probe">{`${label} ${location.pathname}`}</div>;
};

/**
 * Exposed separately from `renderOverview` so a test that needs to force a
 * second render pass (the cold-load auth race, where `useAuth()`'s mocked
 * return value changes with no state update of the component's own to
 * trigger a re-render) can call RTL's `rerender` with the identical tree.
 */
export const overviewTree = (id = 'opp-1') => (
  <MemoryRouter initialEntries={[`/admin/opportunities/${id}`]}>
    <Routes>
      <Route path="/admin/opportunities/:id" element={<OpportunityOverview />} />
      <Route path="/admin" element={<Probe label="ADMIN" />} />
    </Routes>
  </MemoryRouter>
);

export const renderOverview = (id = 'opp-1') => render(overviewTree(id));

/** A promise whose settling the test controls - a fetch still in flight. */
export const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
