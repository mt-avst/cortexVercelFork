import React, { useState, memo } from 'react';
import { demoLogin, demoAdminLogin, demoSuperadminLogin, googleLogin } from '../api/client';
import NeuralParticleField from '../components/NeuralParticleField';
import BeakerLogo from '../components/BeakerLogo';

/**
 * Landing Page Component - Mad Science Edition
 * 
 * Bold, cinematic design with:
 * - Neural particle field background
 * - Animated beaker logo with neurons
 * - Chromatic aberration headline
 * - Glowing blob CTA
 * - Electric violet + blood-orange palette
 */
const Landing: React.FC = memo(() => {
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

  return (
    <div className="mad-science-landing">
      {/* Neural Particle Field Background */}
      <NeuralParticleField />
      
      {/* Cinematic gradient overlays */}
      <div className="cinematic-overlay" aria-hidden="true">
        <div className="gradient-orb gradient-orb-1" />
        <div className="gradient-orb gradient-orb-2" />
        <div className="gradient-orb gradient-orb-3" />
      </div>

      {/* Main Content Container */}
      <div className="mad-science-content">
        
        {/* Animated Beaker Logo */}
        <div className="logo-section">
          <BeakerLogo />
          <div className="logo-text">
            <span className="logo-adapta">Adapta</span>
            <span className="logo-labs">Labs</span>
          </div>
        </div>

        {/* Hero Headline with Chromatic Aberration */}
        <div className="headline-section">
          <h1 className="mad-headline">
            <span className="headline-layer headline-cyan" aria-hidden="true">
              We're building the future in public.
            </span>
            <span className="headline-layer headline-red" aria-hidden="true">
              We're building the future in public.
            </span>
            <span className="headline-layer headline-main">
              We're building the future in public.
            </span>
          </h1>
          <p className="mad-subheadline">Join the experiment.</p>
        </div>

        {/* Glowing Blob CTA */}
        <div className="cta-section">
          <button 
            onClick={handleGoogleLogin}
            className="blob-cta"
            disabled={googleLoading || loginLoading}
            aria-busy={googleLoading || loginLoading}
            aria-label={googleLoading ? "Entering the lab..." : "Enter the Lab"}
          >
            <span className="blob-bg" aria-hidden="true" />
            <span className="blob-glow" aria-hidden="true" />
            <span className="blob-content">
              {googleLoading ? (
                <>
                  <span className="blob-spinner" />
                  <span>Entering...</span>
                </>
              ) : (
                <>
                  <span>Enter the Lab</span>
                  <svg className="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </>
              )}
            </span>
          </button>
        </div>

        {/* Demo Role Pills */}
        <div className="demo-pills-section">
          <span className="demo-label">Try a demo:</span>
          <div className="demo-pills">
            <button 
              onClick={handleDemoLogin}
              className="demo-pill demo-pill-user"
              disabled={loginLoading || googleLoading}
              aria-label={loginLoading ? "Signing in..." : "Demo as User"}
            >
              <span className="pill-glow" aria-hidden="true" />
              <span className="pill-icon">👤</span>
              <span className="pill-text">User</span>
            </button>
            <button 
              onClick={handleDemoAdminLogin}
              className="demo-pill demo-pill-admin"
              disabled={loginLoading || googleLoading}
              aria-label={loginLoading ? "Signing in..." : "Demo as Admin"}
            >
              <span className="pill-glow" aria-hidden="true" />
              <span className="pill-icon">⚡</span>
              <span className="pill-text">Admin</span>
            </button>
            <button 
              onClick={handleDemoSuperadminLogin}
              className="demo-pill demo-pill-super"
              disabled={loginLoading || googleLoading}
              aria-label={loginLoading ? "Signing in..." : "Demo as Superadmin"}
            >
              <span className="pill-glow" aria-hidden="true" />
              <span className="pill-icon">🔬</span>
              <span className="pill-text">Superadmin</span>
            </button>
          </div>
        </div>

        {/* Footer tagline */}
        <div className="landing-footer">
          <p className="footer-text">
            <span className="pulse-dot" aria-hidden="true" />
            Experiments in progress
          </p>
        </div>
      </div>
    </div>
  );
});

Landing.displayName = 'Landing';

export default Landing;
