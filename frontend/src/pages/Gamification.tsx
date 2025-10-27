import React from 'react';
import UserProfileComponent from '../components/UserProfile';
import Leaderboard from '../components/Leaderboard';

const GamificationPage: React.FC = () => {
  return (
    <div className="container-fluid py-4">
      <div className="row mb-4">
        <div className="col-12">
          <div className="d-flex justify-content-between align-items-center">
            <h2 className="mb-0">
              <i className="bi bi-trophy me-2"></i>
              AdaptaBits
            </h2>
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
