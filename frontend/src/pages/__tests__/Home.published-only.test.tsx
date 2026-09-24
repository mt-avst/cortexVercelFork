import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Home from '../Home';
import { getOpportunities } from '../../api/client';

/**
 * The participant Home lists only PUBLISHED studies (Decision 3).
 *
 * The list route returns every status to an admin when no status is named, so a
 * signed-in admin browsing the participant Home would otherwise see their own
 * drafts and closed studies alongside the live ones - and the "N active
 * studies" count, which follows the rendered rows, would count them. Home asks
 * the route for 'published' so admins see the same live list a participant does.
 * Pinned on the REQUEST rather than the rendered rows because that is the
 * contract the fix rests on; the route's own scoping is proven server-side.
 */
vi.mock('../../api/client', () => ({
  getOpportunities: vi.fn(async () => [])
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'A' },
    loading: false
  })
}));

const renderHome = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </MemoryRouter>
  );

describe('the participant Home', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks the studies list for published studies only, so an admin sees no drafts here', async () => {
    renderHome();

    await waitFor(() =>
      expect(vi.mocked(getOpportunities)).toHaveBeenCalledWith({ status: 'published' })
    );
    // And never for the whole, unscoped list, which is what leaks drafts.
    expect(vi.mocked(getOpportunities)).not.toHaveBeenCalledWith({});
  });

  it('does not fetch at all when the route is not the home page', async () => {
    render(
      <MemoryRouter initialEntries={['/somewhere-else']}>
        <Routes>
          <Route path="/somewhere-else" element={<Home />} />
        </Routes>
      </MemoryRouter>
    );

    // The fetch is gated on pathname === '/', so a mount elsewhere is quiet.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(vi.mocked(getOpportunities)).not.toHaveBeenCalled();
  });
});

// #169: the participant side is named for what people do there. The route
// stays /; only the visible name changed. Literals on purpose - a test that
// read the name from the same constant as the page could not see it change.
describe('the participant Home name (#169)', () => {
  it('names the page Participate in its heading and the tab title', async () => {
    renderHome();

    expect(await screen.findByRole('heading', { level: 1, name: 'Participate' })).toBeInTheDocument();
    expect(document.title).toBe('Participate · Cortex');
    expect(screen.queryByRole('heading', { level: 1, name: /Browse studies/i })).not.toBeInTheDocument();
  });
});
