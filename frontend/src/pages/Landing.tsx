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

  // Dynamic styles based on theme
  const getPageWrapperStyle = () => {
    if (isDark) {
      return {
        ...styles.pageWrapper,
        background: '#030305',
      };
    }
    // Light mode: Orange grid pattern (24px, Adaptavist Orange at 5% opacity)
    return {
      ...styles.pageWrapper,
      background: '#f8fafc',
      backgroundImage: 'linear-gradient(to right, rgba(255,85,0,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,85,0,0.05) 1px, transparent 1px)',
      backgroundSize: '24px 24px',
    };
  };

  const getProductNameStyle = () => {
    if (isDark) {
      return styles.productName;
    }
    // Light mode: Use solid color text (not gradient)
    return {
      fontFamily: '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontWeight: 900,
      lineHeight: 0.9,
      margin: 0,
      color: '#0f172a', // slate-900 - solid "heavy ink" feel
      background: 'none',
      WebkitBackgroundClip: 'unset',
      WebkitTextFillColor: '#0f172a',
      backgroundClip: 'unset',
      filter: 'none',
    };
  };

  const getParentBrandStyle = () => ({
    ...styles.parentBrand,
    textShadow: isDark ? '0 0 30px rgba(255, 85, 0, 0.5)' : 'none',
  });

  const getTaglineStyle = () => ({
    ...styles.tagline,
    color: isDark ? '#D4D4D4' : '#64748b', // text-gray-300 -> text-slate-500
    textShadow: isDark ? '0 2px 10px rgba(0, 0, 0, 0.5)' : 'none',
  });

  const getButtonStyle = () => {
    if (isDark) {
      return styles.glassButton;
    }
    return {
      ...styles.glassButton,
      background: '#ffffff',
      border: '1px solid #f97316', // border-orange-500
      color: '#ea580c', // text-orange-600
      fontWeight: 500, // font-medium - stands out against grid lines
      boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)', // shadow-sm
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none',
    };
  };

  const getSpinnerStyle = () => ({
    ...styles.spinner,
    border: isDark 
      ? '2px solid rgba(255, 255, 255, 0.3)' 
      : '2px solid rgba(234, 88, 12, 0.3)', // orange-600 with opacity
    borderTopColor: isDark ? '#FFFFFF' : '#ea580c', // orange-600
  });

  const handleButtonMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (googleLoading || loginLoading) return;
    
    if (isDark) {
      e.currentTarget.style.background = 'rgba(255, 85, 0, 0.15)';
      e.currentTarget.style.boxShadow = '0 0 30px rgba(255, 85, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.15)';
      e.currentTarget.style.borderColor = 'rgba(255, 85, 0, 0.7)';
    } else {
      e.currentTarget.style.background = '#fff7ed'; // bg-orange-50
    }
  };

  const handleButtonMouseLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isDark) {
      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
      e.currentTarget.style.boxShadow = '0 4px 30px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.1)';
      e.currentTarget.style.borderColor = 'rgba(255, 85, 0, 0.5)';
    } else {
      e.currentTarget.style.background = '#ffffff';
    }
  };

  // Demo section theme-aware styles
  const getDemoLabelStyle = () => ({
    ...styles.demoLabel,
    color: isDark ? 'rgba(255, 255, 255, 0.4)' : '#94a3b8', // slate-400
  });

  const getDemoPillStyle = () => {
    if (isDark) {
      return styles.demoPill;
    }
    return {
      ...styles.demoPill,
      color: '#475569', // text-slate-600
      background: '#f1f5f9', // bg-slate-100
      border: '1px solid #cbd5e1', // border-slate-300
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none',
    };
  };

  const handleDemoPillMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Orange glow on hover for both modes
    if (isDark) {
      e.currentTarget.style.background = 'rgba(255, 85, 0, 0.15)';
      e.currentTarget.style.borderColor = 'rgba(255, 85, 0, 0.5)';
      e.currentTarget.style.color = '#FF5500';
      e.currentTarget.style.boxShadow = '0 0 20px rgba(255, 85, 0, 0.3)';
    } else {
      e.currentTarget.style.background = '#fff7ed'; // bg-orange-50
      e.currentTarget.style.borderColor = '#f97316'; // border-orange-500
      e.currentTarget.style.color = '#ea580c'; // text-orange-600
      e.currentTarget.style.boxShadow = '0 0 15px rgba(249, 115, 22, 0.25)';
    }
  };

  const handleDemoPillMouseLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isDark) {
      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
      e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)';
      e.currentTarget.style.boxShadow = 'none';
    } else {
      e.currentTarget.style.background = '#f1f5f9'; // bg-slate-100
      e.currentTarget.style.borderColor = '#cbd5e1'; // border-slate-300
      e.currentTarget.style.color = '#475569'; // text-slate-600
      e.currentTarget.style.boxShadow = 'none';
    }
  };

  return (
    <div style={getPageWrapperStyle()}>
      {/* Conditional Background */}
      {isDark ? <OrganicNeuralBackground /> : <StaticNeuralBackground />}
      
      {/* Main Layout Container - Full-screen Flexbox */}
      <div style={styles.layoutContainer}>
        {/* Top Spacer - for navbar clearance */}
        <div style={styles.topSpacer} />

        {/* Hero Stack - Optical Center */}
        <div style={styles.heroStack}>
          {/* Shadow Shield - inside hero, always centered on text */}
          {/* Smooth circular gradient: no hard edges, spreads to full screen */}
          <div 
            style={{
              ...styles.shadowShield,
              width: '200%',
              height: '200%',
              background: isDark 
                ? 'radial-gradient(circle at center, rgba(3,3,5, 0.85) 0%, rgba(3,3,5, 0.5) 50%, transparent 100%)' 
                : 'none',
            }} 
          />
          
          {/* Eyebrow */}
          <span style={getParentBrandStyle()} className="landing-parent-brand">ADAPTAVIST</span>
          
          {/* Hero Title */}
          <h1 style={getProductNameStyle()} className="landing-product-name">CORTEX</h1>
          
          {/* Tagline */}
          <p style={getTaglineStyle()} className="landing-tagline">The organization's collective brain</p>

          {/* CTA Button */}
          <button 
            onClick={handleGoogleLogin}
            style={{
              ...getButtonStyle(),
              ...(googleLoading || loginLoading ? styles.glassButtonDisabled : {}),
              marginTop: '2.5rem',
              marginBottom: 0,
            }}
            disabled={googleLoading || loginLoading}
            aria-busy={googleLoading || loginLoading}
            aria-label={googleLoading ? "Connecting..." : "Access Cortex"}
            onMouseEnter={handleButtonMouseEnter}
            onMouseLeave={handleButtonMouseLeave}
          >
            {googleLoading ? (
              <span style={styles.buttonContent}>
                <span style={getSpinnerStyle()} />
                Connecting...
              </span>
            ) : (
              <span style={styles.buttonContent}>
                Access Cortex
                <svg style={styles.arrowIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </span>
            )}
          </button>
        </div>

        {/* Demo Footer - Pinned Bottom */}
        <div style={styles.demoFooter} className="landing-demo-footer">
          <span style={getDemoLabelStyle()}>DEMO ACCESS</span>
          <div style={styles.demoPills}>
            <button 
              onClick={handleDemoLogin}
              style={getDemoPillStyle()}
              disabled={loginLoading || googleLoading}
              onMouseEnter={handleDemoPillMouseEnter}
              onMouseLeave={handleDemoPillMouseLeave}
            >
              User
            </button>
            <button 
              onClick={handleDemoAdminLogin}
              style={getDemoPillStyle()}
              disabled={loginLoading || googleLoading}
              onMouseEnter={handleDemoPillMouseEnter}
              onMouseLeave={handleDemoPillMouseLeave}
            >
              Admin
            </button>
            <button 
              onClick={handleDemoSuperadminLogin}
              style={getDemoPillStyle()}
              disabled={loginLoading || googleLoading}
              onMouseEnter={handleDemoPillMouseEnter}
              onMouseLeave={handleDemoPillMouseLeave}
            >
              Superadmin
            </button>
          </div>
        </div>
      </div>

      {/* Inject responsive styles */}
      <style>{responsiveStyles}</style>
    </div>
  );
});

// Base styles
const styles: { [key: string]: React.CSSProperties } = {
  pageWrapper: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100vw',
    height: '100vh',
    background: '#030305',
    overflow: 'hidden',
    zIndex: 50,
  },
  // Task 1: Full-screen Flexbox layout with justify-between
  layoutContainer: {
    position: 'relative',
    zIndex: 20,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: '100vh',
    width: '100%',
    paddingTop: '4rem', // py-16 equivalent (safe zone top)
    paddingBottom: '2rem', // Safe zone bottom
    paddingLeft: '1.5rem',
    paddingRight: '1.5rem',
    overflow: 'hidden',
  },
  topSpacer: {
    // Empty div for flex spacing - allows hero to be optically centered
    flexShrink: 0,
    height: '1px',
  },
  // Task 2: Hero Stack - centered with flex-grow
  heroStack: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
    zIndex: 10,
    textAlign: 'center',
    width: '100%',
    maxWidth: '90vw',
  },
  // Task 3: Shadow Shield - inside hero, always centered
  shadowShield: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '140%',
    height: '140%',
    zIndex: -1,
    pointerEvents: 'none',
  },
  parentBrand: {
    fontFamily: '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: 600,
    color: '#FF5500',
    textShadow: '0 0 30px rgba(255, 85, 0, 0.5)',
    marginBottom: '0.5rem', // mb-2 - tight gap to hero
  },
  productName: {
    fontFamily: '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: 900,
    lineHeight: 0.9,
    margin: 0,
    marginBottom: '2rem', // mb-8 - breathing room
    background: 'linear-gradient(180deg, #FFFFFF 0%, #F5F5F5 40%, #D4D4D4 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    backgroundClip: 'text',
    filter: 'drop-shadow(0 0 80px rgba(255, 85, 0, 0.4)) drop-shadow(0 0 40px rgba(255, 85, 0, 0.2))',
  },
  tagline: {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontWeight: 400,
    letterSpacing: '0.02em',
    color: '#D4D4D4',
    margin: 0,
    textShadow: '0 2px 10px rgba(0, 0, 0, 0.5)',
  },
  glassButton: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1rem 2rem',
    fontSize: '1rem',
    fontWeight: 500,
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#FFFFFF',
    background: 'rgba(255, 255, 255, 0.05)',
    border: '1px solid rgba(255, 85, 0, 0.5)',
    borderRadius: '100px',
    cursor: 'pointer',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    boxShadow: '0 4px 30px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
    transition: 'all 0.3s ease',
  },
  glassButtonDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  buttonContent: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  arrowIcon: {
    width: '18px',
    height: '18px',
  },
  spinner: {
    width: '16px',
    height: '16px',
    border: '2px solid rgba(255, 255, 255, 0.3)',
    borderTopColor: '#FFFFFF',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  // Task 4: Demo Footer - pinned bottom
  demoFooter: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.75rem',
    marginBottom: '1rem',
    opacity: 0.8,
    transition: 'opacity 0.2s ease',
  },
  demoLabel: {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '0.7rem',
    fontWeight: 500,
    color: 'rgba(255, 255, 255, 0.4)',
    letterSpacing: '0.15em',
  },
  demoPills: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: '0.5rem',
  },
  demoPill: {
    padding: '0.6rem 1.25rem',
    fontSize: '0.85rem',
    fontWeight: 500,
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: 'rgba(255, 255, 255, 0.8)',
    background: 'rgba(255, 255, 255, 0.1)',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    borderRadius: '100px',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  },
};

// Responsive CSS using media queries
const responsiveStyles = `
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Landing page background - theme-aware */
  body.landing-page.theme-dark,
  body.landing-page.theme-dark #root {
    background: #030305 !important;
    min-height: 100vh;
  }
  
  body.landing-page.theme-light,
  body.landing-page.theme-light #root {
    background: #f8fafc !important;
    min-height: 100vh;
  }

  /* Mobile-first base styles - Dark mode (default) */
  .landing-parent-brand {
    font-size: 0.9rem !important;
    letter-spacing: 0.4em !important;
  }
  
  .landing-product-name {
    font-size: clamp(4rem, 18vw, 12rem) !important;
    letter-spacing: -0.04em !important;
  }
  
  .landing-tagline {
    font-size: 1rem !important;
    max-width: 320px !important;
  }

  /* Light mode typography - tighter tracking for eyebrow (holds together on white) */
  body.theme-light .landing-parent-brand {
    letter-spacing: 0.2em !important;
  }

  /* Demo footer hover effect */
  .landing-demo-footer:hover {
    opacity: 1 !important;
  }

  /* Tablet (640px+) */
  @media (min-width: 640px) {
    .landing-parent-brand {
      font-size: 1.1rem !important;
    }
    
    .landing-tagline {
      font-size: 1.05rem !important;
      max-width: 450px !important;
    }
  }

  /* Desktop (1024px+) */
  @media (min-width: 1024px) {
    .landing-parent-brand {
      font-size: 1.4rem !important;
    }
    
    .landing-tagline {
      font-size: 1.2rem !important;
      max-width: 600px !important;
    }
  }

  /* Large Desktop (1440px+) */
  @media (min-width: 1440px) {
    .landing-parent-brand {
      font-size: 1.6rem !important;
    }
    
    .landing-tagline {
      font-size: 1.35rem !important;
      max-width: 700px !important;
    }
  }

  /* Extra Large (1920px+) */
  @media (min-width: 1920px) {
    .landing-parent-brand {
      font-size: 1.8rem !important;
    }
    
    .landing-tagline {
      font-size: 1.5rem !important;
    }
  }
`;

Landing.displayName = 'Landing';

export default Landing;
