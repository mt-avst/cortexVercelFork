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
          <p className="landing-tagline">The organization's collective brain</p>

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
              <span className="d-flex align-items-center gap-2">
                Access Cortex
                <svg 
                  width="18" 
                  height="18" 
                  viewBox="0 0 24 24" 
                  fill="none" 
                  stroke="currentColor" 
                  strokeWidth="2" 
                  strokeLinecap="round" 
                  strokeLinejoin="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
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
