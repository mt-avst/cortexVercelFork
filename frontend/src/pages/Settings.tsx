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
    return <div className="container-fluid" style={{ minHeight: '100vh', padding: '2rem', backgroundColor: '#0A091A' }}>
      <div className="card text-center" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>Loading...</div>
    </div>;
  }

  if (!user) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="container-fluid" style={{ minHeight: '100vh', padding: '2rem', backgroundColor: '#0A091A' }}>
      <style>
        {`
          .settings-page .card {
            background: var(--bg-card) !important;
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: var(--card-border) !important;
            border-radius: var(--card-radius) !important;
            box-shadow: var(--shadow-card) !important;
          }
          .settings-page .card-header {
            background-color: transparent !important;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1) !important;
          }
          .settings-page .card-body {
            background-color: transparent !important;
          }
          .settings-page h1,
          .settings-page h2,
          .settings-page h5,
          .settings-page h6 {
            color: var(--text-primary) !important;
          }
          .settings-page p,
          .settings-page .text-muted {
            color: var(--text-muted) !important;
          }
          .settings-page .btn-link {
            color: var(--text-muted) !important;
          }
          .settings-page .btn-link:hover {
            color: var(--brand-headline) !important;
          }
          .settings-page .list-group-item {
            background-color: rgba(255, 255, 255, 0.05) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: var(--card-radius) !important;
            margin-bottom: 1rem;
            padding: var(--card-padding) !important;
          }
          .settings-page .list-group-item h6 {
            color: var(--text-primary) !important;
          }
          .settings-page .list-group-item small {
            color: var(--text-muted) !important;
          }
          /* Custom toggle switches - Momentum Design System (Red) */
          .settings-page .form-check-input {
            background-color: rgba(255, 255, 255, 0.2) !important;
            border-color: rgba(255, 255, 255, 0.3) !important;
            width: 3rem !important;
            height: 1.5rem !important;
          }
          .settings-page .form-check-input:checked {
            background-color: var(--brand-headline) !important;
            border-color: var(--brand-headline) !important;
          }
          .settings-page .form-check-input:focus {
            box-shadow: 0 0 0 0.2rem rgba(255, 78, 80, 0.25) !important;
          }
          .settings-page .bi-envelope-check,
          .settings-page .bi-envelope-x {
            color: var(--brand-headline) !important;
          }
          .settings-page .spinner-border {
            border-color: var(--brand-headline) !important;
            border-right-color: transparent !important;
          }
          /* Alerts - Momentum Design System */
          .settings-page .alert {
            background-color: rgba(255, 255, 255, 0.05) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: var(--card-radius) !important;
            color: var(--text-primary) !important;
          }
          .settings-page .alert-success {
            border-color: rgba(76, 175, 80, 0.3) !important;
          }
          .settings-page .alert-danger {
            border-color: rgba(244, 67, 54, 0.3) !important;
          }
          .settings-page .alert .btn-close {
            filter: invert(1);
          }
          .settings-page .btn-outline-danger {
            border-color: rgba(244, 67, 54, 0.5) !important;
            color: var(--text-primary) !important;
          }
          .settings-page .btn-outline-danger:hover {
            background-color: rgba(244, 67, 54, 0.2) !important;
            border-color: rgba(244, 67, 54, 0.7) !important;
          }
        `}
      </style>
      <div className="row settings-page">
        <div className="col-12 col-lg-8 col-xl-6 mx-auto">
          <div className="card">
            <div className="card-header d-flex justify-content-between align-items-center">
              <div>
                <button 
                  className="btn btn-link text-decoration-none p-0 mb-2"
                  onClick={() => navigate('/admin')}
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
                  <div className="spinner-border" role="status" style={{ borderColor: 'var(--brand-headline)', borderRightColor: 'transparent' }}>
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
                      <div className="list-group" style={{ backgroundColor: 'transparent' }}>
                        <div className="list-group-item">
                          <div className="d-flex justify-content-between align-items-center">
                            <div className="flex-grow-1">
                              <h6 className="mb-1" style={{ color: 'var(--text-primary)' }}>
                                <i className="bi bi-envelope-check me-2"></i>
                                Email on Booking
                              </h6>
                              <small style={{ color: 'var(--text-muted)' }}>
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
                                style={{ cursor: saving ? 'not-allowed' : 'pointer' }}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="list-group-item">
                          <div className="d-flex justify-content-between align-items-center">
                            <div className="flex-grow-1">
                              <h6 className="mb-1" style={{ color: 'var(--text-primary)' }}>
                                <i className="bi bi-envelope-x me-2"></i>
                                Email on Cancellation
                              </h6>
                              <small style={{ color: 'var(--text-muted)' }}>
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
                                style={{ cursor: saving ? 'not-allowed' : 'pointer' }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {saving && (
                      <div className="mt-3 text-center">
                        <div className="spinner-border spinner-border-sm me-2" role="status" style={{ borderColor: 'var(--brand-headline)', borderRightColor: 'transparent' }}>
                          <span className="visually-hidden">Saving...</span>
                        </div>
                        <small style={{ color: 'var(--text-muted)' }}>Saving...</small>
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

