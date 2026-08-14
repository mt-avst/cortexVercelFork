import React, { useState, useEffect, useCallback } from 'react';
import { gamificationApi, gamificationUtils, LeaderboardEntry } from '../api/gamification';
import LoadingSpinner from './LoadingSpinner';
import { AlertTriangle, Trophy, Calendar, CalendarRange } from 'lucide-react';

interface LeaderboardProps {
  limit?: number;
}

const Leaderboard: React.FC<LeaderboardProps> = ({ limit = 20 }) => {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [monthlyLeaderboard, setMonthlyLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [activeTab, setActiveTab] = useState<'total' | 'monthly'>('monthly');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // useCallback BEFORE the effect can depend on it: as a plain function this
  // was rebuilt every render, so naming it in the dependency array without
  // memoising first would re-run the effect on every render, forever.
  const loadLeaderboards = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [totalData, monthlyData] = await Promise.all([
        gamificationApi.getLeaderboard(limit),
        gamificationApi.getMonthlyLeaderboard(limit)
      ]);

      setLeaderboard(totalData);
      setMonthlyLeaderboard(monthlyData);
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string }; statusText?: string }; message?: string };
      const errorMessage = axiosError?.response?.data?.error || 
                           axiosError?.response?.statusText || 
                           axiosError?.message || 
                           'Failed to load leaderboards';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    loadLeaderboards();
  }, [loadLeaderboards]);

  const getPoints = (entry: LeaderboardEntry) => {
    return activeTab === 'total' ? entry.total_points : entry.monthly_points;
  };

  // Get row class based on rank (ensure number comparison)
  const getRowClass = (rank: number): string => {
    const numRank = Number(rank);
    if (numRank === 1) return 'leaderboard-row rank-gold';
    if (numRank === 2) return 'leaderboard-row rank-silver';
    if (numRank === 3) return 'leaderboard-row rank-bronze';
    return 'leaderboard-row';
  };

  // Get medal icon for top 3 (ensure number comparison)
  const getMedalIcon = (rank: number): string | null => {
    const numRank = Number(rank);
    if (numRank === 1) return '🥇';
    if (numRank === 2) return '🥈';
    if (numRank === 3) return '🥉';
    return null;
  };

  // Get score class based on rank and points (ensure number comparison)
  const getScoreClass = (rank: number, points: number): string => {
    if (points === 0) return 'leaderboard-row-score--zero';
    const numRank = Number(rank);
    if (numRank === 1) return 'leaderboard-row-score--gold';
    if (numRank === 2) return 'leaderboard-row-score--silver';
    if (numRank === 3) return 'leaderboard-row-score--bronze';
    return '';
  };

  // Format score display - handle 0 points edge case for top ranks
  const formatScoreDisplay = (points: number, rank: number): string => {
    const numRank = Number(rank);
    if (points === 0 && numRank === 1) {
      return 'New Leader';
    }
    if (points === 0 && numRank <= 3) {
      return 'Starting';
    }
    return gamificationUtils.formatPoints(points);
  };

  const renderRow = (entry: LeaderboardEntry) => {
    const points = getPoints(entry);
    const medal = getMedalIcon(entry.rank);
    const isTopThree = Number(entry.rank) <= 3;
    const scoreDisplay = formatScoreDisplay(points, entry.rank);
    const showPtsLabel = isTopThree && points > 0;
    
    return (
      <div key={entry.user_id} className={getRowClass(entry.rank)}>
        {/* Rank */}
        <div className="leaderboard-row-rank">
          {medal ? (
            <span className="leaderboard-row-medal">{medal}</span>
          ) : (
            <span className="leaderboard-row-number">#{entry.rank}</span>
          )}
        </div>

        {/* Name with optional medal for mobile */}
        <div className="leaderboard-row-name" title={entry.name}>
          {entry.name}
        </div>

        {/* Score */}
        <div className={`leaderboard-row-score ${getScoreClass(entry.rank, points)}`}>
          {scoreDisplay}
          {showPtsLabel && <span className="leaderboard-row-unit">pts</span>}
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
    <div className="leaderboard-card">
      {/* Header with Tabs */}
      <div className="leaderboard-header">
        <h3 className="leaderboard-title">
          <Trophy size={24} style={{ color: 'var(--color-brand-orange)' }} />
          Leaderboard
        </h3>
        <div className="leaderboard-tabs">
          <button
            type="button"
            className={`leaderboard-tab ${activeTab === 'monthly' ? 'leaderboard-tab--active' : ''}`}
            onClick={() => setActiveTab('monthly')}
          >
            <Calendar size={14} />
            This Month
          </button>
          <button
            type="button"
            className={`leaderboard-tab ${activeTab === 'total' ? 'leaderboard-tab--active' : ''}`}
            onClick={() => setActiveTab('total')}
          >
            <CalendarRange size={14} />
            All Time
          </button>
        </div>
      </div>

      {/* Content - Unified List */}
      {currentLeaderboard.length === 0 ? (
        <div className="leaderboard-empty">
          <Trophy size={48} className="leaderboard-empty-icon" />
          <p className="leaderboard-empty-title">No participants yet!</p>
          <p className="leaderboard-empty-text">
            Be the first to complete a session and appear on the leaderboard.
          </p>
        </div>
      ) : (
        <div className="leaderboard-list">
          {currentLeaderboard.map(entry => renderRow(entry))}
        </div>
      )}
    </div>
  );
};

export default Leaderboard;
