import React, { useState, useEffect, memo } from 'react';
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
  Menu
} from 'lucide-react';

/**
 * Header Component
 * Main navigation header with auth controls and theme toggle.
 *
 * Two mutually-exclusive layouts share one <nav>, switched purely by a CSS
 * breakpoint (`header-actions--desktop` / `header-actions--mobile`, 768px), so
 * there is no matchMedia dependency and the correct layout is right on first
 * paint. Below 768px every control - theme toggle, the primary destination and
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
      setTimeout(() => setAdminRequestMessage(null), 5000);
    } catch (error: unknown) {
      const axiosError = error as { response?: { data?: { error?: string } }; message?: string };
      const message = axiosError.response?.data?.error || axiosError.message || 'Failed to submit admin request';
      setAdminRequestMessage({ type: 'error', text: message });
      setTimeout(() => setAdminRequestMessage(null), 5000);
    } finally {
      setRequestingAdmin(false);
    }
  };

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
          Submit Research Request
        </a>,
        <GuardedLink key="my-bookings" to="/my-bookings" className={secondary}>
          My bookings
        </GuardedLink>,
      ];
    }

    if (!isOnAdminPage) {
      return [
        <GuardedLink key="admin" to="/admin" className={primary}>
          Admin
        </GuardedLink>,
      ];
    }

    return [
      <GuardedLink key="browse" to="/" className={primary}>
        <List size={18} className="me-1" aria-hidden="true" />
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
        <div className="flex items-start gap-2">
          <User size={16} className="mt-1" aria-hidden="true" />
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

    if (user.role !== 'superadmin') {
      if (user.role === 'employee') {
        items.push(
          <GuardedLink key="gamification" to="/gamification" className="dropdown-item">
            <Trophy size={16} className="me-2" aria-hidden="true" />
            AdaptaBits
          </GuardedLink>,
          <DropdownDivider key="div-after-adaptabits" />
        );
      }

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
      <UserCircle size={18} className="me-1" aria-hidden="true" />
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
                landing the hero already carries "Cortex", so a header wordmark
                there would state the brand twice - drop it once signed-out is
                confirmed (!user && initialAuthCheck), keeping only the mark.
                Through the pre-resolution cold-load window it stays, matching
                the signed-in majority, so there is no first-paint flicker -
                the same CB-26 reasoning as the theme toggle below. */}
            {(user || !initialAuthCheck) && <span className="logo-word">Cortex</span>}
          </GuardedLink>

          <nav className="nav" aria-label="Main navigation">
            {/* Desktop toolbar - hidden below 768px */}
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
                  {themeIcon}
                  <span className="d-none d-md-inline ms-1">{themeToggleLabel}</span>
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
                    >
                      {profileMenuItems()}
                    </Dropdown>
                  </div>
                </>
              ) : null}
            </div>

            {/* Collapsed phone menu - hidden at/above 768px */}
            <div className="header-actions--mobile">
              {loading && initialAuthCheck ? (
                <LoadingSpinner size="small" text="Loading..." />
              ) : user ? (
                <Dropdown
                  trigger={renderMenuTrigger()}
                  align="end"
                >
                  <DropdownItem
                    key="theme"
                    onClick={toggleTheme}
                    aria-label={themeToggleAria}
                  >
                    {themeIcon}
                    <span className="ms-2">{themeToggleLabel}</span>
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
