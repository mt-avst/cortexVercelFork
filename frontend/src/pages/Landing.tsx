import React, { useState } from 'react';
import { demoLogin, demoUser2Login, demoAdminLogin, googleLogin } from '../api/client';

const Landing: React.FC = () => {
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

  const handleGoogleLogin = () => {
    setGoogleLoading(true);
    googleLogin();
  };

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
            background-color: #0A091A;
            color: #E0E0E0;
            font-family: 'Inter', sans-serif;
            padding-left: 2rem;
            padding-right: 2rem;
            padding-bottom: 2rem;
            text-align: center;
            position: relative;
            overflow: hidden;
          }

          /* Animated Mesh Gradient Background */
          .mesh-gradient-background {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: -2;
            opacity: 0.2;
            background: 
              radial-gradient(circle at 20% 50%, rgba(255, 78, 80, 0.15) 0%, transparent 50%),
              radial-gradient(circle at 80% 80%, rgba(13, 8, 22, 0.3) 0%, transparent 50%),
              radial-gradient(circle at 40% 20%, rgba(255, 78, 80, 0.1) 0%, transparent 50%);
            animation: meshShift 20s ease-in-out infinite;
          }

          @keyframes meshShift {
            0%, 100% {
              background: 
                radial-gradient(circle at 20% 50%, rgba(255, 78, 80, 0.15) 0%, transparent 50%),
                radial-gradient(circle at 80% 80%, rgba(13, 8, 22, 0.3) 0%, transparent 50%),
                radial-gradient(circle at 40% 20%, rgba(255, 78, 80, 0.1) 0%, transparent 50%);
            }
            50% {
              background: 
                radial-gradient(circle at 80% 50%, rgba(255, 78, 80, 0.15) 0%, transparent 50%),
                radial-gradient(circle at 20% 20%, rgba(13, 8, 22, 0.3) 0%, transparent 50%),
                radial-gradient(circle at 60% 80%, rgba(255, 78, 80, 0.1) 0%, transparent 50%);
            }
          }

          .hero-content {
            position: relative;
            z-index: 1;
            max-width: 900px;
            width: 100%;
          }

          /* Hero Image - Above Title */
          .hero-image {
            max-width: 400px;
            width: 100%;
            height: auto;
            margin: 0 auto 2rem;
            display: block;
            opacity: 1;
          }

          .landing-hero-wrapper .hero-headline {
            color: #FFFFFF !important;
            font-size: 3.75rem;
            font-weight: 700;
            margin-bottom: 1rem;
            line-height: 1.1;
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
            margin-bottom: 2.5rem;
          }

          @media (max-width: 768px) {
            .hero-subtext {
              font-size: 1rem;
            }
          }

          .text-spark {
            color: #FF4E50;
          }

          /* Base Button Style */
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

          /* Primary CTA - Glassmorphic */
          .cta-primary {
            background-color: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            color: #FFFFFF;
            width: 100%;
            max-width: 380px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.75rem;
            margin: 0 auto 3rem;
          }

          .cta-primary:hover:not(:disabled) {
            background-color: rgba(255, 255, 255, 0.2);
          }

          /* Secondary CTA - Solid Accent */
          .cta-secondary {
            background-color: #FF4E50;
            color: #FFFFFF;
            border: 1px solid #FF4E50;
          }

          .cta-secondary:hover:not(:disabled) {
            filter: brightness(1.1);
          }

          /* Tertiary CTAs - Ghost */
          .cta-tertiary {
            background-color: transparent;
            border: 1px solid #FF4E50;
            color: #FF4E50;
          }

          .cta-tertiary:hover:not(:disabled) {
            background-color: #FF4E50;
            color: #FFFFFF;
          }

          /* Demo Buttons Container */
          .demo-buttons-container {
            display: flex;
            justify-content: center;
            gap: 1rem;
            flex-wrap: wrap;
            margin-bottom: 3rem;
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

          /* Loading Spinner */
          .btn-spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid currentColor;
            border-right-color: transparent;
            border-radius: 50%;
            animation: spin 0.75s linear infinite;
          }

          @keyframes spin {
            to {
              transform: rotate(360deg);
            }
          }
        `}
      </style>
      <div className="landing-hero-wrapper">
        {/* Animated Mesh Gradient Background */}
        <div className="mesh-gradient-background"></div>
        
        {/* Hero Content */}
        <div className="hero-content">
          <img 
            src="/images/research-icon.png" 
            alt="Research and Innovation" 
            className="hero-image"
          />
          <h1 className="hero-headline">AdaptaLabs</h1>
          <p className="hero-subtext">
            Participate in research that shapes the future of our products. Browse opportunities, book
            sessions, and share feedback to help us build better experiences<span className="text-spark">.</span>
          </p>
          
          {/* Primary CTA - Sign in with Google */}
          <button 
            onClick={handleGoogleLogin} 
            className="btn cta-primary"
            disabled={googleLoading || loginLoading}
          >
            {googleLoading ? (
              <>
                <span className="btn-spinner"></span>
                <span>Signing in...</span>
              </>
            ) : (
              <>
                <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
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
              onClick={() => {
                setLoginLoading(true);
                demoUser2Login();
              }} 
              className="btn cta-secondary"
              disabled={loginLoading || googleLoading}
            >
              {loginLoading ? 'Signing in...' : 'Demo User 2'}
            </button>
            <button 
              onClick={handleDemoLogin} 
              className="btn cta-tertiary"
              disabled={loginLoading || googleLoading}
            >
              {loginLoading ? 'Signing in...' : 'Demo Login'}
            </button>
            <button 
              onClick={handleDemoAdminLogin} 
              className="btn cta-tertiary"
              disabled={loginLoading || googleLoading}
            >
              {loginLoading ? 'Signing in...' : 'Demo Admin'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default Landing;


