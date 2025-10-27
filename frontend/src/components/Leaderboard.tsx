import React, { useState, useEffect } from 'react';
import { gamificationApi, gamificationUtils, LeaderboardEntry } from '../api/gamification';
import LoadingSpinner from './LoadingSpinner';

interface LeaderboardProps {
  limit?: number;
}

const Leaderboard: React.FC<LeaderboardProps> = ({ limit = 10 }) => {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [monthlyLeaderboard, setMonthlyLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [activeTab, setActiveTab] = useState<'total' | 'monthly'>('monthly');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadLeaderboards();
  }, [limit]);

  const loadLeaderboards = async () => {
    try {
      setLoading(true);
      setError(null);

      const [totalData, monthlyData] = await Promise.all([
        gamificationApi.getLeaderboard(limit),
        gamificationApi.getMonthlyLeaderboard(limit)
      ]);

      setLeaderboard(totalData);
      setMonthlyLeaderboard(monthlyData);
    } catch (err) {
      console.error('Error loading leaderboards:', err);
      setError('Failed to load leaderboards');
    } finally {
      setLoading(false);
    }
  };

  const getRankIcon = (rank: number): string => {
    switch (rank) {
      case 1:
        return '🥇';
      case 2:
        return '🥈';
      case 3:
        return '🥉';
      default:
        return `#${rank}`;
    }
  };

  const getRankColor = (rank: number): string => {
    switch (rank) {
      case 1:
        return '#ffd700'; // Gold
      case 2:
        return '#c0c0c0'; // Silver
      case 3:
        return '#cd7f32'; // Bronze
      default:
        return '#6c757d'; // Gray
    }
  };

  const renderLeaderboardEntry = (entry: LeaderboardEntry, index: number) => {
    const points = activeTab === 'total' ? entry.total_points : entry.monthly_points;

    return (
      <div 
        key={entry.user_id} 
        className={`d-flex align-items-center p-3 border rounded mb-2 ${
          entry.rank <= 3 ? 'border-warning' : ''
        }`}
        style={{ 
          backgroundColor: entry.rank <= 3 ? '#fff3cd' : 'white',
          borderWidth: entry.rank <= 3 ? '2px' : '1px'
        }}
      >
        {/* Rank */}
        <div className="me-3 text-center" style={{ minWidth: '50px' }}>
          <div 
            className="fw-bold fs-5"
            style={{ color: getRankColor(entry.rank) }}
          >
            {getRankIcon(entry.rank)}
          </div>
        </div>

        {/* User Info */}
        <div className="flex-grow-1">
          <div className="d-flex justify-content-between align-items-center">
            <div>
              <h6 className="mb-1 fw-bold">{entry.name}</h6>
              <div className="d-flex align-items-center">
              </div>
            </div>
            <div className="text-end">
              <div className="fw-bold fs-5 text-primary">
                {gamificationUtils.formatPoints(points)}
              </div>
              <small className="text-muted">
                {activeTab === 'total' ? 'Total AdaptaBits' : 'Monthly AdaptaBits'}
              </small>
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '200px' }}>
        <LoadingSpinner size="medium" text="Loading leaderboard..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="alert alert-danger" role="alert">
        <i className="bi bi-exclamation-triangle me-2"></i>
        {error}
      </div>
    );
  }

  const currentLeaderboard = activeTab === 'total' ? leaderboard : monthlyLeaderboard;

  return (
    <div className="card">
      <div className="card-header">
        <div className="d-flex justify-content-between align-items-center">
          <h5 className="mb-0">
            <i className="bi bi-trophy me-2"></i>
            AdaptaBits Leaderboard
          </h5>
          <div className="btn-group" role="group">
            <button
              type="button"
              className={`btn btn-sm ${activeTab === 'monthly' ? 'btn-primary' : 'btn-outline-primary'}`}
              onClick={() => setActiveTab('monthly')}
            >
              <i className="bi bi-calendar-month me-1"></i>
              This Month
            </button>
            <button
              type="button"
              className={`btn btn-sm ${activeTab === 'total' ? 'btn-primary' : 'btn-outline-primary'}`}
              onClick={() => setActiveTab('total')}
            >
              <i className="bi bi-calendar-range me-1"></i>
              All Time
            </button>
          </div>
        </div>
      </div>
      <div className="card-body">
        {currentLeaderboard.length === 0 ? (
          <div className="text-center text-muted py-4">
            <i className="bi bi-trophy fs-1 mb-3 d-block"></i>
            <p>No participants yet!</p>
            <small>Be the first to complete a session and appear on the leaderboard.</small>
          </div>
        ) : (
          <div>
            {/* Top 3 Podium */}
            {currentLeaderboard.length >= 3 && (
              <div className="row mb-5">
                <div className="col-4 text-center">
                  <div className="podium-place" style={{ height: '80px', paddingBottom: '20px' }}>
                    <div className="fs-1">🥇</div>
                    <div className="fw-bold">{currentLeaderboard[0]?.name}</div>
                    <div className="text-muted small">
                      {gamificationUtils.formatPoints(activeTab === 'total' ? currentLeaderboard[0]?.total_points : currentLeaderboard[0]?.monthly_points)}
                    </div>
                  </div>
                </div>
                <div className="col-4 text-center">
                  <div className="podium-place" style={{ height: '60px', paddingBottom: '20px' }}>
                    <div className="fs-1">🥈</div>
                    <div className="fw-bold">{currentLeaderboard[1]?.name}</div>
                    <div className="text-muted small">
                      {gamificationUtils.formatPoints(activeTab === 'total' ? currentLeaderboard[1]?.total_points : currentLeaderboard[1]?.monthly_points)}
                    </div>
                  </div>
                </div>
                <div className="col-4 text-center">
                  <div className="podium-place" style={{ height: '40px', paddingBottom: '20px' }}>
                    <div className="fs-1">🥉</div>
                    <div className="fw-bold">{currentLeaderboard[2]?.name}</div>
                    <div className="text-muted small">
                      {gamificationUtils.formatPoints(activeTab === 'total' ? currentLeaderboard[2]?.total_points : currentLeaderboard[2]?.monthly_points)}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Full Leaderboard */}
            <div className="leaderboard-list">
              {currentLeaderboard.map((entry, index) => renderLeaderboardEntry(entry, index))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Leaderboard;
