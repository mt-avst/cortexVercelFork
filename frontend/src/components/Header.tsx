import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { demoLogin, demoAdminLogin } from '../api/client';
import LoadingSpinner from './LoadingSpinner';

const Header: React.FC = () => {
  const { user, loading, initialAuthCheck, login, logout } = useAuth();
  const [loginLoading, setLoginLoading] = useState(false);

  const handleDemoLogin = () => {
    setLoginLoading(true);
    demoLogin();
  };

  const handleDemoAdminLogin = () => {
    setLoginLoading(true);
    demoAdminLogin();
  };

  // Reset loading state when user state changes (after login)
  useEffect(() => {
    if (user && loginLoading) {
      setLoginLoading(false);
    }
  }, [user, loginLoading]);

  return (
    <header className="header">
      <div className="container">
        <div className="header-content">
          <Link to="/" className="logo">
            <img 
              src="/images/adaptalogo.png" 
              alt="Adaptalabs Logo" 
              style={{ height: '40px', width: 'auto' }}
            />
          </Link>
          
          <nav className="nav">
            {(loading && initialAuthCheck) || loginLoading ? (
              <LoadingSpinner size="small" text="Signing in..." />
            ) : user ? (
              <>
                <Link to="/my-bookings" className="btn btn-secondary">
                  My Bookings
                </Link>
                {user.role === 'researcher_admin' && (
                  <Link to="/admin" className="btn btn-secondary">
                    Admin
                  </Link>
                )}
                <div className="nav">
                  <span className="mb-3">Hello, {user.name}</span>
                  <button onClick={logout} className="btn btn-secondary">
                    Logout
                  </button>
                </div>
              </>
            ) : (
              <div className="nav">
                <button 
                  onClick={handleDemoLogin} 
                  className="btn btn-primary"
                  disabled={loginLoading}
                >
                  {loginLoading ? 'Signing in...' : 'Demo Login'}
                </button>
                <button 
                  onClick={handleDemoAdminLogin} 
                  className="btn btn-secondary"
                  disabled={loginLoading}
                >
                  {loginLoading ? 'Signing in...' : 'Demo Admin'}
                </button>
              </div>
            )}
          </nav>
        </div>
      </div>
    </header>
  );
};

export default Header;
