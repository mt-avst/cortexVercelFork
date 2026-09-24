import React, { useState, useEffect, useRef, memo } from 'react';
import { useLocation } from 'react-router-dom';
import { GuardedLink } from '../contexts/NavigationGuardContext';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import LoadingSpinner from './LoadingSpinner';
import ConfirmationModal from './ConfirmationModal';
import { requestAdminAccess } from '../api/client';
import { Dropdown, DropdownItem, DropdownDivider, DropdownHeader } from './ui';
import CortexMark from './CortexMark';
import {
  UserCircle,
  Sun,
  Moon,
  User,
  Settings,
  Trophy,
  ShieldPlus,
  CheckCircle,
  AlertCircle,
  MessageSquare,
  LogOut,
  List,
  LayoutDashboard,
  Calendar,
  Send,
  Menu
} from 'lucide-react';

/**
 * Header Component
 * Main navigation header with auth controls and theme toggle.
 *
 * Two mutually-exclusive layouts share one <nav>, switched purely by a CSS
 * breakpoint (`header-actions--desktop` / `header-actions--mobile`, 992px), so
 * there is no matchMedia dependency and the correct layout is right on first
 * paint. Below 992px every control - theme toggle, the primary destination and
 * the profile items - collapses into one menu, because at phone width the
 * inline toolbar wrapped onto a second row that clipped the logo (audit row 14).
 * The item builders below feed both layouts so they cannot drift.
 *
 * Wrapped in React.memo for performance optimization.
 */
const Header: React.FC = memo(() => {
  const { user, loading, initialAuthCheck, logout } = useAuth();
  const { isDarkMode, toggleTheme } = useTheme();
  const location = useLocation();

  // Check if we're on an admin page
  const isOnAdminPage = location.pathname.startsWith('/admin');

  const [requestingAdmin, setRequestingAdmin] = useState(false);
  const [adminRequestMessage, setAdminRequestMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const adminRequestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The landing header is fixed and transparent over the hero; once the page
  // scrolls, content would pass under it and collide. Flag scroll so the header
  // can gain a solid background below the very top.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const isAdmin = user?.role === 'researcher_admin' || user?.role === 'superadmin';

  // Determine logo link based on user role
  const logoLink = React.useMemo(() => {
    if (isAdmin) {
      return '/admin';
    }
    return '/';
  }, [isAdmin]);

  const handleRequestAdminClick = () => {
    setShowConfirmModal(true);
  };

  const handleConfirmRequest = async () => {
    setShowConfirmModal(false);
    try {
      setRequestingAdmin(true);
      setAdminRequestMessage(null);
      const result = await requestAdminAccess();
      setAdminRequestMessage({ type: 'success', text: result.message });
      if (adminRequestTimerRef.current) clearTimeout(adminRequestTimerRef.current);
      adminRequestTimerRef.current = setTimeout(() => setAdminRequestMessage(null), 5000);
    } catch (error: unknown) {
      const axiosError = error as { response?: { data?: { error?: string } }; message?: string };
      const message = axiosError.response?.data?.error || axiosError.message || 'Failed to submit admin request';
      setAdminRequestMessage({ type: 'error', text: message });
      if (adminRequestTimerRef.current) clearTimeout(adminRequestTimerRef.current);
      adminRequestTimerRef.current = setTimeout(() => setAdminRequestMessage(null), 5000);
    } finally {
      setRequestingAdmin(false);
    }
  };

  // Clear the admin-request banner timer on unmount only.
  useEffect(() => () => {
    if (adminRequestTimerRef.current) clearTimeout(adminRequestTimerRef.current);
  }, []);

  const getRequestModalContent = () => {
    if (user?.role === 'researcher_admin') {
      return {
        title: 'Request Superadmin Access',
        message: 'You are requesting superadmin access. This will allow you to manage admin access requests and existing admins. A superadmin will review your request.',
        confirmText: 'Request Superadmin Access',
        variant: 'primary' as const
      };
    } else {
      return {
        title: 'Request Admin Access',
        message: 'You are requesting admin access. This will allow you to create and manage research studies. A superadmin will review your request.',
        confirmText: 'Request Admin Access',
        variant: 'primary' as const
      };
    }
  };

  const themeToggleLabel = isDarkMode ? 'Light Mode' : 'Dark Mode';
  const themeToggleAria = isDarkMode ? 'Switch to light mode' : 'Switch to dark mode';
  const themeIcon = isDarkMode
    ? <Sun size={18} aria-hidden="true" />
    : <Moon size={18} aria-hidden="true" />;
  // the phone menu's theme item was the one icon in the
  // list at size 18 (with the label in its own `ms-2`-margined span) beside
  // five others at size 16 (each with a plain `me-2` on the icon itself, no
  // wrapping span) - two different icon boxes meant two different text
  // start-x's down the column. A dedicated size-16 pair, built the same way
  // every other item's icon is, closes both gaps at once.
  const themeIconSm = isDarkMode
    ? <Sun size={16} aria-hidden="true" className="me-2" />
    : <Moon size={16} aria-hidden="true" className="me-2" />;

  /**
   * The primary destination(s) available to the signed-in user. `bar` renders
   * them as header buttons; `menu` renders them as dropdown items for the
   * collapsed phone menu. Returns an array (not a fragment) so the Dropdown can
   * map close-on-select over each child.
   */
  const primaryActionItems = (variant: 'bar' | 'menu'): React.ReactNode[] => {
    if (!user) return [];
    const secondary = variant === 'bar' ? 'btn btn-outline-secondary' : 'dropdown-item';
    const primary = variant === 'bar' ? 'btn btn-secondary' : 'dropdown-item';

    // Every signed-in user can book a session, admins included - they take
    // part in each other's studies - so every one of them needs a way back
    // to what they have booked. This used to render for non-admins only, and
    // CORTEX_BETA_ALL_ADMIN lifts every adaptavist.com account to admin, so
    // during the beta internal staff had no route back at all.
    const myBookings = (
      <GuardedLink key="my-bookings" to="/my-bookings" className={secondary}>
        <Calendar size={16} className="me-2" aria-hidden="true" />
        My bookings
      </GuardedLink>
    );

    if (!isAdmin) {
      return [
        <a
          key="submit-research"
          href="https://adaptavistlabs.atlassian.net/servicedesk/customer/portal/80"
          target="_blank"
          rel="noopener noreferrer"
          className={secondary}
          aria-label="Submit Research Request (opens in new tab)"
        >
          <Send size={16} className="me-2" aria-hidden="true" />
          Submit Research Request
        </a>,
        myBookings,
      ];
    }

    if (!isOnAdminPage) {
      return [
        myBookings,
        <GuardedLink key="admin" to="/admin" className={primary}>
          <LayoutDashboard size={16} className="me-2" aria-hidden="true" />
          Admin
        </GuardedLink>,
      ];
    }

    return [
      myBookings,
      <GuardedLink key="browse" to="/" className={primary}>
        {/* 16px + `me-2`, matching every other menu icon -
            this one's own 18px + `me-1` was the second cause of the phone
            menu's text-x drift (the squashed ShieldPlus icon, fixed above
            with `flex-shrink: 0`, was the first). */}
        <List size={16} className="me-2" aria-hidden="true" />
        Browse Studies
      </GuardedLink>,
    ];
  };

  /**
   * The profile menu items, shared by the desktop profile dropdown and the
   * collapsed phone menu. Returns an array so the Dropdown maps over each child.
   */
  const profileMenuItems = (): React.ReactNode[] => {
    if (!user) return [];
    const items: React.ReactNode[] = [];

    items.push(
      <DropdownHeader key="user-info">
        {/* gap-3 + me-2 is the same icon-to-text gap `.dropdown-item` uses
            (its own 12px gap plus each icon's me-2), so this line's text starts
            where every menu item's does. */}
        <div className="flex items-start gap-3">
          <User size={16} className="mt-1 me-2" aria-hidden="true" />
          <div>
            <div className="font-semibold">Hello, {user.name || 'Unknown User'}</div>
            <div className="text-muted text-sm">
              {user.role === 'superadmin' ? 'Superadmin' :
               user.role === 'researcher_admin' ? 'Admin' :
               'User'}
            </div>
          </div>
        </div>
      </DropdownHeader>,
      <DropdownDivider key="div-after-info" />
    );

    if (isAdmin) {
      items.push(
        <GuardedLink key="settings" to="/admin/settings" className="dropdown-item">
          <Settings size={16} className="me-2" aria-hidden="true" />
          Settings
        </GuardedLink>
      );
    }

    // ADAPTABITS IS OPEN TO EVERY SIGNED-IN USER, deliberately.
    //
    // This link used to be gated on `user.role === 'employee'`, nested inside
    // the `!== 'superadmin'` branch besides, so superadmins never saw it.
    //
    // WHO ACTUALLY GAINED IT, measured rather than assumed. An earlier version
    // of this comment claimed nobody held `employee` during the beta, so the
    // entry rendered for nobody. That is wrong, and wrong in the direction that
    // matters. CORTEX_BETA_ALL_ADMIN is BOUNDED to an email-domain allow-list
    // (`DEFAULT_ALLOWED_DOMAINS = ['adaptavist.com']` in config/betaAllAdmin.ts),
    // and a new user takes the `employee` column default at signup. Run against
    // the real resolver with the switch on:
    //   someone@adaptavist.com     -> researcher_admin
    //   tester@externalcompany.com -> employee
    //   tester@gmail.com           -> employee
    // So external testers were never lifted, still hold `employee`, and have
    // been seeing this link throughout the beta. What this change adds is the
    // link for LIFTED INTERNAL STAFF and for superadmins - not for participants.
    //
    // The gate was only ever on the LINK. `/gamification` carries no role guard
    // in App.tsx, and every backend route in routes/gamification.ts is either
    // unauthenticated (the two leaderboards) or `requireAuth` scoped to the
    // caller's own id - no route has ever asked for `employee`. So the feature
    // already worked for anyone signed in; the menu simply refused to mention
    // it. Opening the link changes who can FIND the page, not who can reach it.
    //
    // Nick's call, during the live beta. Independent of the beta switch and it
    // must stay that way - the switch is on deliberately and is not to be
    // touched. Because this no longer reads the role at all, the link also
    // stays open when the switch goes off at go-live.
    items.push(
      <GuardedLink key="gamification" to="/gamification" className="dropdown-item">
        <Trophy size={16} className="me-2" aria-hidden="true" />
        AdaptaBits
      </GuardedLink>
    );

    if (user.role !== 'superadmin') {
      // THE DIVIDER BELONGS TO THE ITEM THAT FOLLOWS IT, not to AdaptaBits.
      // Pushed unconditionally it lands against `div-before-feedback` for a
      // superadmin, who has no `request-admin` item between them - measured as
      // two adjacent separators in the rendered menu.
      items.push(<DropdownDivider key="div-after-adaptabits" />);

      items.push(
        <DropdownItem
          key="request-admin"
          onClick={handleRequestAdminClick}
          disabled={requestingAdmin}
        >
          <ShieldPlus size={16} className="me-2" aria-hidden="true" />
          {requestingAdmin
            ? 'Submitting...'
            : user.role === 'researcher_admin'
              ? 'Request Superadmin Access'
              : 'Request Admin Access'
          }
        </DropdownItem>
      );

      if (adminRequestMessage) {
        items.push(
          <div key="admin-request-message" className={`px-4 py-2 text-sm ${adminRequestMessage.type === 'success' ? 'text-success' : 'text-danger'}`}>
            {adminRequestMessage.type === 'success' ? <CheckCircle size={16} className="me-2" aria-hidden="true" /> : <AlertCircle size={16} className="me-2" aria-hidden="true" />}
            {adminRequestMessage.text}
          </div>
        );
      }
    }

    items.push(
      <DropdownDivider key="div-before-feedback" />,
      <GuardedLink key="feedback" to="/feedback" className="dropdown-item">
        <MessageSquare size={16} className="me-2" aria-hidden="true" />
        Send Feedback
      </GuardedLink>,
      <DropdownDivider key="div-before-logout" />,
      <DropdownItem
        key="logout"
        onClick={(e) => {
          e.preventDefault();
          logout();
        }}
        aria-label="Logout"
      >
        <LogOut size={16} className="me-2" aria-hidden="true" />
        Logout
      </DropdownItem>
    );

    return items;
  };

  const renderProfileTrigger = () => (
    <button
      className="btn btn-outline-secondary"
      type="button"
      aria-label="User profile menu"
    >
      <UserCircle size={16} className="me-2" aria-hidden="true" />
      Your Profile
    </button>
  );

  const renderMenuTrigger = () => (
    <button
      className="btn btn-outline-secondary header-menu-trigger"
      type="button"
      aria-label="Menu"
    >
      <Menu size={20} aria-hidden="true" />
    </button>
  );

  return (
    <header className={scrolled ? 'header header--scrolled' : 'header'}>
      <div className="container">
        <div className="header-content">
          <GuardedLink to={logoLink} className="logo" aria-label="Cortex home">
            <CortexMark className="logo-mark" />
            {/* The wordmark is the brand's home, shown once. On the signed-out
                landing the hero (.landing-product-name) already carries "Cortex",
                so a header wordmark there would state the brand twice - drop it
                once signed-out is confirmed (!user && initialAuthCheck), keeping
                only the mark. Through the pre-resolution cold-load window it
                stays, matching the signed-in majority, so there is no first-paint
                flicker - the same CB-26 reasoning as the theme toggle below. */}
            {(user || !initialAuthCheck) && <span className="logo-word">Cortex</span>}
          </GuardedLink>

          <nav className="nav" aria-label="Main navigation">
            {/* Desktop toolbar - hidden below 992px */}
            <div className="header-actions header-actions--desktop">
              {!user && initialAuthCheck ? (
                /* CB-26: on the signed-out header this is the ONLY control (every
                   other header item is gated behind `user`), so the outlined
                   button + text label read as the page's loudest CTA. Demoted to
                   a quiet icon-only control here, scoped on confirmed-signed-out
                   (`!user && initialAuthCheck`) rather than `!user` alone: on a
                   cold load `user` starts null before `initialAuthCheck` flips
                   true, so gating on `!user` alone showed the quiet toggle to a
                   user who was about to resolve as signed-in, then popped to the
                   wider outlined button once `/api/me` returned - a layout shift
                   on every cold load. Gating on the resolved signal instead means
                   a signed-in user (the beta majority, since the all-admin switch
                   lifts every signed-in employee) sees the stable outlined button
                   from first paint; only a genuinely signed-out visitor gets the
                   one transition, once auth resolves. Header renders globally
                   (App.tsx mounts it once, outside the route switch), so a
                   signed-out visitor can land on any public route, not only
                   Landing, and the demotion should follow auth state everywhere
                   it applies. Signed-in appearance below is untouched. */
                <button
                  onClick={toggleTheme}
                  className="header-theme-toggle--quiet"
                  aria-label={themeToggleAria}
                  title={themeToggleAria}
                >
                  {themeIcon}
                </button>
              ) : (
                <button
                  onClick={toggleTheme}
                  className="btn btn-outline-secondary"
                  aria-label={themeToggleAria}
                  title={themeToggleAria}
                >
                  {/* 16px + me-2, the same icon box as every other bar button. */}
                  {themeIconSm}
                  <span className="d-none d-md-inline">{themeToggleLabel}</span>
                </button>
              )}

              {loading && initialAuthCheck ? (
                <LoadingSpinner size="small" text="Loading..." />
              ) : user ? (
                <>
                  {primaryActionItems('bar')}

                  <div className="nav-items">
                    <Dropdown
                      trigger={renderProfileTrigger()}
                      align="end"
                      disclosure
                    >
                      {profileMenuItems()}
                    </Dropdown>
                  </div>
                </>
              ) : null}
            </div>

            {/* Collapsed menu - hidden at/above 992px */}
            <div className="header-actions--mobile">
              {loading && initialAuthCheck ? (
                <LoadingSpinner size="small" text="Loading..." />
              ) : user ? (
                <Dropdown
                  trigger={renderMenuTrigger()}
                  align="end"
                  disclosure
                >
                  <DropdownItem
                    key="theme"
                    onClick={toggleTheme}
                    aria-label={themeToggleAria}
                  >
                    {themeIconSm}
                    {themeToggleLabel}
                  </DropdownItem>
                  <DropdownDivider key="div-after-theme" />
                  {primaryActionItems('menu')}
                  <DropdownDivider key="div-after-primary" />
                  {profileMenuItems()}
                </Dropdown>
              ) : (
                // CB-26: this branch already implies `!user` (the `user ?` check
                // above caught the signed-in case), so the only extra gate needed
                // is `initialAuthCheck` - same confirmed-signed-out condition as
                // the desktop toggle above, for the same cold-load layout-shift
                // reason: before it resolves, defaulting to the outlined style
                // matches what a signed-in visitor (the beta majority) already
                // sees on desktop, instead of popping between two icon styles.
                <button
                  onClick={toggleTheme}
                  className={initialAuthCheck ? 'header-theme-toggle--quiet' : 'btn btn-outline-secondary'}
                  aria-label={themeToggleAria}
                  title={themeToggleAria}
                >
                  {themeIcon}
                </button>
              )}
            </div>
          </nav>
        </div>
      </div>

      {/* Admin Request Confirmation Modal */}
      {user && user.role !== 'superadmin' && (
        <ConfirmationModal
          show={showConfirmModal}
          title={getRequestModalContent().title}
          message={getRequestModalContent().message}
          confirmText={getRequestModalContent().confirmText}
          cancelText="Cancel"
          variant={getRequestModalContent().variant}
          onConfirm={handleConfirmRequest}
          onCancel={() => setShowConfirmModal(false)}
        />
      )}
    </header>
  );
});

Header.displayName = 'Header';

export default Header;
