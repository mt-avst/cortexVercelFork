import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import Header from '../../components/Header';
import { NavigationGuardProvider } from '../../contexts/NavigationGuardContext';
import { chooseStudyType } from './helpers/study-type-picker';

/**
 * WZ-13: a dirty OpportunityForm intercepts the GLOBAL Header's links.
 *
 * The form's own exit controls already confirm before discarding work; this
 * file defends the seam that was open - the Header lives in a different subtree
 * and navigates through react-router directly, so before WZ-13 a dirty author
 * who clicked a header link lost everything with no warning. The two are wired
 * together only by the shared `NavigationGuardProvider`, so this test renders
 * the real Header and the real form under one provider and clicks a real header
 * link, rather than spying on the registry - the seam is exactly the part a spy
 * would not exercise.
 */

const logout = vi.fn();
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false,
    initialAuthCheck: true,
    logout,
  }),
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', isDarkMode: false, toggleTheme: vi.fn() }),
}));

vi.mock('../../components/AdminSessionManager', () => ({ default: () => null }));

vi.mock('../../api/client', () => ({
  // D13, W9: StudyTypePicker mounts DescribeIt on the new-study route, and it
  // checks this on every mount - unmocked, this call resolves to `undefined`
  // and throws inside a component effect. False keeps the AI panel hidden,
  // which is the correct default for a suite that is not about AI drafting.
  getAiDraftingAvailable: vi.fn().mockResolvedValue(false),
  draftOpportunityFromBrief: vi.fn(),
  createOpportunity: vi.fn(),
  updateOpportunity: vi.fn(),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([]),
  requestAdminAccess: vi.fn(),
}));

vi.mock('../../api/firsthand-studies', async (importActual) => ({
  ...(await importActual<typeof import('../../api/firsthand-studies')>()),
  getFirstHandStudy: vi.fn().mockRejectedValue(new Error('not stubbed')),
}));

const LocationProbe: React.FC = () => (
  <span data-testid="location">{useLocation().pathname}</span>
);

/**
 * Header and form under ONE provider, the way `AppChromeLayout` mounts them.
 * On an admin page the Header renders a "Browse Studies" link to '/', which is
 * the header navigation this test drives.
 */
const renderWithHeader = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/new']}>
      <NavigationGuardProvider>
        <Header />
        <LocationProbe />
        <Routes>
          <Route path="/admin/opportunities/new" element={<OpportunityForm />} />
          <Route path="/" element={<div>Browse studies page</div>} />
          <Route path="/admin" element={<div>Admin page</div>} />
        </Routes>
      </NavigationGuardProvider>
    </MemoryRouter>
  );

const headerBrowseLink = () =>
  screen.getAllByRole('link', { name: /Browse Studies/i })[0];

// Title lives on the Basic Info step now, split out of the Study type step
// (D1/D3 reshape), so making the form dirty means choosing a type and walking
// to it first.
const typeTitle = (value: string) => {
  chooseStudyType('poll');
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Form steps' })).getAllByRole(
      'button'
    )[1]
  );
  fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value } });
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the Header links respect the form guard (WZ-13)', () => {
  it('confirms before leaving, and does not navigate, when the form is dirty', async () => {
    renderWithHeader();

    typeTitle('Half a study I do not want to lose');

    fireEvent.click(headerBrowseLink());

    // The form's own confirmation opened, and the router did not move.
    expect(await screen.findByText(/Leave without saving\?/i)).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/admin/opportunities/new'
    );
    expect(screen.queryByText('Browse studies page')).not.toBeInTheDocument();
  });

  it('lets a header link navigate with no confirmation when the form is clean', () => {
    renderWithHeader();

    // Untouched new form: nothing to lose, so the link behaves like any other.
    fireEvent.click(headerBrowseLink());

    expect(screen.getByText('Browse studies page')).toBeInTheDocument();
    expect(screen.queryByText(/Leave without saving\?/i)).not.toBeInTheDocument();
  });

  it('clears the guard when the form unmounts, so header links on the next page are free', async () => {
    // The real topology and the real failure this pins: the provider lives
    // above the route Outlet and PERSISTS while the form unmounts. Leaving via
    // the header and discarding unmounts the form under the SAME provider - so
    // if the form's cleanup did not run `registerGuard(null)`, its stale guard
    // would keep intercepting header clicks on the page the author landed on.
    renderWithHeader();
    typeTitle('Some work in progress');

    // Leave the dirty form through the header and confirm the discard, which
    // navigates away and unmounts the form (provider and Header stay mounted).
    fireEvent.click(headerBrowseLink());
    fireEvent.click(await screen.findByRole('button', { name: /Discard and leave/i }));
    await screen.findByText('Browse studies page');

    // On the next page a header link must navigate freely - the unmounted
    // form's guard is gone. Delete the cleanup and this click is intercepted by
    // the stale guard instead, so the destination never renders.
    fireEvent.click(screen.getByRole('link', { name: /^Admin$/i }));
    await waitFor(() => expect(screen.getByText('Admin page')).toBeInTheDocument());
    expect(screen.queryByText(/Leave without saving\?/i)).not.toBeInTheDocument();
  });
});
