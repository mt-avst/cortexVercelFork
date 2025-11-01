import React, { useState, useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getNotificationPreferences, updateNotificationPreferences, NotificationPreference } from '../api/client';

const Settings: React.FC = () => {
  const { user, loading, initialAuthCheck } = useAuth();
  const navigate = useNavigate();
  const [preferences, setPreferences] = useState<NotificationPreference | null>(null);
  const [loadingPrefs, setLoadingPrefs] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (user) {
      loadPreferences();
    }
  }, [user]);

  const loadPreferences = async () => {
    try {
      setLoadingPrefs(true);
      setError('');
      const prefs = await getNotificationPreferences();
      setPreferences(prefs);
    } catch (err: any) {
      console.error('Error loading notification preferences:', err);
      setError('Failed to load notification preferences');
    } finally {
      setLoadingPrefs(false);
    }
  };

  const handleToggle = async (field: 'on_book_email' | 'on_cancel_email') => {
    if (!preferences) return;

    const newValue = !preferences[field];
    const updatedPrefs = { ...preferences, [field]: newValue };

    try {
      setSaving(true);
      setError('');
      setSuccess(false);
      
      const saved = await updateNotificationPreferences({
        on_book_email: updatedPrefs.on_book_email,
        on_cancel_email: updatedPrefs.on_cancel_email
      });
      
      setPreferences(saved);
      setSuccess(true);
      
      // Clear success message after 3 seconds
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      console.error('Error updating notification preferences:', err);
      setError('Failed to save notification preferences');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !initialAuthCheck) {
    return <div className="container-fluid" style={{ minHeight: '100vh', padding: '2rem' }}>
      <div className="card text-center">Loading...</div>
    </div>;
  }

  if (!user) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="container-fluid" style={{ minHeight: '100vh', padding: '2rem' }}>
      <div className="row">
        <div className="col-12 col-lg-8 col-xl-6 mx-auto">
          <div className="card">
            <div className="card-header d-flex justify-content-between align-items-center">
              <div>
                <button 
                  className="btn btn-link text-decoration-none p-0 mb-2"
                  onClick={() => navigate('/admin')}
                  style={{ color: '#6c757d' }}
                >
                  <i className="bi bi-arrow-left me-2"></i>
                  Back to Dashboard
                </button>
                <h1 className="h4 mb-0">Settings</h1>
              </div>
            </div>
            
            <div className="card-body">
              {loadingPrefs ? (
                <div className="text-center py-4">
                  <div className="spinner-border text-primary" role="status">
                    <span className="visually-hidden">Loading...</span>
                  </div>
                </div>
              ) : error && !preferences ? (
                <div className="alert alert-danger">
                  <i className="bi bi-exclamation-triangle me-2"></i>
                  {error}
                  <button 
                    className="btn btn-sm btn-outline-danger ms-3"
                    onClick={loadPreferences}
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <>
                  {success && (
                    <div className="alert alert-success alert-dismissible fade show" role="alert">
                      <i className="bi bi-check-circle me-2"></i>
                      Settings saved successfully!
                      <button 
                        type="button" 
                        className="btn-close" 
                        onClick={() => setSuccess(false)}
                        aria-label="Close"
                      ></button>
                    </div>
                  )}

                  {error && (
                    <div className="alert alert-danger alert-dismissible fade show" role="alert">
                      <i className="bi bi-exclamation-triangle me-2"></i>
                      {error}
                      <button 
                        type="button" 
                        className="btn-close" 
                        onClick={() => setError('')}
                        aria-label="Close"
                      ></button>
                    </div>
                  )}

                  <div className="mb-4">
                    <h2 className="h5 mb-3">Notification Preferences</h2>
                    <p className="text-muted mb-4">
                      Control when you receive email notifications for bookings and cancellations in your research studies.
                    </p>

                    {preferences && (
                      <div className="list-group">
                        <div className="list-group-item">
                          <div className="d-flex justify-content-between align-items-center">
                            <div className="flex-grow-1">
                              <h6 className="mb-1">
                                <i className="bi bi-envelope-check me-2 text-primary"></i>
                                Email on Booking
                              </h6>
                              <small className="text-muted">
                                Receive an email notification when someone books a session in your research studies.
                              </small>
                            </div>
                            <div className="form-check form-switch ms-3">
                              <input
                                className="form-check-input"
                                type="checkbox"
                                id="toggleBookEmail"
                                checked={preferences.on_book_email}
                                onChange={() => handleToggle('on_book_email')}
                                disabled={saving}
                                style={{ width: '3rem', height: '1.5rem', cursor: saving ? 'not-allowed' : 'pointer' }}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="list-group-item">
                          <div className="d-flex justify-content-between align-items-center">
                            <div className="flex-grow-1">
                              <h6 className="mb-1">
                                <i className="bi bi-envelope-x me-2 text-danger"></i>
                                Email on Cancellation
                              </h6>
                              <small className="text-muted">
                                Receive an email notification when someone cancels a booking in your research studies.
                              </small>
                            </div>
                            <div className="form-check form-switch ms-3">
                              <input
                                className="form-check-input"
                                type="checkbox"
                                id="toggleCancelEmail"
                                checked={preferences.on_cancel_email}
                                onChange={() => handleToggle('on_cancel_email')}
                                disabled={saving}
                                style={{ width: '3rem', height: '1.5rem', cursor: saving ? 'not-allowed' : 'pointer' }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {saving && (
                      <div className="mt-3 text-center">
                        <div className="spinner-border spinner-border-sm text-primary me-2" role="status">
                          <span className="visually-hidden">Saving...</span>
                        </div>
                        <small className="text-muted">Saving...</small>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;

