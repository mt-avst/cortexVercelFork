import React from 'react';
import { render, fireEvent, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { beforeEach, vi } from 'vitest';

import Header from '../Header';

// Header requires the auth and theme contexts. The default is a *resolved*
// signed-out visitor (user null, initialAuthCheck true) - most existing tests
// query by role/accessible name and don't care about the resolved flag, but
// defaulting it true keeps the default state realistic rather than matching
// the transient cold-load window. A test that needs one signed in assigns
// `auth.user` before render; a test that needs the pre-resolution window sets
// `auth.initialAuthCheck = false` explicitly.
const auth = vi.hoisted(() => ({
  user: null as { name: string; role: string } | null,
  initialAuthCheck: true,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    loading: false,
    initialAuthCheck: auth.initialAuthCheck,
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
  auth.initialAuthCheck = true;
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

  it('renders the mark + home link but drops the wordmark once signed-out is confirmed', () => {
    // Resolved signed-out is the default (user null, initialAuthCheck true). The
    // signed-out landing hero (.landing-product-name) carries "Cortex", so the
    // header states the brand once here: the mark inside the home link, no wordmark.
    const { getByRole, queryByText } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
    expect(getByRole('link', { name: 'Cortex home' })).toBeInTheDocument();
    expect(queryByText('Cortex')).not.toBeInTheDocument();
  });

  it('shows the Cortex wordmark when signed in', () => {
    // Signed in there is no landing hero, so the header is the brand's home: the
    // mark + Fraunces "Cortex" wordmark lockup renders inside the home link.
    auth.user = { name: 'A Person', role: 'employee' };
    const { getByRole, getByText } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
    expect(getByRole('link', { name: 'Cortex home' })).toBeInTheDocument();
    expect(getByText('Cortex')).toBeInTheDocument();
  });

  it('keeps the wordmark through the pre-resolution cold-load window', () => {
    // Before auth resolves (user null, initialAuthCheck false) the wordmark stays,
    // matching the signed-in majority, so there is no first-paint flicker (CB-26).
    auth.initialAuthCheck = false;
    const { getByText } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
    expect(getByText('Cortex')).toBeInTheDocument();
  });

  it('should render the theme toggle for signed-out visitors', () => {
    const { getAllByRole } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );

    // Signed-out users get no nav actions - login lives on the landing page.
    // The theme toggle is the one control present regardless of auth state.
    expect(
      getAllByRole('button', { name: 'Switch to dark mode' }).length
    ).toBeGreaterThan(0);
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
 * CB-26: on the signed-out header the theme toggle is the ONLY control (every
 * other header item is gated behind `user`), so a full outlined button with a
 * text label read as the page's loudest control. Once signed-out is
 * *confirmed* (`!user && initialAuthCheck`), it demotes to a quiet icon-only
 * control - no outlined-button chrome, no visible text label - while keeping
 * a descriptive `aria-label`. Signed in, and during the pre-resolution cold-
 * load window, the toggle keeps the outlined appearance unchanged.
 *
 * Desktop assertions are scoped to `.header-actions--desktop` and mobile ones
 * to `.header-actions--mobile`: jsdom applies no CSS, so both layouts are
 * always in the DOM and an unscoped query would be ambiguous between them.
 */
describe('Signed-out theme toggle demotion (CB-26)', () => {
  const renderToggle = (
    scope: '.header-actions--desktop' | '.header-actions--mobile',
    role: string | null,
    resolved = true
  ) => {
    auth.user = role ? { name: 'A Person', role } : null;
    auth.initialAuthCheck = resolved;
    const { container } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
    const scoped = container.querySelector(scope) as HTMLElement;
    return within(scoped).getByRole('button', { name: 'Switch to dark mode' });
  };
  const renderDesktopToggle = (role: string | null, resolved = true) =>
    renderToggle('.header-actions--desktop', role, resolved);
  const renderMobileToggle = (role: string | null, resolved = true) =>
    renderToggle('.header-actions--mobile', role, resolved);

  it('renders icon-only, with no visible text label, once signed-out is confirmed', () => {
    // Resolved signed-out state: user null AND initialAuthCheck true.
    const toggle = renderDesktopToggle(null, true);

    expect(toggle).not.toHaveTextContent('Dark Mode');
    expect(toggle).not.toHaveTextContent('Light Mode');
    // Still keyboard-accessible with a clear accessible name.
    expect(toggle).toHaveAccessibleName('Switch to dark mode');
    // Dropped the outlined-button chrome - it must not read as the page's CTA.
    expect(toggle).not.toHaveClass('btn-outline-secondary');
  });

  it('keeps the labelled outlined toggle unchanged when signed in (control)', () => {
    const toggle = renderDesktopToggle('employee', true);

    expect(toggle).toHaveTextContent('Dark Mode');
    expect(toggle).toHaveAccessibleName('Switch to dark mode');
    expect(toggle).toHaveClass('btn-outline-secondary');
  });

  it('keeps the outlined toggle during the pre-resolution cold-load window, to avoid a layout shift', () => {
    // Cold load: user hasn't resolved yet (null) and initialAuthCheck hasn't
    // flipped true. A visitor who is about to resolve as signed-in (the beta
    // majority, since the all-admin switch lifts every signed-in employee)
    // must not see the narrower quiet icon first and then have it widen.
    const toggle = renderDesktopToggle(null, false);

    expect(toggle).toHaveClass('btn-outline-secondary');
    expect(toggle).toHaveTextContent('Dark Mode');
  });

  it('renders the mobile signed-out toggle as quiet, not outlined, once signed-out is confirmed', () => {
    const toggle = renderMobileToggle(null, true);

    expect(toggle).toHaveClass('header-theme-toggle--quiet');
    expect(toggle).not.toHaveClass('btn-outline-secondary');
    expect(toggle).toHaveAccessibleName('Switch to dark mode');
  });

  it('keeps the mobile toggle outlined during the pre-resolution cold-load window', () => {
    const toggle = renderMobileToggle(null, false);

    expect(toggle).toHaveClass('btn-outline-secondary');
    expect(toggle).not.toHaveClass('header-theme-toggle--quiet');
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
 * ADAPTABITS IS OFFERED TO EVERY SIGNED-IN USER.
 *
 * MEASURED BEFORE THE CHANGE, with the old `user.role === 'employee'` gate
 * nested inside a `user.role !== 'superadmin'` branch - the link rendered for
 * exactly ONE of these five roles, `employee`, and for nobody at all in
 * practice: CORTEX_BETA_ALL_ADMIN lifts every signed-in adaptavist.com
 * employee to `researcher_admin`, so during the beta no session holds
 * `employee` and the entry was unreachable through the UI.
 *
 * THE ROLES ARE WRITTEN OUT AS LITERALS rather than derived from a role union,
 * because the point of this arm is that the link no longer consults the role at
 * all. An expectation derived from whatever the code checks would agree with
 * any gate, including the one this replaces.
 *
 * The signed-out arm is the control. Without it, a change that rendered the
 * link unconditionally - outside the `if (!user) return []` guard - would
 * satisfy every other arm here perfectly.
 */
describe('AdaptaBits link', () => {
  const renderFor = (role: string | null) => {
    auth.user = role === null ? null : { name: 'A Person', role };
    return render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
  };

  /**
   * `profileMenuItems` feeds BOTH the desktop profile dropdown and the
   * collapsed phone menu, and a Dropdown renders its items only once opened.
   * Both surfaces are checked, and each query is scoped to its own branch, so
   * the desktop copy cannot mask a regression in the phone menu or the reverse.
   */
  const openProfile = (container: HTMLElement) => {
    const desktop = container.querySelector(
      '.header-actions--desktop'
    ) as HTMLElement;
    fireEvent.click(
      within(desktop).getByRole('button', { name: 'User profile menu' })
    );
    const menu = desktop.querySelector('.dropdown-menu') as HTMLElement;
    expect(menu).toBeTruthy();
    return within(menu);
  };

  const openPhoneMenu = (container: HTMLElement) => {
    const mobile = container.querySelector(
      '.header-actions--mobile'
    ) as HTMLElement;
    fireEvent.click(within(mobile).getByRole('button', { name: 'Menu' }));
    const menu = mobile.querySelector('.dropdown-menu') as HTMLElement;
    expect(menu).toBeTruthy();
    return within(menu);
  };

  it.each(['employee', 'researcher_admin', 'superadmin', 'participant', 'user'])(
    'offers AdaptaBits to a %s',
    (role) => {
      const { container } = renderFor(role);

      const link = openProfile(container).getByRole('link', {
        name: /AdaptaBits/i
      });
      expect(link).toHaveAttribute('href', '/gamification');
    }
  );

  it.each(['employee', 'researcher_admin', 'superadmin'])(
    'carries AdaptaBits into the collapsed phone menu for a %s',
    (role) => {
      const { container } = renderFor(role);

      expect(
        openPhoneMenu(container).getByRole('link', { name: /AdaptaBits/i })
      ).toHaveAttribute('href', '/gamification');
    }
  );

  it('offers nothing to a signed-out visitor, who has no profile menu at all', () => {
    const { queryByRole } = renderFor(null);

    expect(queryByRole('link', { name: /AdaptaBits/i })).not.toBeInTheDocument();
  });
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
