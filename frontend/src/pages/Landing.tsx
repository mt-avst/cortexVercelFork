import React, { useState, memo, useEffect } from 'react';
import { demoLogin, demoAdminLogin, demoSuperadminLogin, googleLogin } from '../api/client';
import OrganicNeuralBackground from '../components/OrganicNeuralBackground';

/**
 * Landing Page Component - Adaptavist Cortex
 * 
 * Premium, immersive design with:
 * - Full-screen neural cloud background
 * - Responsive typography lockup
 * - Glassmorphism UI elements
 */
const Landing: React.FC = memo(() => {
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

  return (
    <div style={styles.pageWrapper}>
      {/* Fixed Neural Background */}
      <OrganicNeuralBackground />
      
      {/* Main Content Container */}
      <div style={styles.content}>
        {/* Shadow Shield for text contrast */}
        <div style={styles.shadowShield} />
        
        {/* Brand Lockup - Responsive */}
        <div style={styles.brandLockup}>
          <span style={styles.parentBrand} className="landing-parent-brand">ADAPTAVIST</span>
          <h1 style={styles.productName} className="landing-product-name">CORTEX</h1>
          <p style={styles.tagline} className="landing-tagline">The organization's collective brain.</p>
        </div>

        {/* CTA Button */}
        <button 
          onClick={handleGoogleLogin}
          style={{
            ...styles.glassButton,
            ...(googleLoading || loginLoading ? styles.glassButtonDisabled : {}),
          }}
          disabled={googleLoading || loginLoading}
          aria-busy={googleLoading || loginLoading}
          aria-label={googleLoading ? "Connecting..." : "Access Cortex"}
          onMouseEnter={(e) => {
            if (!googleLoading && !loginLoading) {
              e.currentTarget.style.background = 'rgba(255, 85, 0, 0.15)';
              e.currentTarget.style.boxShadow = '0 0 30px rgba(255, 85, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.15)';
              e.currentTarget.style.borderColor = 'rgba(255, 85, 0, 0.7)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
            e.currentTarget.style.boxShadow = '0 4px 30px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.1)';
            e.currentTarget.style.borderColor = 'rgba(255, 85, 0, 0.5)';
          }}
        >
          {googleLoading ? (
            <span style={styles.buttonContent}>
              <span style={styles.spinner} />
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

        {/* Demo Access Section */}
        <div style={styles.demoSection}>
          <span style={styles.demoLabel}>DEMO ACCESS</span>
          <div style={styles.demoPills}>
            <button 
              onClick={handleDemoLogin}
              style={styles.demoPill}
              disabled={loginLoading || googleLoading}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.12)';
              }}
            >
              User
            </button>
            <button 
              onClick={handleDemoAdminLogin}
              style={styles.demoPill}
              disabled={loginLoading || googleLoading}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.12)';
              }}
            >
              Admin
            </button>
            <button 
              onClick={handleDemoSuperadminLogin}
              style={styles.demoPill}
              disabled={loginLoading || googleLoading}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.12)';
              }}
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
    position: 'relative',
    minHeight: '100vh',
    width: '100%',
    background: '#030305',
    overflow: 'hidden',
  },
  content: {
    position: 'relative',
    zIndex: 20,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: '1.5rem',
    textAlign: 'center',
  },
  shadowShield: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '100%',
    maxWidth: '900px',
    height: '700px',
    background: 'radial-gradient(closest-side, rgba(3,3,5, 0.95) 0%, rgba(3,3,5, 0.8) 40%, rgba(3,3,5, 0) 100%)',
    pointerEvents: 'none',
    zIndex: -1,
  },
  brandLockup: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    width: '100%',
    maxWidth: '90vw',
    marginBottom: '2rem',
  },
  parentBrand: {
    fontFamily: '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: 600,
    color: '#FF5500',
    textShadow: '0 0 30px rgba(255, 85, 0, 0.5)',
  },
  productName: {
    fontFamily: '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: 900,
    lineHeight: 0.9,
    margin: 0,
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
    marginBottom: '2rem',
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
  demoSection: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '1rem',
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
    background: 'rgba(255, 255, 255, 0.08)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
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

  /* Force dark background on landing page */
  body.landing-page,
  body.landing-page #root {
    background: #030305 !important;
    min-height: 100vh;
  }

  /* Mobile-first base styles */
  .landing-parent-brand {
    font-size: 0.9rem !important;
    letter-spacing: 0.2em !important;
    margin-bottom: 0.5rem !important;
  }
  
  .landing-product-name {
    font-size: clamp(4rem, 18vw, 12rem) !important;
    letter-spacing: -0.04em !important;
    margin-bottom: 1rem !important;
  }
  
  .landing-tagline {
    font-size: 1rem !important;
    max-width: 320px !important;
  }

  /* Tablet (640px+) */
  @media (min-width: 640px) {
    .landing-parent-brand {
      font-size: 1.1rem !important;
      letter-spacing: 0.28em !important;
      margin-bottom: 0.75rem !important;
    }
    
    .landing-product-name {
      margin-bottom: 1.25rem !important;
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
      letter-spacing: 0.35em !important;
      margin-bottom: 1rem !important;
    }
    
    .landing-product-name {
      margin-bottom: 1.5rem !important;
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
      letter-spacing: 0.4em !important;
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
