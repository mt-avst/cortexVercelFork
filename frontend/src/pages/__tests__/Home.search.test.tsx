import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Home from '../Home';
import type { Opportunity } from '../../api/types';

/**
 * Browse keyword search (phase 3): a debounced title+purpose search that narrows
 * the already-loaded published set and ANDs with the facets. Driven end-to-end
 * here through the real Home wiring (input -> debounce -> filter -> rows).
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
  study({ id: 'a', type: 'test', title: 'Checkout flow walkthrough', purpose_one_liner: 'Where people stall before payment' }),
  study({ id: 'b', type: 'poll', title: 'Onboarding tone', purpose_one_liner: 'Pick the voice for the new flow' }),
  study({ id: 'c', type: 'test', title: 'Dashboard usability', purpose_one_liner: 'Find the navigation snags' }),
];

vi.mock('../../api/client', () => ({
  getOpportunities: vi.fn(async () => STUDIES),
  // #168: independent fetch Home also makes on mount - stub it so it never
  // hits a real client, and answer "nothing new" like the real fail-closed
  // contract does on an unmocked call.
  checkParticipateVisit: vi.fn(async () => ({ newOpportunityIds: [] })),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'employee', name: 'A' }, loading: false }),
}));

const renderHome = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </MemoryRouter>
  );

describe('Home keyword search', () => {
  beforeEach(() => vi.clearAllMocks());

  it('narrows the list to studies whose title or purpose matches, and echoes the term', async () => {
    const user = userEvent.setup();
    renderHome();

    // All three load first.
    await waitFor(() => expect(screen.getByText('Onboarding tone')).toBeInTheDocument());
    expect(screen.getByText('Checkout flow walkthrough')).toBeInTheDocument();
    expect(screen.getByText('Dashboard usability')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /search studies/i }), 'onboarding');

    // Debounced: the non-matching rows drop out.
    await waitFor(() => expect(screen.queryByText('Checkout flow walkthrough')).toBeNull());
    expect(screen.getByText('Onboarding tone')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard usability')).toBeNull();

    // The count line names the term.
    expect(screen.getByText(/matching/i)).toBeInTheDocument();
    expect(screen.getByText('“onboarding”')).toBeInTheDocument();
  });

  it('matches on the purpose one-liner too', async () => {
    const user = userEvent.setup();
    renderHome();
    await waitFor(() => expect(screen.getByText('Checkout flow walkthrough')).toBeInTheDocument());

    await user.type(screen.getByRole('textbox', { name: /search studies/i }), 'navigation');
    await waitFor(() => expect(screen.queryByText('Checkout flow walkthrough')).toBeNull());
    // "navigation" is only in Dashboard's purpose.
    expect(screen.getByText('Dashboard usability')).toBeInTheDocument();
  });

  it('shows a no-match empty state with a clear-both control, which restores the list', async () => {
    const user = userEvent.setup();
    renderHome();
    await waitFor(() => expect(screen.getByText('Onboarding tone')).toBeInTheDocument());

    await user.type(screen.getByRole('textbox', { name: /search studies/i }), 'zzznotathing');
    await waitFor(() => expect(screen.getByText('No studies found')).toBeInTheDocument());

    const clear = screen.getByRole('button', { name: /clear search and filters/i });
    await user.click(clear);

    await waitFor(() => expect(screen.getByText('Onboarding tone')).toBeInTheDocument());
    expect(screen.getByText('Checkout flow walkthrough')).toBeInTheDocument();
  });
});
