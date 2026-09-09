import React from 'react';
import { render, fireEvent, within } from '@testing-library/react';
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

/**
 * The collapsing phone menu (audit row 14). Below 768px the inline toolbar is
 * hidden by CSS and a single menu button carries everything - theme toggle,
 * the primary destination and the profile items - so the header stops wrapping
 * over the logo. jsdom applies no CSS, so both layouts are in the DOM here; the
 * menu's own Dropdown renders its items only once opened, which is what these
 * tests exercise. Queries are scoped to the mobile branch so the desktop copy
 * of a shared control never masks a regression in the collapsed menu.
 */
describe('Collapsing phone menu', () => {
  const renderFor = (role: string | null, path = '/') => {
    auth.user = role ? { name: 'A Person', role } : null;
    window.history.pushState({}, '', path);
    return render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
  };

  const openMenu = (container: HTMLElement) => {
    const trigger = within(container).getByRole('button', { name: 'Menu' });
    fireEvent.click(trigger);
    const menu = container.querySelector(
      '.header-actions--mobile .dropdown-menu'
    ) as HTMLElement;
    expect(menu).toBeTruthy();
    return within(menu);
  };

  it('gives a signed-in user one menu button, not the inline toolbar controls', () => {
    const { container } = renderFor('employee');
    const mobile = container.querySelector('.header-actions--mobile') as HTMLElement;
    expect(within(mobile).getByRole('button', { name: 'Menu' })).toBeInTheDocument();
    // The theme toggle is not a loose control in the mobile branch until the
    // menu is opened - it collapses inside.
    expect(within(mobile).queryByText('Dark Mode')).not.toBeInTheDocument();
  });

  it('collapses the theme toggle, feedback and logout into the opened menu', () => {
    const { container } = renderFor('employee');
    const menu = openMenu(container);

    expect(menu.getByText('Dark Mode')).toBeInTheDocument();
    expect(menu.getByRole('link', { name: /Send Feedback/i })).toBeInTheDocument();
    // Logout is a Dropdown menuitem, not a bare button.
    expect(menu.getByRole('menuitem', { name: /Logout/i })).toBeInTheDocument();
  });

  it("carries a non-admin's primary destinations inside the menu", () => {
    const { container } = renderFor('employee');
    const menu = openMenu(container);

    expect(
      menu.getByRole('link', { name: /Submit Research Request/i })
    ).toBeInTheDocument();
    expect(menu.getByRole('link', { name: /My bookings/i })).toBeInTheDocument();
  });

  it('carries an admin to the dashboard from inside the menu', () => {
    const { container } = renderFor('researcher_admin', '/');
    const menu = openMenu(container);

    expect(menu.getByRole('link', { name: /^Admin$/ })).toBeInTheDocument();
    expect(menu.getByRole('link', { name: /Settings/i })).toBeInTheDocument();
  });

  it('offers an admin Browse Studies from inside the menu while on an admin page', () => {
    const { container } = renderFor('researcher_admin', '/admin');
    const menu = openMenu(container);

    expect(menu.getByRole('link', { name: /Browse Studies/i })).toBeInTheDocument();
  });

  it('gives a signed-out visitor only the theme toggle, no menu button', () => {
    const { container } = renderFor(null);
    const mobile = container.querySelector('.header-actions--mobile') as HTMLElement;

    expect(within(mobile).queryByRole('button', { name: 'Menu' })).not.toBeInTheDocument();
    expect(
      within(mobile).getByRole('button', { name: /Switch to (dark|light) mode/i })
    ).toBeInTheDocument();
  });
});
