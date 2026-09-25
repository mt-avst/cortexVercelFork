import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Home from '../Home';
import { checkParticipateVisit } from '../../api/client';
import type { Opportunity } from '../../api/types';

/**
 * "New since your last visit" (cto/AdaptaLabs#168). Home calls
 * checkParticipateVisit once per mount, independently of the study list
 * fetch, and intersects its ids with the rendered rows - the row itself only
 * draws the badge (see OpportunityRow.test.tsx for that half).
 */
const study = (over: Partial<Opportunity>): Opportunity =>
  ({
    id: over.id ?? 'o',
    type: 'test',
    title: 't',
    purpose_one_liner: 'p',
    status: 'published',
    default_duration_minutes: 30,
    ...over,
  }) as Opportunity;

const STUDIES: Opportunity[] = [
  study({ id: 'a', title: 'Checkout flow walkthrough' }),
  study({ id: 'b', title: 'Onboarding tone' }),
];

vi.mock('../../api/client', () => ({
  getOpportunities: vi.fn(async () => STUDIES),
  checkParticipateVisit: vi.fn(async () => ({ newOpportunityIds: ['a'] })),
}));

let currentUser: { id: string; role: string; name: string } = { id: 'u1', role: 'employee', name: 'A' };
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: currentUser, loading: false }),
}));

// A FUNCTION, not a shared element constant: React bails out of re-rendering
// a subtree when `rerender()` is handed the literal same element object a
// second time (its fast path treats identical references as "nothing could
// have changed"), which silently no-ops the user-switch test below against a
// tree built once. A fresh element per call has no such shortcut.
const homeTree = () => (
  <MemoryRouter initialEntries={['/']}>
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  </MemoryRouter>
);

const renderHome = () => render(homeTree());

describe('Home "New" badge (#168)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { id: 'u1', role: 'employee', name: 'A' };
  });

  it('badges only the study named in the visit response, not every row', async () => {
    vi.mocked(checkParticipateVisit).mockResolvedValueOnce({ newOpportunityIds: ['a'] });
    renderHome();

    await waitFor(() => expect(screen.getByText('Checkout flow walkthrough')).toBeInTheDocument());

    const newRow = screen.getByText('Checkout flow walkthrough').closest('li');
    const oldRow = screen.getByText('Onboarding tone').closest('li');
    expect(newRow).not.toBeNull();
    expect(oldRow).not.toBeNull();
    expect(newRow && within(newRow as HTMLElement).getByText('New')).toBeVisible();
    expect(oldRow && within(oldRow as HTMLElement).queryByText('New')).toBeNull();
  });

  it('shows no badge anywhere when the visit response marks nothing new', async () => {
    vi.mocked(checkParticipateVisit).mockResolvedValueOnce({ newOpportunityIds: [] });
    renderHome();

    await waitFor(() => expect(screen.getByText('Checkout flow walkthrough')).toBeInTheDocument());
    expect(screen.queryByText('New')).toBeNull();
  });

  it('does not let a failed visit check delay or break the list', async () => {
    vi.mocked(checkParticipateVisit).mockRejectedValueOnce(new Error('network down'));
    renderHome();

    await waitFor(() => expect(screen.getByText('Checkout flow walkthrough')).toBeInTheDocument());
    expect(screen.queryByText('New')).toBeNull();
  });

  it('asks the visit endpoint once, not once per opportunity or render', async () => {
    renderHome();

    await waitFor(() => expect(screen.getByText('Checkout flow walkthrough')).toBeInTheDocument());
    expect(vi.mocked(checkParticipateVisit)).toHaveBeenCalledTimes(1);
  });

  // The `checkedVisitForUserIdRef` guard exists specifically to absorb React
  // StrictMode's dev-only double-invoke of this effect.
  it('asks the visit endpoint once even under React.StrictMode', async () => {
    render(
      <React.StrictMode>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Home />} />
          </Routes>
        </MemoryRouter>
      </React.StrictMode>
    );

    await waitFor(() => expect(screen.getByText('Checkout flow walkthrough')).toBeInTheDocument());
    expect(vi.mocked(checkParticipateVisit)).toHaveBeenCalledTimes(1);
  });

  // checkedVisitForUserIdRef holds the id the visit was checked FOR, not a
  // bare boolean, so a signed-in identity change in the same mounted Home
  // instance re-asks rather than reading as "already checked" for whoever is
  // signed in now.
  it('a user switch in the same mounted instance re-asks the visit endpoint', async () => {
    const { rerender } = renderHome();
    await waitFor(() => expect(screen.getByText('Checkout flow walkthrough')).toBeInTheDocument());
    expect(vi.mocked(checkParticipateVisit)).toHaveBeenCalledTimes(1);

    currentUser = { id: 'u2', role: 'employee', name: 'B' };
    rerender(homeTree());

    await waitFor(() => expect(vi.mocked(checkParticipateVisit)).toHaveBeenCalledTimes(2));
  });
});
