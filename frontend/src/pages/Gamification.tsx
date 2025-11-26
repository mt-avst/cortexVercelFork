import React from 'react';
import UserProfileComponent from '../components/UserProfile';
import Leaderboard from '../components/Leaderboard';

const GamificationPage: React.FC = () => {
  return (
    <div className="container-fluid py-4" style={{ position: 'relative', zIndex: 10 }}>
      <div className="row mb-4">
        <div className="col-12">
          <div className="d-flex justify-content-between align-items-center">
            <h1 className="mb-0 adaptabits-page-title" style={{ color: '#FF4E50', fontSize: 'var(--font-size-h1)', fontWeight: 'var(--font-weight-h1)', lineHeight: 'var(--line-height-heading)' }}>
              <i className="bi bi-trophy me-2"></i>
              AdaptaBits
            </h1>
          </div>
        </div>
      </div>

      {/* User Profile */}
      <div className="row">
        <div className="col-12">
          <UserProfileComponent />
        </div>
      </div>

      {/* Leaderboard */}
      <div className="row mt-4">
        <div className="col-12">
          <Leaderboard limit={20} />
        </div>
      </div>
    </div>
  );
};

export default GamificationPage;
