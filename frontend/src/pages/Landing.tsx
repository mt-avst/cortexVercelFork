import React, { useState, useEffect } from 'react';
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
    <div className="container py-5" style={{ backgroundColor: '#000000', minHeight: '100vh', color: '#ffffff' }}>
      <div className="row align-items-center">
        {/* Left side - Large Image */}
        <div className="col-12 col-lg-6 mb-4 mb-lg-0">
          <div className="text-center text-lg-start">
            <img 
              src="/images/research-icon.png" 
              alt="Research and Innovation" 
              className="img-fluid"
              style={{ 
                maxWidth: '400px', 
                width: '100%',
                height: 'auto'
              }}
            />
          </div>
        </div>
        
        {/* Right side - Text Content */}
        <div className="col-12 col-lg-6">
          <div className="ps-lg-4">
            <h1 className="display-1 fw-bold text-white" style={{ fontSize: 'clamp(3rem, 6vw, 5rem)', lineHeight: 1.1 }}>
              AdaptaLabs
            </h1>
            <p className="lead text-white-50 mt-3" style={{ fontSize: 'clamp(1.275rem, 2.38vw, 1.9125rem)' }}>
              Participate in research that shapes the future of our products. Browse opportunities, book
              sessions, and share feedback to help us build better experiences.
            </p>
            
            {/* Login Buttons */}
            <div className="mt-4 d-flex flex-column gap-3">
              {/* Google Sign In - Primary method */}
              <button 
                onClick={handleGoogleLogin} 
                className="btn btn-light btn-lg px-4 py-2 d-flex align-items-center justify-content-center gap-2"
                disabled={googleLoading || loginLoading}
                style={{ 
                  fontSize: '1.1rem', 
                  fontWeight: '600',
                  backgroundColor: '#ffffff',
                  color: '#757575',
                  border: '1px solid #dadce0'
                }}
              >
                {googleLoading ? (
                  <>
                    <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
                    <span>Signing in...</span>
                  </>
                ) : (
                  <>
                    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
                      <g fill="#000" fillRule="evenodd">
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
              
              {/* Demo buttons - for development */}
              <div className="d-flex flex-column flex-sm-row gap-3">
                <button 
                  onClick={handleDemoLogin} 
                  className="btn btn-primary btn-lg px-4 py-2"
                  disabled={loginLoading || googleLoading}
                  style={{ fontSize: '1rem', fontWeight: '500' }}
                >
                  {loginLoading ? 'Signing in...' : 'Demo Login'}
                </button>
                <button 
                  onClick={() => {
                    setLoginLoading(true);
                    demoUser2Login();
                  }} 
                  className="btn btn-info btn-lg px-4 py-2"
                  disabled={loginLoading || googleLoading}
                  style={{ fontSize: '1rem', fontWeight: '500' }}
                >
                  {loginLoading ? 'Signing in...' : 'Demo User 2'}
                </button>
                <button 
                  onClick={handleDemoAdminLogin} 
                  className="btn btn-outline-light btn-lg px-4 py-2"
                  disabled={loginLoading || googleLoading}
                  style={{ fontSize: '1rem', fontWeight: '500' }}
                >
                  {loginLoading ? 'Signing in...' : 'Demo Admin'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Landing;


