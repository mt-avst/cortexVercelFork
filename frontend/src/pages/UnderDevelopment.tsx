import React from 'react';
import { Link } from 'react-router-dom';

/**
 * Under Development Page
 * Placeholder page for features that are currently being developed
 */
const UnderDevelopment: React.FC = () => {
  return (
    <div className="container-fluid py-5" style={{ backgroundColor: '#0A091A', minHeight: '100vh' }}>
      <div className="row justify-content-center">
        <div className="col-12 col-md-8 col-lg-6">
          <div 
            className="card shadow-sm border-0"
            style={{
              background: 'rgba(255, 255, 255, 0.05)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '16px',
              padding: '48px'
            }}
          >
            <div className="text-center">
              <div style={{ fontSize: '72px', marginBottom: '24px' }}>
                🔨
              </div>
              <h1 
                className="mb-3"
                style={{ 
                  fontSize: '36px', 
                  fontWeight: 700, 
                  color: '#E0E0E0',
                  lineHeight: 1.25
                }}
              >
                Under Development
              </h1>
              <p 
                className="mb-4"
                style={{ 
                  fontSize: '15px', 
                  color: 'rgba(224, 224, 224, 0.7)',
                  lineHeight: 1.6
                }}
              >
                We're working hard to bring you this feature. Check back soon!
              </p>
              <Link 
                to="/"
                className="btn btn-primary"
                style={{
                  backgroundColor: 'transparent',
                  border: '1px solid #FF4E50',
                  color: '#FF4E50',
                  borderRadius: '6px',
                  padding: '10px 20px',
                  fontWeight: 600,
                  fontSize: '15px',
                  minHeight: '40px',
                  textDecoration: 'none',
                  display: 'inline-block',
                  transition: 'all 0.2s ease-in-out',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#FF4E50';
                  e.currentTarget.style.color = '#FFFFFF';
                  e.currentTarget.style.boxShadow = '0 4px 10px rgba(0,0,0,0.22)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.color = '#FF4E50';
                  e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
                }}
              >
                Back to Home
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UnderDevelopment;

