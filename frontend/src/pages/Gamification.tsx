import React from 'react';
import UserProfileComponent from '../components/UserProfile';
import Leaderboard from '../components/Leaderboard';
import { Trophy } from 'lucide-react';

const GamificationPage: React.FC = () => {
  return (
    <div className="container-fluid py-4 gamification-page" style={{ position: 'relative', zIndex: 10 }}>
      <div className="row mb-4">
        <div className="col-12">
          <div className="d-flex justify-content-between align-items-center">
            <h1 className="mb-0 adaptabits-page-title">
              <Trophy size={32} className="me-2" />
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
