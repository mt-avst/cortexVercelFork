import React from 'react';

const Landing: React.FC = () => {
  return (
    <div className="container py-5">
      <div className="row justify-content-center">
        <div className="col-12 col-md-8 col-lg-6 mx-auto" style={{ maxWidth: '720px' }}>
          <div className="mb-4">
            <h1 className="display-1 fw-bold" style={{ fontSize: 'clamp(3rem, 6vw, 5rem)', lineHeight: 1.1 }}>
              AdaptaLabs
            </h1>
            <p className="lead text-muted mt-3" style={{ fontSize: 'clamp(1.275rem, 2.38vw, 1.9125rem)' }}>
              Participate in research that shapes the future of our products. Browse opportunities, book
              sessions, and share feedback to help us build better experiences.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Landing;


