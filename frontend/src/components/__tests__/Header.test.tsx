import React from 'react';
import { render } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { beforeEach, vi } from 'vitest';

import Header from '../Header';

// Header requires the auth and theme contexts. The default is a signed-out
// visitor; a test that needs one signed in assigns `auth.user` before render.
const auth = vi.hoisted(() => ({
  user: null as { name: string; role: string } | null,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    loading: false,
    initialAuthCheck: false,
    logout: vi.fn(),
  }),
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({
    isDarkMode: false,
    toggleTheme: vi.fn(),
  }),
}));

beforeEach(() => {
  auth.user = null;
});

// Simple Header component tests
describe('Header Component', () => {
  it('should render without crashing', () => {
    const { container } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
    expect(container.firstChild).toBeInTheDocument();
  });

  it('should render logo', () => {
    const { getByAltText } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
    expect(getByAltText('Cortex Logo')).toBeInTheDocument();
  });

  it('should render the theme toggle for signed-out visitors', () => {
    const { getByText } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );

    // Signed-out users get no nav actions - login lives on the landing page.
    // The theme toggle is the one control present regardless of auth state.
    expect(getByText('Dark Mode')).toBeInTheDocument();
  });

  it('should have proper structure', () => {
    const { container } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
    
    const header = container.querySelector('header');
    expect(header).toBeInTheDocument();
    expect(header).toHaveClass('header');
  });
});

/**
 * Submit Research Request, the only way a non-admin asks for research.
 *
 * Untested until #46, which deleted the in-app alternative: `ResearchRequestForm`
 * rendered `<OpportunityForm allowUserSubmission />` but nothing imported it and
 * `/submit-research-request` served the Under Development placeholder. Deleting
 * that made this anchor the whole answer, and the landing FAQ now names it, so
 * it needs a test that fails by name if it is removed or repointed inward.
 */
describe('Submit Research Request', () => {
  const renderFor = (role: string) => {
    auth.user = { name: 'A Person', role };
    return render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
  };

  it('sends a non-admin out to the service desk portal in a new tab', () => {
    const { getByRole } = renderFor('employee');

    const link = getByRole('link', { name: /Submit Research Request/i });

    expect(link).toHaveAttribute(
      'href',
      'https://adaptavistlabs.atlassian.net/servicedesk/customer/portal/80'
    );
    expect(link).toHaveAttribute('target', '_blank');
    // Without noopener the portal gets a handle on this window.
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it.each(['researcher_admin', 'superadmin'])(
    'does not offer it to a %s, who authors the study directly',
    (role) => {
      const { queryByRole } = renderFor(role);

      expect(
        queryByRole('link', { name: /Submit Research Request/i })
      ).not.toBeInTheDocument();
    }
  );
});
