import React, { useState, useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getNotificationPreferences, updateNotificationPreferences, NotificationPreference } from '../api/client';
import AdminManagement from '../components/AdminManagement';

const Settings: React.FC = () => {
  const { user, loading, initialAuthCheck } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'account' | 'notifications'>('account');

  // Add admin-page class to body for wider header alignment
  useEffect(() => {
    document.body.classList.add('admin-page');
    return () => {
      document.body.classList.remove('admin-page');
    };
  }, []);
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
    return <div className="container-fluid admin-page-container" style={{ minHeight: '100vh', padding: '2rem' }}>
      <div className="card text-center" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>Loading...</div>
    </div>;
  }

  if (!user) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="container-fluid settings-container admin-page-container" style={{ minHeight: '100vh', padding: '2rem' }}>
      <style>
        {`
          /* Make settings page full width */
          .settings-container {
            max-width: 100% !important;
            width: 100% !important;
            position: relative !important;
            z-index: 10 !important;
          }
          
          /* Responsive padding adjustments for full-width settings page */
          @media (min-width: 768px) {
            .settings-container {
              padding-left: 2rem !important;
              padding-right: 2rem !important;
            }
          }
          @media (min-width: 1200px) {
            .settings-container {
              padding-left: 2.5rem !important;
              padding-right: 2.5rem !important;
            }
          }
          @media (min-width: 1400px) {
            .settings-container {
              padding-left: 3rem !important;
              padding-right: 3rem !important;
            }
          }
          @media (min-width: 1920px) {
            .settings-container {
              padding-left: 3.5rem !important;
              padding-right: 3.5rem !important;
            }
          }
          
          /* Very large screens constraint for settings */
          @media (min-width: 2560px) {
            .settings-container {
              max-width: 2560px !important;
              margin: 0 auto !important;
            }
          }
          
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
            border-bottom: 1px solid var(--border-card) !important;
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
            background-color: var(--bg-hover) !important;
            border: 1px solid var(--border-card) !important;
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
          /* Custom toggle switches - Momentum Design System */
          .settings-page .form-check-input {
            background-color: var(--bg-input) !important;
            border-color: var(--border-card) !important;
            width: 3rem !important;
            height: 1.5rem !important;
          }
          .settings-page .form-check-input:checked {
            background-color: var(--brand-headline) !important;
            border-color: var(--brand-headline) !important;
          }
          .settings-page .form-check-input:focus {
            box-shadow: 0 0 0 0.2rem var(--focus-ring-color) !important;
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
            background-color: var(--bg-hover) !important;
            border: 1px solid var(--border-card) !important;
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
            filter: var(--btn-close-filter, invert(1));
          }
          .settings-page .btn-outline-danger {
            border-color: rgba(244, 67, 54, 0.5) !important;
            color: var(--text-primary) !important;
          }
          .settings-page .btn-outline-danger:hover {
            background-color: rgba(244, 67, 54, 0.2) !important;
            border-color: rgba(244, 67, 54, 0.7) !important;
          }
          
          /* Settings tabs styling */
          .settings-page .nav-tabs {
            border-bottom: 1px solid var(--border-card);
            margin-bottom: 2rem;
            display: flex;
            gap: 0.5rem;
          }
          .settings-page .nav-item {
            flex: 1;
            min-width: 0;
          }
          .settings-page .nav-link {
            color: var(--text-muted);
            border: none;
            border-bottom: 2px solid transparent;
            padding: 0.75rem 1.5rem;
            background-color: transparent;
            transition: all 0.2s ease-in-out;
            text-align: center;
            width: 100%;
          }
          .settings-page .nav-link:hover {
            color: var(--text-primary);
            border-bottom-color: var(--brand-headline);
            background-color: var(--bg-hover);
          }
          .settings-page .nav-link.active {
            color: var(--brand-headline);
            border-bottom-color: var(--brand-headline);
            background-color: transparent;
            font-weight: 600;
          }
          .settings-page .tab-content {
            min-height: 300px;
          }
          .settings-page .tab-pane {
            display: none;
          }
          .settings-page .tab-pane.active {
            display: block;
          }
          
          @media (max-width: 768px) {
            .settings-page .nav-tabs {
              flex-direction: column;
            }
            .settings-page .nav-item {
              width: 100%;
            }
            .settings-page .nav-link {
              padding: 0.5rem 1rem;
              font-size: 0.9rem;
            }
          }
        `}
      </style>
      <div className="row settings-page">
        <div className={`col-12 ${user.role === 'superadmin' ? 'col-lg-12 col-xl-10' : 'col-lg-8 col-xl-6'} mx-auto`}>
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
              {/* Tabs Navigation */}
              <ul className="nav nav-tabs" role="tablist">
                <li className="nav-item" role="presentation">
                  <button
                    className={`nav-link ${activeTab === 'account' ? 'active' : ''}`}
                    onClick={() => setActiveTab('account')}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'account'}
                  >
                    <i className="bi bi-person-gear me-2"></i>
                    Account Management
                  </button>
                </li>
                <li className="nav-item" role="presentation">
                  <button
                    className={`nav-link ${activeTab === 'notifications' ? 'active' : ''}`}
                    onClick={() => setActiveTab('notifications')}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'notifications'}
                  >
                    <i className="bi bi-bell me-2"></i>
                    Notification Preferences
                  </button>
                </li>
              </ul>

              {/* Tab Content */}
              <div className="tab-content">
                {/* Account Management Tab */}
                {activeTab === 'account' && (
                  <div className="tab-pane active">
                    {user.role === 'superadmin' ? (
                      <div>
                        <h2 className="h5 mb-3">Admin Management</h2>
                        <p className="text-muted mb-4">
                          Manage admin access requests and existing admins. Approve or deny requests, and revoke admin access when needed.
                        </p>
                        <AdminManagement />
                      </div>
                    ) : (
                      <div className="text-center py-5">
                        <i className="bi bi-person-circle" style={{ fontSize: '3rem', color: 'var(--text-muted)', marginBottom: '1rem' }}></i>
                        <p className="text-muted mb-0">
                          Account management features are available for superadmin users.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Notification Preferences Tab */}
                {activeTab === 'notifications' && (
                  <div className="tab-pane active">
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
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;

