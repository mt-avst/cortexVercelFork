import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

import Header from '../Header';
import { requestAdminAccess } from '../../api/client';

vi.mock('../../api/client', () => ({
  requestAdminAccess: vi.fn(),
}));

const mockRequestAdminAccess = vi.mocked(requestAdminAccess);

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
 * nested inside a `user.role !== 'superadmin'` branch: the link rendered for
 * `employee` only. Reinstating that gate fails four of the arms below by name.
 *
 * WHO THAT ACTUALLY EXCLUDED. An earlier draft of this docblock said nobody
 * held `employee` during the beta. That is false. CORTEX_BETA_ALL_ADMIN is
 * bounded to an email-domain allow-list, so external testers are never lifted,
 * keep the `employee` column default and have been seeing this link all along.
 * The population that gains it is lifted internal staff and superadmins.
 *
 * THE ROLES ARE LITERALS rather than derived from the role union, because the
 * point is that the link no longer consults the role at all - an expectation
 * derived from whatever the code checks would agree with any gate, including
 * the one this replaces. They are the three roles the union and the database
 * CHECK actually permit; an earlier draft also parametrised `participant` and
 * `user`, which are not roles in this system, so those arms covered states
 * that cannot occur.
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

  it.each(['employee', 'researcher_admin', 'superadmin'])(
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

  /**
   * THE REAL SIGNED-OUT PROPERTY, and why the obvious control is worthless.
   *
   * An earlier version asserted only that no AdaptaBits link is in the document
   * for a signed-out visitor, with a docblock claiming that would catch a change
   * rendering the link outside the `if (!user) return []` guard. MUTATION
   * REFUTED THAT: moving the `items.push` above the guard passed 29/29, and so
   * did that plus removing the JSX-level `user ?` gate on the desktop toolbar.
   * Both dropdowns call `profileMenuItems()` only inside a `user ?` branch, and
   * Dropdown renders children only once opened - so an arm that never opens a
   * menu cannot observe `profileMenuItems` under ANY mutation to it. It was a
   * true assertion that could not fail for the reason it claimed.
   *
   * The property that IS real and IS checkable: a signed-out visitor gets no
   * profile trigger at all, so there is no menu to open. That is asserted here
   * by name, alongside the absence of the link.
   */
  it('gives a signed-out visitor no profile trigger, so there is no menu to open', () => {
    const { container, queryByRole } = renderFor(null);

    expect(
      queryByRole('button', { name: 'User profile menu' })
    ).not.toBeInTheDocument();
    expect(container.querySelector('.dropdown-menu')).toBeNull();
    expect(queryByRole('link', { name: /AdaptaBits/i })).not.toBeInTheDocument();
  });

  /**
   * THE DIVIDER BUG THIS CHANGE FIRST INTRODUCED AND THEN FIXED.
   *
   * Pushing `div-after-adaptabits` unconditionally put it directly against
   * `div-before-feedback` for a superadmin, who has no `request-admin` item
   * between them - two adjacent separators in the rendered menu. Measured on
   * the first draft: superadmin showed an adjacent pair at positions 4 and 5.
   */
  it.each(['employee', 'researcher_admin', 'superadmin'])(
    'renders no doubled or leading separator in a %s menu',
    (role) => {
      const { container } = renderFor(role);
      const desktop = container.querySelector(
        '.header-actions--desktop'
      ) as HTMLElement;
      fireEvent.click(
        within(desktop).getByRole('button', { name: 'User profile menu' })
      );
      const menu = desktop.querySelector('.dropdown-menu') as HTMLElement;

      const children = Array.from(menu.children);
      const isDivider = (el: Element) => el.classList.contains('dropdown-divider');

      expect(children.findIndex(isDivider)).not.toBe(0);
      const adjacent = children.filter(
        (el, i) => i > 0 && isDivider(el) && isDivider(children[i - 1])
      );
      expect(adjacent).toHaveLength(0);
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
    // #117 follow-up: the collapsed phone menu is a disclosure now, not a
    // strict ARIA menu (Dropdown's `disclosure` prop) - its items carry no
    // `role="menuitem"` any more, so Logout (a plain DropdownItem button, no
    // `to`) reads by its implicit button role.
    expect(menu.getByRole('button', { name: /Logout/i })).toBeInTheDocument();
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

/**
 * #165: My bookings rendered for non-admins only. CORTEX_BETA_ALL_ADMIN lifts
 * every adaptavist.com account to researcher_admin, so during the beta internal
 * staff - who book sessions in each other's studies - had no route back to
 * what they had booked. Every signed-in role gets it, in the bar and the menu.
 */
describe('My bookings link (#165)', () => {
  const renderFor = (role: string | null, path = '/') => {
    auth.user = role ? { name: 'A Person', role } : null;
    window.history.pushState({}, '', path);
    return render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
  };

  const cases: Array<[string, string]> = [
    ['employee', '/'],
    ['researcher_admin', '/'],
    ['researcher_admin', '/admin'],
    ['superadmin', '/'],
    ['superadmin', '/admin'],
  ];

  it.each(cases)('a signed-in %s on %s has My bookings in the toolbar, linking to /my-bookings', (role, path) => {
    const { container } = renderFor(role, path);
    const bar = container.querySelector('.header-actions--desktop') as HTMLElement;
    const link = within(bar).getByRole('link', { name: /^My bookings$/ });
    expect(link).toHaveAttribute('href', '/my-bookings');
  });

  it.each(cases)('a signed-in %s on %s has My bookings in the collapsed menu', (role, path) => {
    const { container } = renderFor(role, path);
    fireEvent.click(within(container).getByRole('button', { name: 'Menu' }));
    const menu = container.querySelector('.header-actions--mobile .dropdown-menu') as HTMLElement;
    expect(within(menu).getByRole('link', { name: /^My bookings$/ })).toHaveAttribute('href', '/my-bookings');
  });

  it.each(cases)('every toolbar control for a signed-in %s on %s carries one 16px icon', (role, path) => {
    const { container } = renderFor(role, path);
    const bar = container.querySelector('.header-actions--desktop') as HTMLElement;
    const controls = [...bar.querySelectorAll<HTMLElement>('a.btn, button.btn')];
    expect(controls.length, 'toolbar controls found').toBeGreaterThanOrEqual(4);
    const bad = controls
      .map((el) => ({ label: el.textContent?.trim() || el.getAttribute('aria-label'), icons: [...el.querySelectorAll('svg')] }))
      .filter(({ icons }) => icons.length !== 1 || icons[0].getAttribute('width') !== '16')
      .map(({ label, icons }) => `${label}: ${icons.map((i) => i.getAttribute('width')).join(',') || 'no icon'}`);
    expect(bad).toEqual([]);
  });

  it.each(cases)('the collapsed menu gives My bookings and the destination switch an icon, for a signed-in %s on %s', (role, path) => {
    const { container } = renderFor(role, path);
    fireEvent.click(within(container).getByRole('button', { name: 'Menu' }));
    const menu = container.querySelector('.header-actions--mobile .dropdown-menu') as HTMLElement;
    const names = role === 'employee' ? [/^My bookings$/, /Submit Research Request/] : [/^My bookings$/, path === '/admin' ? /^Browse Studies$/ : /^Admin$/];
    for (const name of names) {
      expect(within(menu).getByRole('link', { name }).querySelector('svg'), `${name} icon`).not.toBeNull();
    }
  });

  it('gives a signed-out visitor no My bookings link (control)', () => {
    renderFor(null);
    expect(screen.queryByRole('link', { name: /My bookings/i })).not.toBeInTheDocument();
  });
});

/**
 * #146: both request-admin branches (success and error) armed a bare
 * setTimeout(() => setAdminRequestMessage(null), 5000) with no clearTimeout
 * anywhere. Under React 18 a setState after unmount is a silent no-op, but the
 * timer itself keeps running - if it outlives the vitest file, that file can
 * exit non-zero on `window is not defined`, the failure mode !496 fixed on
 * Admin.tsx.
 *
 * The admin-request message only renders inside the profile dropdown's own
 * item list, which Dropdown mounts only while open - it auto-closes the menu
 * the moment the "Request Admin Access" item is clicked (to open the
 * confirmation modal), so the banner has to be observed by reopening the
 * dropdown after confirming, not by watching the menu that opened it.
 */
describe('the admin-request banner timer', () => {
  beforeEach(() => {
    auth.user = { name: 'A Person', role: 'employee' };
    mockRequestAdminAccess.mockResolvedValue({
      success: true,
      request: { id: 'req-1' } as never,
      message: 'Request submitted',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const openProfileMenu = (container: HTMLElement) => {
    const desktop = container.querySelector('.header-actions--desktop') as HTMLElement;
    fireEvent.click(within(desktop).getByRole('button', { name: 'User profile menu' }));
    return desktop;
  };

  // Opens the profile menu, requests admin access and confirms - under real
  // timers, since only the confirm click itself needs to be intercepted.
  // Fake timers take over immediately before that click so
  // advanceTimersByTimeAsync can flush both the request promise and the timer.
  const armTheBanner = async (container: HTMLElement) => {
    const desktop = openProfileMenu(container);
    // The desktop profile dropdown is a disclosure too (#117 follow-up): no
    // `role="menuitem"` on its items any more, so the request-admin
    // DropdownItem (a plain button, no `to`) reads by its implicit button role.
    fireEvent.click(within(desktop).getByRole('button', { name: /Request Admin Access/i }));

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Request Admin Access' }));
    await vi.advanceTimersByTimeAsync(0);
  };

  it('hides the request-admin banner after 5000ms', async () => {
    const { container } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
    await armTheBanner(container);

    // Reopen: the message lives in profileMenuItems(), which Dropdown only
    // mounts while open, and the item click above closed it.
    let desktop = openProfileMenu(container);
    expect(within(desktop).getByText('Request submitted')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(4999);
    desktop = container.querySelector('.header-actions--desktop') as HTMLElement;
    expect(within(desktop).getByText('Request submitted')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(1);
    expect(within(desktop).queryByText('Request submitted')).not.toBeInTheDocument();
  });

  it('leaves no timer pending once Header unmounts', async () => {
    const { container, unmount } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
    await armTheBanner(container);

    // Control: the banner really is on screen, so the timer is armed and not
    // merely never-scheduled - a bare getTimerCount() alone would not say that.
    const desktop = openProfileMenu(container);
    expect(within(desktop).getByText('Request submitted')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
