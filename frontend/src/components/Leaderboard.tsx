import React, { useState, useEffect } from 'react';
import { gamificationApi, gamificationUtils, LeaderboardEntry } from '../api/gamification';
import LoadingSpinner from './LoadingSpinner';
import { AlertTriangle, Trophy, Calendar, CalendarRange } from 'lucide-react';

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
    } catch (err: any) {
      console.error('Error loading leaderboards:', err);
      const errorMessage = err?.response?.data?.error || 
                           err?.response?.statusText || 
                           err?.message || 
                           'Failed to load leaderboards';
      setError(errorMessage);
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
    const isTopThree = entry.rank <= 3;

    return (
      <div 
        key={entry.user_id} 
        className="d-flex align-items-center p-3 border rounded mb-2"
        style={{ 
          backgroundColor: isTopThree ? 'rgba(255, 78, 80, 0.1)' : 'transparent',
          borderColor: isTopThree ? 'var(--brand-headline)' : 'var(--border-card)',
          borderWidth: isTopThree ? '2px' : '1px',
          borderRadius: 'var(--card-radius)',
          transition: 'all var(--transition-card)'
        }}
      >
        {/* Rank */}
        <div className="me-3 text-center" style={{ minWidth: '50px' }}>
          <div 
            className="fw-bold fs-5"
            style={{ 
              color: isTopThree ? 'var(--brand-headline)' : 'var(--text-primary)',
              fontSize: 'var(--font-size-h3)',
              fontWeight: 'var(--font-weight-h3)'
            }}
          >
            {getRankIcon(entry.rank)}
          </div>
        </div>

        {/* User Info */}
        <div className="flex-grow-1">
          <div className="d-flex justify-content-between align-items-center">
            <div>
              <h6 className="mb-1 fw-bold" style={{ 
                color: 'var(--text-primary)', 
                fontSize: 'var(--font-size-body)',
                fontWeight: 'var(--font-weight-card-title)'
              }}>{entry.name}</h6>
              <div className="d-flex align-items-center">
              </div>
            </div>
            <div className="text-end">
              <div className="fw-bold fs-5" style={{ 
                color: 'var(--brand-headline)', 
                fontSize: 'var(--font-size-h3)',
                fontWeight: 'var(--font-weight-h3)'
              }}>
                {gamificationUtils.formatPoints(points)}
              </div>
              <small style={{ 
                color: 'var(--text-muted)', 
                fontSize: 'var(--font-size-metadata)'
              }}>
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
      <div className="alert alert-danger" role="alert" style={{ 
        background: 'rgba(220, 53, 69, 0.1)', 
        border: '1px solid rgba(220, 53, 69, 0.3)', 
        borderRadius: 'var(--card-radius)',
        color: '#dc3545',
        padding: 'var(--card-padding)'
      }}>
        <AlertTriangle size={18} className="me-2" />
        {error}
      </div>
    );
  }

  const currentLeaderboard = activeTab === 'total' ? leaderboard : monthlyLeaderboard;

  return (
    <div className="card">
      <div className="card-header">
        <div className="d-flex justify-content-between align-items-center">
          <h5 className="mb-0 d-flex align-items-center">
            <Trophy size={20} className="me-2" />
            AdaptaBits Leaderboard
          </h5>
          <div className="btn-group" role="group">
            <button
              type="button"
              className={`btn btn-sm ${activeTab === 'monthly' ? 'btn-primary' : 'btn-outline-primary'}`}
              onClick={() => setActiveTab('monthly')}
            >
              <Calendar size={14} className="me-1" />
              This Month
            </button>
            <button
              type="button"
              className={`btn btn-sm ${activeTab === 'total' ? 'btn-primary' : 'btn-outline-primary'}`}
              onClick={() => setActiveTab('total')}
            >
              <CalendarRange size={14} className="me-1" />
              All Time
            </button>
          </div>
        </div>
      </div>
      <div className="card-body">
        {currentLeaderboard.length === 0 ? (
          <div className="text-center py-4" style={{ color: 'var(--text-muted)' }}>
            <Trophy size={48} className="mb-3 d-block" style={{ color: 'var(--text-muted)' }} />
            <p style={{ color: 'var(--text-body)', fontSize: 'var(--font-size-body)' }}>No participants yet!</p>
            <small style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>Be the first to complete a session and appear on the leaderboard.</small>
          </div>
        ) : (
          <div>
            {/* Top 3 Podium */}
            {currentLeaderboard.length >= 3 && (
              <div className="row mb-5">
                <div className="col-4 text-center">
                  <div className="podium-place" style={{ height: '80px', paddingBottom: '20px' }}>
                    <div className="fs-1">🥇</div>
                    <div className="fw-bold" style={{ color: 'var(--text-primary)', fontSize: 'var(--font-size-body)', fontWeight: 'var(--font-weight-card-title)' }}>{currentLeaderboard[0]?.name}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>
                      {gamificationUtils.formatPoints(activeTab === 'total' ? currentLeaderboard[0]?.total_points : currentLeaderboard[0]?.monthly_points)}
                    </div>
                  </div>
                </div>
                <div className="col-4 text-center">
                  <div className="podium-place" style={{ height: '60px', paddingBottom: '20px' }}>
                    <div className="fs-1">🥈</div>
                    <div className="fw-bold" style={{ color: 'var(--text-primary)', fontSize: 'var(--font-size-body)', fontWeight: 'var(--font-weight-card-title)' }}>{currentLeaderboard[1]?.name}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>
                      {gamificationUtils.formatPoints(activeTab === 'total' ? currentLeaderboard[1]?.total_points : currentLeaderboard[1]?.monthly_points)}
                    </div>
                  </div>
                </div>
                <div className="col-4 text-center">
                  <div className="podium-place" style={{ height: '40px', paddingBottom: '20px' }}>
                    <div className="fs-1">🥉</div>
                    <div className="fw-bold" style={{ color: 'var(--text-primary)', fontSize: 'var(--font-size-body)', fontWeight: 'var(--font-weight-card-title)' }}>{currentLeaderboard[2]?.name}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>
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
