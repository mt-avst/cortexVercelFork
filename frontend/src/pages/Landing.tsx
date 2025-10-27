import React, { useState, useEffect } from 'react';
import { demoLogin, demoAdminLogin } from '../api/client';

const Landing: React.FC = () => {
  const [loginLoading, setLoginLoading] = useState(false);

  const handleDemoLogin = () => {
    setLoginLoading(true);
    demoLogin();
  };

  const handleDemoAdminLogin = () => {
    setLoginLoading(true);
    demoAdminLogin();
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
            <div className="mt-4 d-flex flex-column flex-sm-row gap-3">
              <button 
                onClick={handleDemoLogin} 
                className="btn btn-primary btn-lg px-4 py-2"
                disabled={loginLoading}
                style={{ fontSize: '1.1rem', fontWeight: '600' }}
              >
                {loginLoading ? 'Signing in...' : 'Demo Login'}
              </button>
              <button 
                onClick={handleDemoAdminLogin} 
                className="btn btn-outline-light btn-lg px-4 py-2"
                disabled={loginLoading}
                style={{ fontSize: '1.1rem', fontWeight: '600' }}
              >
                {loginLoading ? 'Signing in...' : 'Demo Admin'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Landing;


