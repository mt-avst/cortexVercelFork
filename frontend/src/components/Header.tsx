import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useAnimation } from '../contexts/AnimationContext';
import LoadingSpinner from './LoadingSpinner';
import { requestAdminAccess } from '../api/client';
import './Header.css';

const Header: React.FC = () => {
  const { user, loading, initialAuthCheck, logout } = useAuth();
  const { animationsEnabled, toggleAnimations } = useAnimation();
  const location = useLocation();
  
  // Check if we're on an admin page
  const isOnAdminPage = location.pathname.startsWith('/admin');

  const [requestingAdmin, setRequestingAdmin] = useState(false);
  const [adminRequestMessage, setAdminRequestMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Determine logo link based on user role
  // Use useMemo to ensure it updates when user changes
  const logoLink = React.useMemo(() => {
    if (user?.role === 'researcher_admin' || user?.role === 'superadmin') {
      return '/admin';
    }
    return '/';
  }, [user?.role]);

  const handleRequestAdmin = async () => {
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
            <style>{`
              .header .animation-toggle-btn,
              .header .animation-toggle-btn *,
              .header .animation-toggle-text {
                color: #8e9ba6 !important;
              }
              .header .animation-toggle-btn:hover,
              .header .animation-toggle-btn:hover * {
                color: #FFFFFF !important;
              }
            `}</style>

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
                      style={{
                        backgroundColor: 'transparent',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        color: '#E0E0E0',
                        borderRadius: '6px',
                        padding: '10px 20px',
                        fontWeight: 600,
                        fontSize: '15px',
                        minHeight: '40px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        textDecoration: 'none',
                        transition: 'all 0.2s ease-in-out',
                        boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                        marginRight: '0.5rem'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.3)';
                        e.currentTarget.style.boxShadow = '0 4px 10px rgba(0,0,0,0.22)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                        e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
                      }}
                    >
                      Submit Research Request
                    </a>
                    <Link 
                      to="/my-bookings" 
                      className="momentum-btn-secondary"
                      style={{
                        backgroundColor: 'transparent',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        color: '#E0E0E0',
                        borderRadius: '6px',
                        padding: '10px 20px',
                        fontWeight: 600,
                        fontSize: '15px',
                        minHeight: '40px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        textDecoration: 'none',
                        transition: 'all 0.2s ease-in-out',
                        boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.3)';
                        e.currentTarget.style.boxShadow = '0 4px 10px rgba(0,0,0,0.22)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                        e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
                      }}
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
                          <i className="bi bi-person me-2" aria-hidden="true"></i>
                          <span>Hello, {user.name || 'Unknown User'}</span>
                        </div>
                      </li>
                      <li role="separator"><hr className="dropdown-divider" /></li>
                      <li role="none">
                        <div className="px-3 py-2">
                          <i className="bi bi-shield-check me-2" aria-hidden="true"></i>
                          <span>Role: {
                            user.role === 'superadmin' ? 'superadmin' :
                            user.role === 'researcher_admin' ? 'admin' :
                            'user'
                          }</span>
                        </div>
                      </li>
                      {(user.role === 'researcher_admin' || user.role === 'superadmin') && (
                        <li role="none">
                          <Link to="/admin/settings" className="px-3 py-2 d-block" role="menuitem">
                            <i className="bi bi-gear me-2" aria-hidden="true"></i>
                            <span>Settings</span>
                          </Link>
                        </li>
                      )}
                      {user.role !== 'researcher_admin' && user.role !== 'superadmin' && (
                        <>
                          <li role="none">
                            <Link to="/gamification" className="px-3 py-2 d-block" role="menuitem">
                              <i className="bi bi-trophy me-2" aria-hidden="true"></i>
                              <span>AdaptaBits</span>
                            </Link>
                          </li>
                          <li role="separator"><hr className="dropdown-divider" /></li>
                          <li role="none">
                            <button 
                              onClick={handleRequestAdmin}
                              className="px-3 py-2 w-100 text-start border-0 bg-transparent text-white"
                              role="menuitem"
                              disabled={requestingAdmin}
                              style={{ cursor: requestingAdmin ? 'not-allowed' : 'pointer' }}
                            >
                              <i className="bi bi-shield-plus me-2" aria-hidden="true"></i>
                              <span>{requestingAdmin ? 'Submitting...' : 'Request Admin Access'}</span>
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
    </header>
  );
};

export default Header;
