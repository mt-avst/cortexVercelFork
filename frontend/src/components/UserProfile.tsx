import React, { useState, useEffect } from 'react';
import { gamificationApi, gamificationUtils, UserProfile } from '../api/gamification';
import LoadingSpinner from '../components/LoadingSpinner';

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
        <i className="bi bi-exclamation-triangle me-2"></i>
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
        <i className="bi bi-info-circle me-2"></i>
        No profile data available
      </div>
    );
  }


  return (
    <div className="container-fluid py-4">
      <div className="row">
        {/* Main Profile Card */}
        <div className="col-lg-8">
          <div className="card h-100">
            <div className="card-header d-flex justify-content-between align-items-center">
              <h4 className="mb-0">
                <i className="bi bi-person-circle me-2"></i>
                Your Profile
              </h4>
            </div>
            <div className="card-body">
              {/* AdaptaBits Overview */}
              <div className="row mb-4">
                <div className="col-md-6">
                  <div className="text-center p-3 border rounded" style={{ 
                    borderColor: 'var(--border-card)', 
                    borderRadius: 'var(--card-radius)',
                    background: 'rgba(255, 255, 255, 0.02)'
                  }}>
                    <h2 className="mb-1" style={{ color: 'var(--brand-headline)', fontSize: 'var(--font-size-h2)', fontWeight: 'var(--font-weight-h2)' }}>
                      {gamificationUtils.formatPoints(profile.total_points)}
                    </h2>
                    <p className="mb-0" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>Total AdaptaBits</p>
                  </div>
                </div>
                <div className="col-md-6">
                  <div className="text-center p-3 border rounded" style={{ 
                    borderColor: 'var(--border-card)', 
                    borderRadius: 'var(--card-radius)',
                    background: 'rgba(255, 255, 255, 0.02)'
                  }}>
                    <h2 className="mb-1" style={{ color: 'var(--brand-headline)', fontSize: 'var(--font-size-h2)', fontWeight: 'var(--font-weight-h2)' }}>
                      {gamificationUtils.formatPoints(profile.monthly_points)}
                    </h2>
                    <p className="mb-0" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>This Month</p>
                  </div>
                </div>
              </div>

              {/* Activity Stats */}
              <div className="row">
                <div className="col-md-3 col-6 mb-3">
                  <div className="text-center">
                    <div className="fs-3" style={{ color: 'var(--brand-headline)', fontSize: 'var(--font-size-h3)', fontWeight: 'var(--font-weight-h3)' }}>{profile.sessions_completed}</div>
                    <small style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>Tests</small>
                  </div>
                </div>
                <div className="col-md-3 col-6 mb-3">
                  <div className="text-center">
                    <div className="fs-3" style={{ color: 'var(--link)', fontSize: 'var(--font-size-h3)', fontWeight: 'var(--font-weight-h3)' }}>{profile.surveys_completed}</div>
                    <small style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>Surveys</small>
                  </div>
                </div>
                <div className="col-md-3 col-6 mb-3">
                  <div className="text-center">
                    <div className="fs-3" style={{ color: 'var(--link-hover)', fontSize: 'var(--font-size-h3)', fontWeight: 'var(--font-weight-h3)' }}>{profile.polls_completed}</div>
                    <small style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>Polls</small>
                  </div>
                </div>
                <div className="col-md-3 col-6 mb-3">
                  <div className="text-center">
                    <div className="fs-3" style={{ color: 'var(--brand-headline)', fontSize: 'var(--font-size-h3)', fontWeight: 'var(--font-weight-h3)' }}>{profile.questions_completed}</div>
                    <small style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>Questions</small>
                  </div>
                </div>
              </div>

              {/* Last Activity */}
              {profile.last_activity_date && (
                <div className="mt-3 pt-3 border-top" style={{ borderColor: 'var(--border-card)' }}>
                  <small style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>
                    <i className="bi bi-clock me-1"></i>
                    Last activity: {new Date(profile.last_activity_date).toLocaleDateString()}
                  </small>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* This Month's AdaptaBits Prize */}
        <div className="col-lg-4">
          <div className="card h-100">
            <div className="card-header">
              <h5 className="mb-0">
                <i className="bi bi-trophy me-2"></i>
                This Month's AdaptaBits Prize
              </h5>
            </div>
            <div className="card-body">
              <div className="text-center">
                <p className="mb-3" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>{getCurrentMonth()}</p>
                
                {/* Placeholder for image */}
                <div className="border rounded d-flex align-items-center justify-content-center mb-3" style={{ 
                  height: '150px', 
                  minHeight: '150px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderColor: 'var(--border-card)',
                  borderRadius: 'var(--card-radius)'
                }}>
                  <i className="bi bi-image fs-1" style={{ color: 'var(--text-muted)' }}></i>
                </div>
                
                {/* Two lines of placeholder text */}
                <div className="text-center">
                  <p className="mb-1" style={{ minHeight: '20px', color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>
                    {/* Placeholder line 1 */}
                  </p>
                  <p className="mb-0" style={{ minHeight: '20px', color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>
                    {/* Placeholder line 2 */}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserProfileComponent;
