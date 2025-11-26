import React, { useState, memo, useMemo, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useAnimation } from '../contexts/AnimationContext';
import LoadingSpinner from './LoadingSpinner';
import ConfirmationModal from './ConfirmationModal';
import { requestAdminAccess } from '../api/client';
import './Header.css';

/**
 * Header Component
 * Main navigation header with auth controls and animation toggle.
 * Wrapped in React.memo for performance optimization.
 */
const Header: React.FC = memo(() => {
  const { user, loading, initialAuthCheck, logout } = useAuth();
  const { animationsEnabled, toggleAnimations } = useAnimation();
  const location = useLocation();
  
  // Check if we're on an admin page
  const isOnAdminPage = location.pathname.startsWith('/admin');

  const [requestingAdmin, setRequestingAdmin] = useState(false);
  const [adminRequestMessage, setAdminRequestMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Determine logo link based on user role
  // Use useMemo to ensure it updates when user changes
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
      // Clear message after 5 seconds
      setTimeout(() => setAdminRequestMessage(null), 5000);
    } catch (error: any) {
      const message = error.response?.data?.error || error.message || 'Failed to submit admin request';
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

  return (
    <header className="header">
      <div className="container">
        <div className="header-content">
          <Link to={logoLink} className="logo" aria-label="AdaptaLabs home">
            <img 
              src="/images/adaptalogo.png" 
              alt="Adaptalabs Logo" 
              style={{ height: '40px', width: 'auto' }}
            />
          </Link>
          
          <nav className="nav" aria-label="Main navigation">
            {/* Animation Toggle Button - Always visible */}
            <button
              onClick={toggleAnimations}
              className="btn btn-outline-secondary animation-toggle-btn"
              aria-label={animationsEnabled ? 'Disable animations' : 'Enable animations'}
              title={animationsEnabled ? 'Disable animations' : 'Enable animations'}
              style={{ marginRight: '0.5rem' }}
            >
              <i className={animationsEnabled ? 'bi bi-pause-fill' : 'bi bi-play-fill'} aria-hidden="true"></i>
              <span className="d-none d-md-inline ms-1 animation-toggle-text">
                {animationsEnabled ? 'Animations On' : 'Animations Off'}
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
                      className="momentum-btn-secondary"
                      aria-label="Submit Research Request (opens in new tab)"
                    >
                      Submit Research Request
                    </a>
                    <Link 
                      to="/my-bookings" 
                      className="momentum-btn-secondary"
                    >
                      My Bookings
                    </Link>
                  </>
                )}
                {(user.role === 'researcher_admin' || user.role === 'superadmin') && !isOnAdminPage && (
                  <Link to="/admin" className="btn btn-secondary">
                    Admin
                  </Link>
                )}
                <div className="nav-items">
                  <div className="dropdown">
                    <button 
                      className="btn btn-outline-secondary dropdown-toggle" 
                      type="button" 
                      id="profileDropdown"
                      data-bs-toggle="dropdown" 
                      aria-expanded="false"
                      aria-haspopup="true"
                      aria-label="User profile menu"
                    >
                      <i className="bi bi-person-circle me-1" aria-hidden="true"></i>
                      Your Profile
                    </button>
                    <ul className="dropdown-menu dropdown-menu-end" aria-labelledby="profileDropdown" role="menu">
                      <li role="none">
                        <div className="px-3 py-2">
                          <div className="d-flex align-items-start">
                            <i className="bi bi-person me-2 mt-1" aria-hidden="true"></i>
                            <div>
                              <div>Hello, {user.name || 'Unknown User'}</div>
                              <div className="text-muted small" style={{ opacity: 0.7 }}>
                                {user.role === 'superadmin' ? 'Superadmin' :
                                 user.role === 'researcher_admin' ? 'Admin' :
                                 'User'}
                              </div>
                            </div>
                          </div>
                        </div>
                      </li>
                      <li role="separator"><hr className="dropdown-divider" /></li>
                      {(user.role === 'researcher_admin' || user.role === 'superadmin') && (
                        <li role="none">
                          <Link to="/admin/settings" className="px-3 py-2 d-block" role="menuitem">
                            <i className="bi bi-gear me-2" aria-hidden="true"></i>
                            <span>Settings</span>
                          </Link>
                        </li>
                      )}
                      {user.role !== 'superadmin' && (
                        <>
                          {user.role === 'employee' && (
                            <li role="none">
                              <Link to="/gamification" className="px-3 py-2 d-block" role="menuitem">
                                <i className="bi bi-trophy me-2" aria-hidden="true"></i>
                                <span>AdaptaBits</span>
                              </Link>
                            </li>
                          )}
                          {user.role === 'employee' && (
                            <li role="separator"><hr className="dropdown-divider" /></li>
                          )}
                          <li role="none">
                            <button 
                              onClick={handleRequestAdminClick}
                              className="px-3 py-2 w-100 text-start border-0 bg-transparent text-white d-flex align-items-start"
                              role="menuitem"
                              disabled={requestingAdmin}
                              style={{ cursor: requestingAdmin ? 'not-allowed' : 'pointer' }}
                            >
                              <i className="bi bi-shield-plus me-2 mt-1" aria-hidden="true" style={{ flexShrink: 0 }}></i>
                              <span>
                                {requestingAdmin 
                                  ? 'Submitting...' 
                                  : user.role === 'researcher_admin' 
                                    ? 'Request Superadmin Access' 
                                    : 'Request Admin Access'
                                }
                              </span>
                            </button>
                          </li>
                          {adminRequestMessage && (
                            <li role="none">
                              <div className={`px-3 py-2 small ${adminRequestMessage.type === 'success' ? 'text-success' : 'text-danger'}`}>
                                <i className={`bi ${adminRequestMessage.type === 'success' ? 'bi-check-circle' : 'bi-exclamation-circle'} me-2`} aria-hidden="true"></i>
                                {adminRequestMessage.text}
                              </div>
                            </li>
                          )}
                        </>
                      )}
                      <li role="separator"><hr className="dropdown-divider" /></li>
                      <li role="none">
                        <Link to="/feedback" className="px-3 py-2 d-block" role="menuitem">
                          <i className="bi bi-chat-left-text me-2" aria-hidden="true"></i>
                          <span>Send Feedback</span>
                        </Link>
                      </li>
                      <li role="separator"><hr className="dropdown-divider" /></li>
                      <li role="none">
                        <button 
                          onClick={(e) => {
                            e.preventDefault();
                            logout();
                          }} 
                          className="px-3 py-2 w-100 text-start border-0"
                          role="menuitem"
                          aria-label="Logout"
                        >
                          <i className="bi bi-box-arrow-right me-2" aria-hidden="true"></i>
                          <span>Logout</span>
                        </button>
                      </li>
                    </ul>
                  </div>
                </div>
              </>
            ) : (
              <div className="nav-items">
                <span className="text-white-50">Welcome to AdaptaLabs</span>
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
