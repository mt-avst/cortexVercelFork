import React from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { expect, vi } from 'vitest';

import Admin from '../../Admin';
import { getOpportunities } from '../../../api/client';

/**
 * Shared fixture and helpers for the Admin Research Studies triage specs
 * (Admin.triage.test.tsx, Admin.close-in-place.test.tsx). Each spec file keeps
 * its own `vi.mock` calls - they are per file - and mocks `../../api/client`
 * with `vi.fn()`s that its beforeEach points at these fixtures.
 *
 * The page takes "now" from the real clock at mount, so every milestone here
 * is placed relative to the real clock at import time, at distances no test
 * run can straddle (whole days, or 0.1 day either side of the 3-day horizon).
 */

export const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.now();
export const inDays = (days: number): string => new Date(T0 + days * DAY).toISOString();

export const session = (id: string, oppId: string, days: number, capacity: number, booked: number) => ({
  id,
  opportunity_id: oppId,
  start_time: inDays(days),
  end_time: new Date(T0 + days * DAY + 60 * 60 * 1000).toISOString(),
  capacity,
  booked_count: booked,
  remaining: capacity - booked,
  created_at: '2026-07-01T10:00:00.000Z',
  updated_at: '2026-07-01T10:00:00.000Z',
});

const base = {
  purpose_one_liner: 'See where participants stumble',
  default_duration_minutes: 30,
  created_at: '2026-07-01T10:00:00.000Z',
  updated_at: '2026-07-01T10:00:00.000Z',
  owner_user_id: 'admin-1',
  owner_name: 'Admin',
  owner_email: 'admin@example.com',
};

export type FixtureStudy = typeof base & {
  id: string;
  type: string;
  title: string;
  status: string;
  sessions: ReturnType<typeof session>[];
  [key: string]: unknown;
};

export const study = (over: Partial<FixtureStudy> & Pick<FixtureStudy, 'id' | 'title'>): FixtureStudy => ({
  ...base,
  type: 'test',
  status: 'published',
  sessions: [],
  ...over,
});

// Six studies, one per triage state and chip, in NO sorted order. Broken = a
// published moderated study with no bookable slot.
export const STUDIES: FixtureStudy[] = [
  study({ id: 'opp-closed', title: 'Closed study', status: 'closed', auto_closed: true }),
  // 30 days out, 1 of 3 booked: Needs recruitment.
  study({ id: 'opp-live', title: 'Live study', sessions: [session('s-live', 'opp-live', 30, 3, 1)] }),
  study({ id: 'opp-broken-b', type: 'interview', title: 'Second broken study' }),
  study({
    id: 'opp-colleague',
    title: 'Colleague study',
    owner_user_id: 'someone-else',
    owner_name: 'Dana Owner',
    owner_email: 'dana@example.com',
    purpose_one_liner: 'A colleague purpose',
    // 10 days out, 2 of 2 booked: Fully booked.
    sessions: [session('s-colleague', 'opp-colleague', 10, 2, 2)],
  }),
  study({ id: 'opp-draft', title: 'Draft study', status: 'draft' }),
  study({ id: 'opp-broken-a', title: 'Broken test study' }),
];

export const STATS = {
  total_opportunities: 6,
  published_opportunities: 4,
  draft_opportunities: 1,
  closed_opportunities: 1,
  total_bookings: 0,
  upcoming_bookings: 0,
  past_bookings: 0,
  total_participants: 0,
  total_sessions: 2,
  sessions_completed: 0,
  total_slots: 5,
  booked_slots: 3,
  available_slots: 2,
  recent_bookings: [],
};

export const byId = (id: string): FixtureStudy => {
  const found = STUDIES.find((s) => s.id === id);
  if (!found) throw new Error(`no fixture study ${id}`);
  return found;
};

export const ADMIN_USER = { id: 'admin-1', role: 'researcher_admin', name: 'Admin', email: 'admin@example.com' };
export const SUPERADMIN_USER = { id: 'super-1', role: 'superadmin', name: 'Super', email: 'super@example.com' };

/** Renders where navigation went, so a destination is observable. */
const Probe: React.FC<{ label: string }> = ({ label }) => {
  const location = useLocation();
  return <div data-testid="probe">{`${label} ${location.pathname}`}</div>;
};

export const renderAdmin = () =>
  render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route path="/admin" element={<Admin />} />
        <Route path="/admin/opportunities/:id/edit" element={<Probe label="EDIT" />} />
        <Route path="/admin/opportunities/:id/analytics" element={<Probe label="ANALYTICS" />} />
        <Route path="/opportunities/:id" element={<Probe label="PREVIEW" />} />
      </Routes>
    </MemoryRouter>
  );

// Anchor on "Progress" - a header only the studies table has.
export const findStudiesTable = async (): Promise<HTMLElement> => {
  const progressHeader = await screen.findByRole('columnheader', { name: /^progress$/i });
  const table = progressHeader.closest('table');
  expect(table).not.toBeNull();
  return table as HTMLElement;
};

/** The study rows, in DOM order - not the in-place notice rows between them. */
export const studyRows = (table: HTMLElement): HTMLElement[] =>
  Array.from(table.querySelectorAll<HTMLElement>('tbody tr')).filter((row) => row.querySelector('.row-title'));

export const renderedTitles = (table: HTMLElement): string[] =>
  studyRows(table).map((row) => row.querySelector('.row-title')?.textContent ?? '');

export const rowFor = (table: HTMLElement, title: string): HTMLElement => {
  const row = within(table).getByText(title).closest('tr');
  expect(row).not.toBeNull();
  return row as HTMLElement;
};

export const titleLink = (table: HTMLElement, title: string): HTMLElement =>
  within(rowFor(table, title)).getByRole('link', { name: title });

export const statusLabel = (row: HTMLElement) => row.querySelector('.admin-study-status__label')?.textContent;

export const openRowMenu = (row: HTMLElement, title: string) => {
  fireEvent.click(within(row).getByRole('button', { name: `Actions for ${title}` }));
  return screen.getByRole('menu');
};

export const clickClose = (table: HTMLElement, title: string) =>
  fireEvent.click(within(openRowMenu(rowFor(table, title), title)).getByRole('menuitem', { name: 'Close study' }));

// Copy since the fix round (review P5): the title in curly quotes, no
// trailing stop, so "Closed “Which editor?”" never reads "...?.".
export const undoNotice = (title: string): HTMLElement | null =>
  (screen.queryByText(`Closed “${title}”`)?.closest('[role="status"]') as HTMLElement | null | undefined) ?? null;

export const undoButtonFor = (title: string): HTMLElement =>
  within(undoNotice(title) as HTMLElement).getByRole('button', { name: 'Undo' });

export const showAllResearchers = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Show all researchers' }));
  await waitFor(() => expect(vi.mocked(getOpportunities)).toHaveBeenLastCalledWith({ scope: 'all' }));
  return findStudiesTable();
};

/**
 * Every setTimeout registered with the 8000ms delay after this is installed
 * is wrapped, so its firing is counted - attributable to the undo lapse timer
 * itself, unlike a global getTimerCount(). Install AFTER vi.useFakeTimers().
 */
export const trackLapseTimers = () => {
  const fired = { count: 0, armed: 0 };
  const fakeSetTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: TimerHandler,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms === 8000 && typeof handler === 'function') {
      fired.armed += 1;
      const wrapped = (...a: unknown[]) => {
        fired.count += 1;
        (handler as (...x: unknown[]) => void)(...a);
      };
      return fakeSetTimeout(wrapped, ms, ...args);
    }
    return fakeSetTimeout(handler, ms, ...args);
  }) as typeof setTimeout);
  return { fired, spy };
};

/** A promise whose settling the test controls - a PATCH still in flight. */
export const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
