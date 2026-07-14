import React, { useState, memo, useEffect, useRef } from 'react';
import { demoLogin, demoAdminLogin, demoSuperadminLogin, oidcLogin } from '../api/client';
import OrganicNeuralBackground from '../components/OrganicNeuralBackground';
import StaticNeuralBackground from '../components/StaticNeuralBackground';
import { useTheme } from '../contexts/ThemeContext';
import SalesSections from '../components/SalesSections';

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
  const salesRef = useRef<HTMLDivElement>(null);
  
  // Add landing-page class to body for header transparency
  useEffect(() => {
    document.body.classList.add('landing-page');
    return () => {
      document.body.classList.remove('landing-page');
    };
  }, []);

  const [loginLoading, setLoginLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  // Scroll to sales sections with motion preference support
  const handleScrollToSales = () => {
    if (salesRef.current) {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      salesRef.current.scrollIntoView({ 
        behavior: prefersReducedMotion ? 'auto' : 'smooth', 
        block: 'start' 
      });
    }
  };

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

  const handleLogin = () => {
    setGoogleLoading(true);
    oidcLogin();
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
          <h1 className="landing-product-name">Cortex</h1>
          
          {/* Tagline */}
          <p className="landing-tagline">Collective Intelligence</p>

          {/* CTA Button - "Power" solid orange variant */}
          <button 
            onClick={handleLogin}
            className={`btn-power ${isLoading ? 'disabled' : ''}`}
            style={{ marginTop: '2.5rem' }}
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
              <>
                Access Cortex
                {/* Arrow Right Icon */}
                <span className="btn-arrow" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M5 12H19M19 12L12 5M19 12L12 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </span>
              </>
            )}
          </button>

          {/* Hero Scroll Tab - Inside hero stack for flow layout on smaller screens */}
          <button
            type="button"
            className="hero-scroll-tab hero-scroll-tab--inline"
            onClick={handleScrollToSales}
            aria-label="Scroll to learn how Cortex works"
          >
            <span className="hero-scroll-tab__label">New to Cortex?</span>
            <span className="hero-scroll-tab__action">See how it works</span>
            <span className="hero-scroll-tab__arrow" aria-hidden="true">↓</span>
          </button>

        </div>

        {/* Demo Footer - only when VITE_SHOW_DEMO_LOGIN=true or in development */}
        {(import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO_LOGIN === 'true') && (
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
        )}
      </div>

      {/* Sales Sections - Below the fold */}
      <div id="cortex-sales" ref={salesRef}>
        <SalesSections onAccessCortex={handleLogin} isLoading={isLoading} />
      </div>
    </div>
  );
});

Landing.displayName = 'Landing';

export default Landing;
