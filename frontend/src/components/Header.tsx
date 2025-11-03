import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useAnimation } from '../contexts/AnimationContext';
import LoadingSpinner from './LoadingSpinner';
import './Header.css';

const Header: React.FC = () => {
  const { user, loading, initialAuthCheck, logout } = useAuth();
  const { animationsEnabled, toggleAnimations } = useAnimation();
  const location = useLocation();
  
  // Check if we're on an admin page
  const isOnAdminPage = location.pathname.startsWith('/admin');

  // Determine logo link based on user role
  // Use useMemo to ensure it updates when user changes
  const logoLink = React.useMemo(() => {
    if (user?.role === 'researcher_admin') {
      return '/admin';
    }
    return '/';
  }, [user?.role]);

  return (
    <header className="header">
      <div className="container">
        <div className="header-content">
          <Link to={logoLink} className="logo">
            <img 
              src="/images/adaptalogo.png" 
              alt="Adaptalabs Logo" 
              style={{ height: '40px', width: 'auto' }}
            />
          </Link>
          
          <nav className="nav">
            {/* Animation Toggle Button - Always visible */}
            <button
              onClick={toggleAnimations}
              className="btn btn-outline-secondary"
              title={animationsEnabled ? 'Disable animations' : 'Enable animations'}
              style={{ marginRight: '0.5rem' }}
            >
              <i className={animationsEnabled ? 'bi bi-pause-fill' : 'bi bi-play-fill'}></i>
              <span className="d-none d-md-inline ms-1">
                {animationsEnabled ? 'Animations On' : 'Animations Off'}
              </span>
            </button>

            {loading && initialAuthCheck ? (
              <LoadingSpinner size="small" text="Loading..." />
            ) : user ? (
              <>
                {user.role !== 'researcher_admin' && (
                  <>
                    <Link to="/my-bookings" className="btn btn-secondary">
                      My Bookings
                    </Link>
                  </>
                )}
                {user.role === 'researcher_admin' && !isOnAdminPage && (
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
                    >
                      <i className="bi bi-person-circle me-1"></i>
                      Your Profile
                    </button>
                    <ul className="dropdown-menu dropdown-menu-end" aria-labelledby="profileDropdown">
                      <li>
                        <div className="px-3 py-2">
                          <i className="bi bi-person me-2"></i>
                          <span>Hello, {user.name || 'Unknown User'}</span>
                        </div>
                      </li>
                      <li><hr className="dropdown-divider" /></li>
                      <li>
                        <div className="px-3 py-2">
                          <i className="bi bi-shield-check me-2"></i>
                          <span>Role: {user.role === 'researcher_admin' ? 'admin' : 'user'}</span>
                        </div>
                      </li>
                      <li>
                        <div className="px-3 py-2">
                          <i className="bi bi-gear me-2"></i>
                          <span>Settings</span>
                        </div>
                      </li>
                      {user.role !== 'researcher_admin' && (
                        <li>
                          <Link to="/gamification" className="px-3 py-2 d-block">
                            <i className="bi bi-trophy me-2"></i>
                            <span>AdaptaBits</span>
                          </Link>
                        </li>
                      )}
                      <li><hr className="dropdown-divider" /></li>
                      <li>
                        <button 
                          onClick={(e) => {
                            e.preventDefault();
                            logout();
                          }} 
                          className="px-3 py-2 w-100 text-start border-0"
                        >
                          <i className="bi bi-box-arrow-right me-2"></i>
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
