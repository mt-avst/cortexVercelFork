import React, { useState, memo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import LoadingSpinner from './LoadingSpinner';
import ConfirmationModal from './ConfirmationModal';
import { requestAdminAccess } from '../api/client';
import { Dropdown, DropdownItem, DropdownDivider, DropdownHeader } from './ui';
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
  List 
} from 'lucide-react';

/**
 * Header Component
 * Main navigation header with auth controls and theme toggle.
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

  // Determine logo link based on user role
  const logoLink = React.useMemo(() => {
    if (user?.role === 'researcher_admin' || user?.role === 'superadmin') {
      return '/admin';
    }
    return '/';
  }, [user?.role]);

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

  const renderDropdownTrigger = () => (
    <button 
      className="btn btn-outline-secondary" 
      type="button"
      aria-label="User profile menu"
    >
      <UserCircle size={18} className="me-1" aria-hidden="true" />
      Your Profile
    </button>
  );

  return (
    <header className="header">
      <div className="container">
        <div className="header-content">
          <Link to={logoLink} className="logo" aria-label="Cortex home">
            <img 
              src="/images/adaptalogo.png" 
              alt="Cortex Logo" 
              className="logo-image"
            />
          </Link>
          
          <nav className="nav" aria-label="Main navigation">
            {/* Theme Toggle Button */}
            <button
              onClick={toggleTheme}
              className="btn btn-outline-secondary"
              aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDarkMode ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
              <span className="d-none d-md-inline ms-1">
                {isDarkMode ? 'Light Mode' : 'Dark Mode'}
              </span>
            </button>

            {loading && initialAuthCheck ? (
              <LoadingSpinner size="small" text="Loading..." />
            ) : user ? (
              <>
                {user.role !== 'researcher_admin' && user.role !== 'superadmin' && (
                  <>
                    <a 
                      href="https://adaptavistlabs.atlassian.net/servicedesk/customer/portal/80"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-outline-secondary"
                      aria-label="Submit Research Request (opens in new tab)"
                    >
                      Submit Research Request
                    </a>
                    <Link 
                      to="/my-bookings" 
                      className="btn btn-outline-secondary"
                    >
                      My bookings
                    </Link>
                  </>
                )}
                {(user.role === 'researcher_admin' || user.role === 'superadmin') && !isOnAdminPage && (
                  <Link to="/admin" className="btn btn-secondary">
                    Admin
                  </Link>
                )}
                {(user.role === 'researcher_admin' || user.role === 'superadmin') && isOnAdminPage && (
                  <Link to="/" className="btn btn-secondary">
                    <List size={18} className="me-1" aria-hidden="true" />
                    Browse Studies
                  </Link>
                )}
                
                <div className="nav-items">
                  <Dropdown 
                    trigger={renderDropdownTrigger()}
                    align="end"
                  >
                    {/* User Info Header */}
                    <DropdownHeader>
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
                    </DropdownHeader>
                    
                    <DropdownDivider />
                    
                    {/* Settings link for admins */}
                    {(user.role === 'researcher_admin' || user.role === 'superadmin') && (
                      <Link to="/admin/settings" className="dropdown-item">
                        <Settings size={16} className="me-2" aria-hidden="true" />
                        Settings
                      </Link>
                    )}
                    
                    {/* Non-superadmin options */}
                    {user.role !== 'superadmin' && (
                      <>
                        {user.role === 'employee' && (
                          <>
                            <Link to="/gamification" className="dropdown-item">
                              <Trophy size={16} className="me-2" aria-hidden="true" />
                              AdaptaBits
                            </Link>
                            <DropdownDivider />
                          </>
                        )}
                        
                        <DropdownItem
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
                        
                        {adminRequestMessage && (
                          <div className={`px-4 py-2 text-sm ${adminRequestMessage.type === 'success' ? 'text-success' : 'text-danger'}`}>
                            {adminRequestMessage.type === 'success' ? <CheckCircle size={16} className="me-2" aria-hidden="true" /> : <AlertCircle size={16} className="me-2" aria-hidden="true" />}
                            {adminRequestMessage.text}
                          </div>
                        )}
                      </>
                    )}
                    
                    <DropdownDivider />
                    
                    {/* Feedback link */}
                    <Link to="/feedback" className="dropdown-item">
                      <MessageSquare size={16} className="me-2" aria-hidden="true" />
                      Send Feedback
                    </Link>
                    
                    <DropdownDivider />
                    
                    {/* Logout */}
                    <DropdownItem
                      onClick={(e) => {
                        e.preventDefault();
                        logout();
                      }}
                      aria-label="Logout"
                    >
                      <LogOut size={16} className="me-2" aria-hidden="true" />
                      Logout
                    </DropdownItem>
                  </Dropdown>
                </div>
              </>
            ) : (
              <div className="nav-items">
              </div>
            )}
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
