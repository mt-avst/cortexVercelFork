import React, { useState, useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getNotificationPreferences, updateNotificationPreferences, NotificationPreference } from '../api/client';
import AdminManagement from '../components/AdminManagement';
import { Card, CardHeader, CardBody, Alert, Spinner } from '../components/ui';
import { ArrowLeft, UserCog, Bell, UserCircle, AlertTriangle, CheckCircle, MailCheck, MailX } from 'lucide-react';

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
    return (
      <div className="container-fluid admin-page-container">
        <Card className="text-center">
          <CardBody>Loading...</CardBody>
        </Card>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="container-fluid settings-container admin-page-container">
      <div className="row settings-page">
        <div className={`col-12 ${user.role === 'superadmin' ? 'col-lg-12 col-xl-10' : 'col-lg-8 col-xl-6'} mx-auto`}>
          <Card>
            <CardHeader className="flex justify-between items-center">
              <div>
                <button 
                  className="btn btn-link text-decoration-none p-0 mb-2"
                  onClick={() => navigate('/admin')}
                >
                  <ArrowLeft size={16} className="me-2" />
                  Back to Dashboard
                </button>
                <h1 className="h4 mb-0">Settings</h1>
              </div>
            </CardHeader>
            
            <CardBody>
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
                    <UserCog size={16} className="me-2" />
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
                    <Bell size={16} className="me-2" />
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
                        <UserCircle size={48} className="text-muted mb-4" style={{ display: 'block' }} />
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
                        <Spinner />
                      </div>
                    ) : error && !preferences ? (
                      <Alert variant="danger">
                        <AlertTriangle size={16} className="me-2" />
                        {error}
                        <button 
                          className="btn btn-sm btn-outline-danger ms-3"
                          onClick={loadPreferences}
                        >
                          Retry
                        </button>
                      </Alert>
                    ) : (
                      <>
                        {success && (
                          <Alert variant="success" dismissible onDismiss={() => setSuccess(false)}>
                            <CheckCircle size={16} className="me-2" />
                            Settings saved successfully!
                          </Alert>
                        )}

                        {error && (
                          <Alert variant="danger" dismissible onDismiss={() => setError('')}>
                            <AlertTriangle size={16} className="me-2" />
                            {error}
                          </Alert>
                        )}

                        <h2 className="h5 mb-3">Notification Preferences</h2>
                        <p className="text-muted mb-4">
                          Control when you receive email notifications for bookings and cancellations in your research studies.
                        </p>

                        {preferences && (
                          <div className="list-group">
                            <div className="list-group-item">
                              <div className="flex justify-between items-center">
                                <div className="grow">
                                  <h6 className="mb-1 d-flex align-items-center">
                                    <MailCheck size={16} className="me-2" />
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
                                    style={{ cursor: saving ? 'not-allowed' : 'pointer' }}
                                  />
                                </div>
                              </div>
                            </div>

                            <div className="list-group-item">
                              <div className="flex justify-between items-center">
                                <div className="grow">
                                  <h6 className="mb-1 d-flex align-items-center">
                                    <MailX size={16} className="me-2" />
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
                                    style={{ cursor: saving ? 'not-allowed' : 'pointer' }}
                                  />
                                </div>
                              </div>
                            </div>
                          </div>
                        )}

                        {saving && (
                          <div className="mt-3 text-center">
                            <Spinner size="sm" />
                            <small className="text-muted ms-2">Saving...</small>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Settings;
