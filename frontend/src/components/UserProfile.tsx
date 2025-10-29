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
      const errorMessage = err?.response?.data?.error || 
                           err?.response?.statusText || 
                           err?.message || 
                           'Failed to load profile data';
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
      <div className="alert alert-danger" role="alert">
        <i className="bi bi-exclamation-triangle me-2"></i>
        {error}
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="alert alert-info" role="alert">
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
                  <div className="text-center p-3 border rounded">
                    <h2 className="text-primary mb-1">
                      {gamificationUtils.formatPoints(profile.total_points)}
                    </h2>
                    <p className="text-muted mb-0">Total AdaptaBits</p>
                  </div>
                </div>
                <div className="col-md-6">
                  <div className="text-center p-3 border rounded">
                    <h2 className="text-success mb-1">
                      {gamificationUtils.formatPoints(profile.monthly_points)}
                    </h2>
                    <p className="text-muted mb-0">This Month</p>
                  </div>
                </div>
              </div>

              {/* Activity Stats */}
              <div className="row">
                <div className="col-md-3 col-6 mb-3">
                  <div className="text-center">
                    <div className="fs-3 text-primary">{profile.sessions_completed}</div>
                    <small className="text-muted">Tests</small>
                  </div>
                </div>
                <div className="col-md-3 col-6 mb-3">
                  <div className="text-center">
                    <div className="fs-3 text-info">{profile.surveys_completed}</div>
                    <small className="text-muted">Surveys</small>
                  </div>
                </div>
                <div className="col-md-3 col-6 mb-3">
                  <div className="text-center">
                    <div className="fs-3 text-warning">{profile.polls_completed}</div>
                    <small className="text-muted">Polls</small>
                  </div>
                </div>
                <div className="col-md-3 col-6 mb-3">
                  <div className="text-center">
                    <div className="fs-3 text-success">{profile.questions_completed}</div>
                    <small className="text-muted">Questions</small>
                  </div>
                </div>
              </div>

              {/* Last Activity */}
              {profile.last_activity_date && (
                <div className="mt-3 pt-3 border-top">
                  <small className="text-muted">
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
                <p className="text-muted mb-3">{getCurrentMonth()}</p>
                
                {/* Placeholder for image */}
                <div className="bg-light border rounded d-flex align-items-center justify-content-center mb-3" style={{ height: '150px', minHeight: '150px' }}>
                  <i className="bi bi-image fs-1 text-secondary"></i>
                </div>
                
                {/* Two lines of placeholder text */}
                <div className="text-center">
                  <p className="mb-1 text-muted" style={{ minHeight: '20px' }}>
                    {/* Placeholder line 1 */}
                  </p>
                  <p className="text-muted mb-0" style={{ minHeight: '20px' }}>
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
