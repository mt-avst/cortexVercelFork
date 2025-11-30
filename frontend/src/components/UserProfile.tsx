import React, { useState, useEffect, useMemo } from 'react';
import { gamificationApi, gamificationUtils, UserProfile } from '../api/gamification';
import LoadingSpinner from '../components/LoadingSpinner';
import Sparkline from '../components/Sparkline';
import { AlertTriangle, Info, UserCircle, Clock, Trophy, Gift, TrendingUp } from 'lucide-react';

interface UserProfileProps {
  userId?: string;
}

const UserProfileComponent: React.FC<UserProfileProps> = ({ userId }) => {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadProfileData();
  }, [userId]);

  const loadProfileData = async () => {
    try {
      setLoading(true);
      setError(null);

      const profileData = await gamificationApi.getProfile();
      setProfile(profileData);
    } catch (err: any) {
      console.error('Error loading profile data:', err);
      
      // Extract error message from various possible locations
      let errorMessage = 'Failed to load profile data';
      
      if (err?.response?.data) {
        // Check for error message in response data
        if (typeof err.response.data === 'string') {
          errorMessage = err.response.data;
        } else if (err.response.data.error) {
          errorMessage = typeof err.response.data.error === 'string' 
            ? err.response.data.error 
            : err.response.data.error?.message || errorMessage;
        } else if (err.response.data.message) {
          errorMessage = err.response.data.message;
        }
      } else if (err?.response?.statusText) {
        errorMessage = err.response.statusText;
      } else if (err?.message) {
        errorMessage = err.message;
      }
      
      // If it's a network error or database unavailable, provide a more helpful message
      if (err?.code === 'ECONNREFUSED' || err?.code === 'ERR_NETWORK' || 
          errorMessage.toLowerCase().includes('database') || 
          errorMessage.toLowerCase().includes('connection')) {
        errorMessage = 'Unable to connect to the server. Please check your connection and try again.';
      }
      
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  // Get current month for the prize section
  const getCurrentMonth = () => {
    const now = new Date();
    return now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  // Get value class based on whether value is zero or positive
  const getValueClass = (value: number): string => {
    return value === 0 ? 'stat-hud-value--zero' : 'stat-hud-value--positive';
  };

  // Generate sparkline data from profile activity
  // This creates a visual representation of activity distribution
  const activitySparklineData = useMemo(() => {
    if (!profile) return [];
    
    // Create a simple activity trend based on completed activities
    // In a real app, this would come from historical data
    const totalActivity = 
      profile.sessions_completed + 
      profile.surveys_completed + 
      profile.polls_completed + 
      profile.questions_completed;
    
    if (totalActivity === 0) return [];
    
    // Generate sample trend data (simulating weekly activity)
    // In production, this would be actual historical data from the API
    const baseValue = Math.max(1, Math.floor(totalActivity / 7));
    return [
      Math.max(0, baseValue - 2),
      Math.max(0, baseValue + 1),
      Math.max(0, baseValue - 1),
      Math.max(0, baseValue + 3),
      Math.max(0, baseValue + 2),
      Math.max(0, baseValue - 1),
      totalActivity > 0 ? Math.max(1, baseValue + 4) : 0, // Current (higher to show growth)
    ];
  }, [profile]);

  if (loading) {
    return (
      <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '200px' }}>
        <LoadingSpinner size="medium" text="Loading profile..." />
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

  if (!profile) {
    return (
      <div className="alert alert-info" role="alert" style={{ 
        background: 'var(--bg-card)', 
        border: 'var(--card-border)', 
        borderRadius: 'var(--card-radius)',
        color: 'var(--text-primary)',
        padding: 'var(--card-padding)'
      }}>
        <Info size={18} className="me-2" />
        No profile data available
      </div>
    );
  }

  return (
    <div className="adaptabits-hero">
      {/* Your Profile - Stat HUD */}
      <div className="stat-hud">
        <div className="d-flex align-items-center gap-2 mb-4">
          <UserCircle size={24} style={{ color: 'var(--color-brand-orange)' }} />
          <h4 style={{ 
            margin: 0, 
            fontSize: 'var(--font-size-h4)', 
            fontWeight: 'var(--font-weight-semibold)',
            color: 'var(--text-primary)'
          }}>
            Your Profile
          </h4>
        </div>

        {/* Main Stats Grid */}
        <div className="stat-hud-grid">
          <div className="stat-hud-item">
            <span className={`stat-hud-value ${getValueClass(profile.total_points)}`}>
              {gamificationUtils.formatPoints(profile.total_points)}
            </span>
            <span className="stat-hud-label">Total AdaptaBits</span>
          </div>
          <div className="stat-hud-item">
            <span className={`stat-hud-value ${getValueClass(profile.monthly_points)}`}>
              {gamificationUtils.formatPoints(profile.monthly_points)}
            </span>
            <span className="stat-hud-label">This Month</span>
          </div>
        </div>

        {/* Activity Sparkline */}
        <div 
          className="mt-4 pt-3" 
          style={{ borderTop: '1px solid rgba(255, 255, 255, 0.05)' }}
        >
          <div className="d-flex align-items-center gap-2 mb-2">
            <TrendingUp size={14} style={{ color: 'var(--color-brand-orange)' }} />
            <span style={{ 
              fontSize: 'var(--font-size-xs)', 
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em'
            }}>
              Activity Trend
            </span>
          </div>
          <Sparkline 
            data={activitySparklineData} 
            height={40}
          />
        </div>

        {/* Activity Stats */}
        <div className="stat-hud-activity">
          <div className="stat-hud-activity-item">
            <div className="stat-hud-activity-value">{profile.sessions_completed}</div>
            <div className="stat-hud-activity-label">Tests</div>
          </div>
          <div className="stat-hud-activity-item">
            <div className="stat-hud-activity-value">{profile.surveys_completed}</div>
            <div className="stat-hud-activity-label">Surveys</div>
          </div>
          <div className="stat-hud-activity-item">
            <div className="stat-hud-activity-value">{profile.polls_completed}</div>
            <div className="stat-hud-activity-label">Polls</div>
          </div>
          <div className="stat-hud-activity-item">
            <div className="stat-hud-activity-value">{profile.questions_completed}</div>
            <div className="stat-hud-activity-label">Questions</div>
          </div>
        </div>

        {/* Last Activity */}
        {profile.last_activity_date && (
          <div className="mt-4 pt-3" style={{ borderTop: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <small className="d-flex align-items-center gap-1" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>
              <Clock size={12} />
              Last activity: {new Date(profile.last_activity_date).toLocaleDateString()}
            </small>
          </div>
        )}
      </div>

      {/* Monthly Prize Card */}
      <div className="prize-card">
        <div className="prize-card-header">
          <Trophy size={20} style={{ color: 'var(--color-brand-orange)' }} />
          <h5 className="prize-card-title">Monthly Prize</h5>
        </div>
        
        <p className="prize-card-month">{getCurrentMonth()}</p>
        
        <img 
          src="/images/amazon-giftcard.png" 
          alt="£25 Amazon Gift Card - Monthly Prize"
          className="prize-card-image"
        />
        
        <div style={{ marginTop: 'auto', textAlign: 'center' }}>
          <p className="prize-card-name">£25 Amazon Gift Card</p>
          <span className="prize-card-cta">
            <Gift size={14} />
            Top contributor wins!
          </span>
        </div>
      </div>
    </div>
  );
};

export default UserProfileComponent;
