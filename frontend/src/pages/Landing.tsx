import React, { useState, useEffect, useRef, useMemo } from 'react';
import { demoLogin, demoAdminLogin, demoSuperadminLogin, googleLogin } from '../api/client';
import { useAnimation } from '../contexts/AnimationContext';

const Landing: React.FC = () => {
  const [loginLoading, setLoginLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const coralDotsRef = useRef<(HTMLDivElement | null)[]>([]);
  const { animationsEnabled } = useAnimation();
  
  // Generate stable opacity values for each dot (persists across renders)
  const dotOpacities = useMemo(() => {
    return Array.from({ length: 30 }, () => 0.2 + Math.random() * 0.8);
  }, []);

  // Generate stable color values for each dot (persists across renders)
  const dotColors = useMemo(() => {
    return Array.from({ length: 30 }, () => {
      const hue = 340 + Math.random() * 20;
      const saturation = 70 + Math.random() * 30;
      const lightness = 25 + Math.random() * 15;
      return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    });
  }, []);

  // Helper function to convert HSL to RGB
  const hslToRgb = (hslColor: string): [number, number, number] => {
    const hslMatch = hslColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
    let r = 255, g = 78, b = 80;
    if (hslMatch) {
      const h = parseInt(hslMatch[1]) / 360;
      const s = parseInt(hslMatch[2]) / 100;
      const l = parseInt(hslMatch[3]) / 100;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs((h * 6) % 2 - 1));
      const m = l - c / 2;
      if (h < 1/6) { r = c; g = x; b = 0; }
      else if (h < 2/6) { r = x; g = c; b = 0; }
      else if (h < 3/6) { r = 0; g = c; b = x; }
      else if (h < 4/6) { r = 0; g = x; b = c; }
      else if (h < 5/6) { r = x; g = 0; b = c; }
      else { r = c; g = 0; b = x; }
      r = Math.round((r + m) * 255);
      g = Math.round((g + m) * 255);
      b = Math.round((b + m) * 255);
    }
    return [r, g, b];
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

  const handleGoogleLogin = () => {
    setGoogleLoading(true);
    googleLogin();
  };

  // Coral dots animation - randomize positions on grid lines
  useEffect(() => {
    if (!animationsEnabled) return;

    const randomizeCoralDots = () => {
      coralDotsRef.current.forEach((dot, index) => {
        if (dot) {
          const isHorizontal = index < 15;
          const gridRowOrCol = Math.floor(Math.random() * 15);
          const position = (gridRowOrCol * 80);
          
          if (isHorizontal) {
            dot.style.top = `${position}px`;
            dot.style.left = '0';
          } else {
            dot.style.left = `${position}px`;
            dot.style.top = '0';
          }
          
          const duration = 12 + Math.random() * 8;
          const delay = Math.random() * 10;
          dot.style.animationDuration = `${duration}s`;
          dot.style.animationDelay = `${delay}s`;
        }
      });
    };

    randomizeCoralDots();
    const intervalId = setInterval(randomizeCoralDots, 20000);

    return () => clearInterval(intervalId);
  }, [animationsEnabled]);

  return (
    <>
      <style>
        {`
          .landing-hero-wrapper {
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-start;
            padding-top: 5vh;
            background-color: transparent;
            color: #E0E0E0;
            font-family: 'Inter', sans-serif;
            padding-left: 2rem;
            padding-right: 2rem;
            padding-bottom: 2rem;
            text-align: center;
            position: relative;
            overflow: hidden;
          }

          /* Coral dots container - matches grid background position */
          .coral-dots-container {
            position: fixed;
            top: -20%;
            left: -20%;
            width: 140%;
            height: 140%;
            z-index: 3;
            pointer-events: none;
            overflow: visible;
          }

          @keyframes travelHorizontal {
            0% {
              transform: translateX(-4px);
            }
            100% {
              transform: translateX(calc(1.4 * 100vw - 4px));
            }
          }

          @keyframes travelVertical {
            0% {
              transform: translateY(-4px);
            }
            100% {
              transform: translateY(calc(1.4 * 100vh - 4px));
            }
          }

          .hero-content {
            position: relative;
            z-index: 10;
            max-width: 900px;
            width: 100%;
            padding: 0.75rem;
            margin: 0 auto;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
          }

          .hero-content::before {
            content: '';
            position: absolute;
            top: -0.5rem;
            left: -0.5rem;
            right: -0.5rem;
            bottom: -0.5rem;
            z-index: -1;
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 78, 80, 0.3);
            border-radius: 24px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
          }

          .coral-dot {
            position: absolute;
            width: 8px;
            height: 8px;
            background-color: #FF4E50;
            border-radius: 50%;
            z-index: 3;
            pointer-events: none;
          }

          .coral-dot-horizontal {
            margin-top: -4px;
            margin-left: -4px;
          }

          .coral-dot-vertical {
            margin-top: -4px;
            margin-left: -4px;
          }

          .hero-image {
            max-width: 400px;
            width: 100%;
            height: auto;
            margin: 0 auto 2rem;
            display: block;
            opacity: 1;
            align-self: center;
          }

          .landing-hero-wrapper .hero-headline {
            color: #FFFFFF !important;
            font-size: 3.75rem;
            font-weight: 700;
            margin-bottom: 1rem;
            line-height: 1.1;
            text-align: center;
            position: relative;
            display: inline-block;
            width: auto;
          }

          @media (max-width: 768px) {
            .landing-hero-wrapper .hero-headline {
              font-size: 2.5rem;
            }
          }

          .hero-subtext {
            color: #D1D5DB;
            font-size: 1.125rem;
            max-width: 44rem;
            margin-left: auto;
            margin-right: auto;
            line-height: 1.6;
            margin-bottom: 0.75rem;
            text-align: center;
          }

          .hero-subtext-secondary {
            color: #9CA3AF;
            font-size: 0.95rem;
            max-width: 44rem;
            margin-left: auto;
            margin-right: auto;
            line-height: 1.5;
            margin-bottom: 2.5rem;
            text-align: center;
          }

          @media (max-width: 768px) {
            .hero-subtext {
              font-size: 1rem;
            }
            .hero-subtext-secondary {
              font-size: 0.875rem;
            }
          }

          .text-spark {
            color: #FF4E50;
          }

          .btn {
            display: inline-block;
            padding: 0.75rem 1.5rem;
            font-size: 0.9rem;
            font-weight: 500;
            border-radius: 8px;
            text-decoration: none;
            transition: all 0.2s ease-in-out;
            cursor: pointer;
            border: none;
            font-family: 'Inter', sans-serif;
          }

          .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
          }

          .cta-primary {
            background-color: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            color: #FFFFFF;
            font-size: 18px !important;
            width: 100%;
            max-width: 380px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.75rem;
            margin: 0 auto 3rem;
            align-self: center;
          }

          .cta-primary:hover:not(:disabled) {
            background-color: rgba(255, 255, 255, 0.2);
          }

          .cta-secondary {
            background-color: #FF4E50;
            color: #FFFFFF;
            border: 1px solid #FF4E50;
            font-size: 18px !important;
          }

          .cta-secondary:hover:not(:disabled) {
            filter: brightness(1.1);
          }

          .cta-tertiary {
            background-color: transparent;
            border: 1px solid #FF4E50;
            color: #FF4E50;
            font-size: 18px !important;
          }

          .cta-tertiary:hover:not(:disabled) {
            background-color: #FF4E50;
            color: #FFFFFF;
          }

          .demo-buttons-container {
            display: flex;
            justify-content: center;
            gap: 1rem;
            flex-wrap: wrap;
            margin-bottom: 3rem;
            width: 100%;
            align-self: center;
          }

          @media (max-width: 640px) {
            .demo-buttons-container {
              flex-direction: column;
              align-items: center;
            }
            
            .demo-buttons-container .btn {
              width: 100%;
              max-width: 380px;
            }
          }

          .btn-spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top: 2px solid #FFFFFF;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
          }

          @keyframes spin {
            to {
              transform: rotate(360deg);
            }
          }
          
          .beta-badge {
            position: absolute;
            top: -0.4rem;
            right: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 0.32rem 0.6rem;
            background-color: #FF4E50;
            color: #FFFFFF;
            font-size: 0.6rem;
            font-weight: 700;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            border-radius: 5px;
            box-shadow: 0 2px 8px rgba(255, 78, 80, 0.3);
            white-space: nowrap;
            z-index: 10;
            transform: translateX(calc(100% + 0.5rem));
          }
          
          @media (max-width: 768px) {
            .beta-badge {
              top: -0.32rem;
              right: 0;
              font-size: 0.52rem;
              padding: 0.28rem 0.48rem;
              transform: translateX(calc(100% + 0.4rem));
            }
          }
          
          @media (max-width: 480px) {
            .beta-badge {
              top: -0.24rem;
              right: 0;
              font-size: 0.48rem;
              padding: 0.24rem 0.4rem;
              transform: translateX(calc(100% + 0.3rem));
            }
          }

          .animations-disabled .coral-dot {
            animation: none !important;
            opacity: 0 !important;
          }
        `}
      </style>
      <div className={`landing-hero-wrapper ${!animationsEnabled ? 'animations-disabled' : ''}`}>
        {/* Coral dots traveling along grid lines - 30 dots randomly positioned */}
        <div className="coral-dots-container">
          {Array.from({ length: 30 }).map((_, index) => {
            const isHorizontal = index < 15;
            const dotOpacity = dotOpacities[index];
            const dotColor = dotColors[index];
            const shadowIntensity = dotOpacity;
            const [r, g, b] = hslToRgb(dotColor);
            
            return (
              <div
                key={index}
                ref={(el) => {
                  coralDotsRef.current[index] = el;
                  if (el) {
                    el.style.setProperty('opacity', dotOpacity.toString(), 'important');
                    el.style.setProperty('background-color', dotColor, 'important');
                    el.style.setProperty('box-shadow', `0 0 ${12 * shadowIntensity}px ${dotColor}, 0 0 ${20 * shadowIntensity}px rgba(${r}, ${g}, ${b}, ${0.8 * shadowIntensity})`, 'important');
                  }
                }}
                className={`coral-dot ${isHorizontal ? 'coral-dot-horizontal' : 'coral-dot-vertical'}`}
                style={{
                  animation: isHorizontal ? 'travelHorizontal 15s linear infinite' : 'travelVertical 15s linear infinite',
                  animationDelay: '0s',
                  opacity: dotOpacity,
                  backgroundColor: dotColor,
                  boxShadow: `0 0 ${12 * shadowIntensity}px ${dotColor}, 0 0 ${20 * shadowIntensity}px rgba(${r}, ${g}, ${b}, ${0.8 * shadowIntensity})`
                }}
              ></div>
            );
          })}
        </div>
        
        {/* Hero Content */}
        <div className="hero-content">
          <img 
            src="/images/research-icon.png" 
            alt="Research and Innovation" 
            className="hero-image"
          />
          <h1 className="hero-headline">
            AdaptaLabs
            <span className="beta-badge">BETA v5.4.0</span>
          </h1>
          <p className="hero-subtext">
            Help influence the products you use by taking part in quick, well designed research sessions
          </p>
          <p className="hero-subtext-secondary">
            Book studies, test ideas, and shape the next generation of Adaptavist products
          </p>
          
          {/* Primary CTA - Sign in with Google */}
          <button 
            onClick={handleGoogleLogin} 
            className="btn cta-primary"
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
          
          {/* Demo Buttons Container */}
          <div className="demo-buttons-container">
            <button 
              onClick={handleDemoLogin} 
              className="btn cta-secondary"
              disabled={loginLoading || googleLoading}
              aria-busy={loginLoading}
              aria-label={loginLoading ? "Signing in..." : "Demo Login"}
            >
              {loginLoading ? 'Signing in...' : 'Demo Login'}
            </button>
            <button 
              onClick={handleDemoAdminLogin} 
              className="btn cta-tertiary"
              disabled={loginLoading || googleLoading}
              aria-busy={loginLoading}
              aria-label={loginLoading ? "Signing in..." : "Demo Admin"}
            >
              {loginLoading ? 'Signing in...' : 'Demo Admin'}
            </button>
            <button 
              onClick={handleDemoSuperadminLogin} 
              className="btn cta-tertiary"
              disabled={loginLoading || googleLoading}
              aria-busy={loginLoading}
              aria-label={loginLoading ? "Signing in..." : "Demo Superadmin"}
              style={{ borderColor: '#FF4E50', color: '#FF4E50' }}
            >
              {loginLoading ? 'Signing in...' : 'Demo Superadmin'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default Landing;
