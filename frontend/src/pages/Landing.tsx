import React, { useState, memo, useEffect } from 'react';
import { demoLogin, demoAdminLogin, demoSuperadminLogin, googleLogin } from '../api/client';
import OrganicNeuralBackground from '../components/OrganicNeuralBackground';
import StaticNeuralBackground from '../components/StaticNeuralBackground';
import { useTheme } from '../contexts/ThemeContext';

/**
 * Landing Page Component - Adaptavist Cortex
 * 
 * Premium, immersive design with:
 * - Full-screen neural cloud background
 * - Responsive typography lockup
 * - Glassmorphism UI elements
 * 
 * All styles now use CSS classes from _components.css for proper theming.
 */

const Landing: React.FC = memo(() => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  
  // Add landing-page class to body for header transparency
  useEffect(() => {
    document.body.classList.add('landing-page');
    return () => {
      document.body.classList.remove('landing-page');
    };
  }, []);

  const [loginLoading, setLoginLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const handleDemoLogin = () => {
    setLoginLoading(true);
    demoLogin();
  };

  const handleDemoAdminLogin = () => {
    setLoginLoading(true);
    demoAdminLogin();
  };

  const handleDemoSuperadminLogin = () => {
    setLoginLoading(true);
    demoSuperadminLogin();
  };

  const handleGoogleLogin = () => {
    setGoogleLoading(true);
    googleLogin();
  };

  const isLoading = googleLoading || loginLoading;

  return (
    <div className="landing-page-wrapper">
      {/* Conditional Background */}
      {isDark ? <OrganicNeuralBackground /> : <StaticNeuralBackground />}
      
      {/* Main Layout Container - Full-screen Flexbox */}
      <div className="landing-layout-container">
        {/* Top Spacer - for navbar clearance */}
        <div style={{ flexShrink: 0, height: '1px' }} />

        {/* Hero Stack - Optical Center */}
        <div className="landing-hero-stack">
          {/* Shadow Shield - tight behind text only */}
          <div className="landing-shadow-shield" />
          
          {/* Eyebrow */}
          <span className="landing-parent-brand">ADAPTAVIST</span>
          
          {/* Hero Title */}
          <h1 className="landing-product-name">CORTEX</h1>
          
          {/* Tagline */}
          <p className="landing-tagline">All our collective thinking and experience, together</p>

          {/* CTA Button - using glass variant */}
          <button 
            onClick={handleGoogleLogin}
            className={`btn-glass ${isLoading ? 'disabled' : ''}`}
            style={{ marginTop: '2.5rem', marginBottom: 0 }}
            disabled={isLoading}
            aria-busy={isLoading}
            aria-label={googleLoading ? "Connecting..." : "Access Cortex"}
          >
            {googleLoading ? (
              <span className="d-flex align-items-center gap-2">
                <span className="spinner-border spinner-border-sm" aria-hidden="true" />
                Connecting...
              </span>
            ) : (
              <span className="d-flex align-items-center gap-3">
                {/* Google Logo */}
                <svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                Access Cortex
              </span>
            )}
          </button>
        </div>

        {/* Demo Footer - Pinned Bottom */}
        <div className="landing-demo-footer">
          <span className="landing-demo-label">DEMO ACCESS</span>
          <div className="landing-demo-pills">
            <button 
              onClick={handleDemoLogin}
              className="landing-demo-pill"
              disabled={isLoading}
            >
              User
            </button>
            <button 
              onClick={handleDemoAdminLogin}
              className="landing-demo-pill"
              disabled={isLoading}
            >
              Admin
            </button>
            <button 
              onClick={handleDemoSuperadminLogin}
              className="landing-demo-pill"
              disabled={isLoading}
            >
              Superadmin
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

Landing.displayName = 'Landing';

export default Landing;
