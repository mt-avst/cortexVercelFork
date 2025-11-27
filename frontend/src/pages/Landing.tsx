import React, { useState, useEffect, useRef, memo } from 'react';
import { demoLogin, demoAdminLogin, demoSuperadminLogin, googleLogin } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';

/**
 * Landing Page Component
 * CSS is centralized in main.css for performance.
 */
const Landing: React.FC = memo(() => {
  const [loginLoading, setLoginLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const coralDotsRef = useRef<(HTMLDivElement | null)[]>([]);
  const { isDarkMode } = useTheme();
  
  // Total number of traveling dots (20 horizontal + 20 vertical)
  const DOT_COUNT = 40;

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

  // Randomize dot positions on grid lines (only in dark mode)
  useEffect(() => {
    if (!isDarkMode) return;

    const randomizeCoralDots = () => {
      coralDotsRef.current.forEach((dot, index) => {
        if (dot) {
          const isHorizontal = index < DOT_COUNT / 2;
          const gridRowOrCol = Math.floor(Math.random() * 15);
          const position = (gridRowOrCol * 80);
          
          if (isHorizontal) {
            dot.style.top = `${position}px`;
            dot.style.left = '0';
          } else {
            dot.style.left = `${position}px`;
            dot.style.top = '0';
          }
          
          const duration = 8 + Math.random() * 20;  // 8-28 seconds for more speed variety
          const delay = Math.random() * 15;
          dot.style.animationDuration = `${duration}s`;
          dot.style.animationDelay = `${delay}s`;
        }
      });
    };

    randomizeCoralDots();
    const intervalId = setInterval(randomizeCoralDots, 20000);

    return () => clearInterval(intervalId);
  }, [isDarkMode]);

  return (
    <div className={`landing-hero-wrapper ${!isDarkMode ? 'light-mode' : ''}`}>
      {/* Traveling rectangles along grid lines - 40 total (20 horizontal + 20 vertical) */}
      {isDarkMode && <div className="coral-dots-container">
        {Array.from({ length: DOT_COUNT }, (_, index) => {
          const isHorizontal = index < DOT_COUNT / 2;
          return (
            <div
              key={index}
              ref={(el) => { coralDotsRef.current[index] = el; }}
              className={`coral-dot ${isHorizontal ? 'coral-dot-horizontal' : 'coral-dot-vertical'}`}
              style={{
                animation: isHorizontal ? 'travelHorizontal 15s linear infinite' : 'travelVertical 15s linear infinite'
              }}
            />
          );
        })}
      </div>}
      
      {/* Hero Content - Redesigned Layout */}
      <div className="hero-content hero-content-redesign">
          
          {/* Section 1: Brand Header - Centered Layout */}
          <div className="hero-brand-header-centered">
            <div className="hero-brand-lockup">
              <img 
                src="/images/research-icon.png" 
                alt="AdaptaLabs" 
                className="hero-logo-large"
              />
              <div className="hero-text-stack">
                <h1 className="hero-title-large">AdaptaLabs</h1>
                <p className="hero-subtitle-centered">Help build our future, <span className="subtitle-emphasis">today</span></p>
              </div>
            </div>
          </div>
          
          {/* Section 2: Two Column Value Grid */}
          <div className="hero-value-grid">
            <div className="hero-value-column">
              <h3 className="hero-value-heading">Innovation & First Look</h3>
              <ul className="hero-value-list">
                <li>Try early features and new tools</li>
                <li>Explore prototypes and experiments</li>
                <li>Get first access to new developments</li>
              </ul>
            </div>
            <div className="hero-value-column">
              <h3 className="hero-value-heading">Ask the Organisation</h3>
              <ul className="hero-value-list">
                <li>Ask the whole enterprise a question</li>
                <li>Run studies, polls and quick surveys</li>
                <li>Ask simple one-off questions</li>
              </ul>
            </div>
          </div>
          
          {/* Section 3: Primary Action Zone */}
          <div className="hero-action-zone">
            <button 
              onClick={handleGoogleLogin} 
              className="hero-cta-primary"
              disabled={googleLoading || loginLoading}
              aria-busy={googleLoading || loginLoading}
              aria-label={googleLoading ? "Signing in with Google" : "Sign in with Google"}
            >
              {googleLoading ? (
                <>
                  <span className="btn-spinner" role="status" aria-label="Signing in" aria-hidden="true"></span>
                  <span>Signing in...</span>
                </>
              ) : (
                <>
                  <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <g fillRule="evenodd">
                      <path d="M9 3.48c1.69 0 2.83.73 3.48 1.34l2.54-2.48C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.96l2.91 2.26C4.6 5.05 6.62 3.48 9 3.48z" fill="#EA4335"/>
                      <path d="M17.64 9.2c0-.74-.06-1.28-.19-1.84H9v3.34h4.96c-.21 1.18-.84 2.18-1.79 2.91l2.75 2.13c1.66-1.52 2.72-3.77 2.72-6.54z" fill="#4285F4"/>
                      <path d="M3.88 10.78A5.54 5.54 0 0 1 3.58 9c0-.62.11-1.22.29-1.78L.96 4.96A9.008 9.008 0 0 0 0 9c0 1.45.35 2.82.96 4.04l2.92-2.26z" fill="#FBBC05"/>
                      <path d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.75-2.13c-.76.53-1.78.9-3.21.9-2.38 0-4.4-1.57-5.12-3.74L.96 13.04C2.45 15.98 5.48 18 9 18z" fill="#34A853"/>
                    </g>
                  </svg>
                  <span>Sign in with Google</span>
                </>
              )}
            </button>
            
            <div className="hero-demo-links">
              <button 
                onClick={handleDemoLogin} 
                className="hero-demo-link"
                disabled={loginLoading || googleLoading}
                aria-label={loginLoading ? "Signing in..." : "Demo Login"}
              >
                {loginLoading ? 'Signing in...' : 'Demo Login'}
              </button>
              <span className="hero-demo-divider">•</span>
              <button 
                onClick={handleDemoAdminLogin} 
                className="hero-demo-link"
                disabled={loginLoading || googleLoading}
                aria-label={loginLoading ? "Signing in..." : "Demo Admin"}
              >
                {loginLoading ? 'Signing in...' : 'Demo Admin'}
              </button>
              <span className="hero-demo-divider">•</span>
              <button 
                onClick={handleDemoSuperadminLogin} 
                className="hero-demo-link"
                disabled={loginLoading || googleLoading}
                aria-label={loginLoading ? "Signing in..." : "Demo Superadmin"}
              >
                {loginLoading ? 'Signing in...' : 'Demo Superadmin'}
              </button>
            </div>
          </div>
          
        </div>
      </div>
  );
});

Landing.displayName = 'Landing';

export default Landing;
