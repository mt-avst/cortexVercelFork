import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMyBookings, cancelBooking, rescheduleBooking, getMySessionEvents } from '../api/client';
import { BookingWithDetails, MySessionEvent } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { logger } from '../utils/logger';
import ConfirmationModal from '../components/ConfirmationModal';
import SlowNeuralBackground from '../components/SlowNeuralBackground';
import { Button, Card, CardHeader, CardBody, CardFooter, CardTitle, Alert, Spinner } from '../components/ui';
import { ArrowLeft, RefreshCw, ExternalLink, CalendarX, Monitor } from 'lucide-react';

const MyBookings: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [bookings, setBookings] = useState<{ upcoming: BookingWithDetails[]; past: BookingWithDetails[] }>({ upcoming: [], past: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState<{ show: boolean; bookingId: string | null }>({ show: false, bookingId: null });
  const [rescheduleConfirm, setRescheduleConfirm] = useState<{ show: boolean; bookingId: string | null; targetSessionId: string | null }>({ show: false, bookingId: null, targetSessionId: null });
  const [sessionEvents, setSessionEvents] = useState<MySessionEvent[]>([]);

  useEffect(() => {
    loadBookings();
  }, []);

  // Refresh data when user returns to the page
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        logger.debug('Page became visible, refreshing bookings data');
        loadBookings();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const loadBookings = async () => {
    try {
      setLoading(true);
      setError(null);
      logger.debug('Loading my bookings...');
      const [data, events] = await Promise.all([
        getMyBookings(),
        getMySessionEvents().catch(() => [] as MySessionEvent[]),
      ]);
      logger.debug('Loaded bookings data', {
        upcoming: data.upcoming?.length || 0,
        past: data.past?.length || 0
      });
      setBookings(data);
      setSessionEvents(events);
    } catch (error: unknown) {
      logger.error('Error loading bookings', {
        error: error instanceof Error ? error : undefined,
        errorDetails: error instanceof Error ? { message: error.message } : { message: String(error) }
      });
      setError('Failed to load bookings');
    } finally {
      setLoading(false);
    }
  };

  const handleCancelBooking = (bookingId: string) => {
    setCancelConfirm({ show: true, bookingId });
  };

  const confirmCancelBooking = async () => {
    if (!cancelConfirm.bookingId) return;
    
    try {
      setActionLoading(cancelConfirm.bookingId);
      await cancelBooking(cancelConfirm.bookingId);
      await loadBookings(); // Reload to update the list
      setCancelConfirm({ show: false, bookingId: null });
    } catch (err: unknown) {
      // Type-safe error extraction
      const axiosError = err as { response?: { data?: { error?: string | { message?: string }; details?: string }; statusText?: string }; message?: string };
      let errorMessage = 'Failed to cancel booking';
      if (axiosError?.response?.data?.error) {
        errorMessage = typeof axiosError.response.data.error === 'string' 
          ? axiosError.response.data.error 
          : axiosError.response.data.error?.message || errorMessage;
      } else if (axiosError?.response?.data?.details) {
        errorMessage = typeof axiosError.response.data.details === 'string'
          ? axiosError.response.data.details
          : errorMessage;
      } else if (axiosError?.message) {
        errorMessage = typeof axiosError.message === 'string' ? axiosError.message : errorMessage;
      } else if (axiosError?.response?.statusText) {
        errorMessage = axiosError.response.statusText;
      }
      setError(`Failed to cancel booking: ${errorMessage}`);
    } finally {
      setActionLoading(null);
    }
  };

  const cancelCancelBooking = () => {
    setCancelConfirm({ show: false, bookingId: null });
  };

  const handleRescheduleBooking = (bookingId: string, targetSessionId: string) => {
    setRescheduleConfirm({ show: true, bookingId, targetSessionId });
  };

  const confirmRescheduleBooking = async () => {
    if (!rescheduleConfirm.bookingId || !rescheduleConfirm.targetSessionId) return;
    
    try {
      setActionLoading(rescheduleConfirm.bookingId);
      await rescheduleBooking(rescheduleConfirm.bookingId, { target_session_id: rescheduleConfirm.targetSessionId });
      await loadBookings(); // Reload to update the list
      setRescheduleConfirm({ show: false, bookingId: null, targetSessionId: null });
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } }; message?: string };
      const errorMessage = axiosError?.response?.data?.error || axiosError?.message || 'Failed to reschedule booking';
      setError(`Failed to reschedule booking: ${errorMessage}`);
    } finally {
      setActionLoading(null);
    }
  };

  const cancelRescheduleBooking = () => {
    setRescheduleConfirm({ show: false, bookingId: null, targetSessionId: null });
  };

  // Date formatting helpers
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Human-readable date format: "Nov 25, 2:29 PM"
  const formatHumanDate = (dateString: string) => {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  };

  // URL detection helper
  const isUrl = (str: string): boolean => {
    if (!str) return false;
    return (
      str.startsWith('http://') ||
      str.startsWith('https://') ||
      str.includes('meet.google.com') ||
      str.includes('zoom.us') ||
      str.includes('teams.microsoft.com')
    );
  };

  // Get meeting platform name from URL
  const getMeetingPlatform = (url: string): string => {
    if (url.includes('meet.google.com')) return 'Join via Google Meet';
    if (url.includes('zoom.us')) return 'Join via Zoom';
    if (url.includes('teams.microsoft.com')) return 'Join via Teams';
    return 'Join Meeting';
  };

  // Render location as link or text
  const renderLocation = (location: string | null | undefined) => {
    if (!location) return null;
    
    if (isUrl(location)) {
      return (
        <a 
          href={location} 
          target="_blank" 
          rel="noopener noreferrer"
          className="meeting-link"
        >
          {getMeetingPlatform(location)}
          <ExternalLink size={14} />
        </a>
      );
    }
    
    return <span className="booking-value">{location}</span>;
  };

  // Status badge with premium styling
  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'booked':
        return null; // Don't show "Booked" badge
      case 'cancelled':
        return <span className="booking-badge booking-badge-cancelled">Cancelled</span>;
      default:
        return <span className="booking-badge">{status}</span>;
    }
  };

  // Type badge with premium styling
  const getTypeBadge = (type: string) => {
    switch (type) {
      case 'test':
        return <span className="booking-badge booking-badge-test ms-2">Test</span>;
      case 'poll':
        return <span className="booking-badge booking-badge-poll ms-2">Poll</span>;
      case 'survey':
        return <span className="booking-badge booking-badge-survey ms-2">Survey</span>;
      default:
        return <span className="booking-badge ms-2">{type}</span>;
    }
  };

  if (!user) {
    return (
      <div className="container mt-4 relative z-10">
        <Alert variant="warning">
          Please log in to view your bookings.
        </Alert>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="container mt-4 text-center relative z-10" aria-busy="true" aria-live="polite">
        <Spinner label="Loading bookings" />
        <p className="mt-2">Loading your bookings...</p>
      </div>
    );
  }

  return (
    <div className="admin-page-bg my-bookings-page">
      {/* Theme-aware Background: Dark Mode gets neural particles on black */}
      {isDark && <SlowNeuralBackground />}
      
      <div className="container-fluid my-bookings-container">
        {/* Page Header */}
        <header className="my-bookings-header">
          <Button
            variant="outline-secondary"
            className="my-bookings-back-btn"
            onClick={() => navigate('/')}
            title="Back to studies"
          >
            <ArrowLeft size={16} />
            Back to studies
          </Button>
          <div className="my-bookings-header-content">
            <div className="my-bookings-title-row">
              <h1 className="my-bookings-title cortex-brand-title">Cortex<span className="cortex-admin-separator">|</span><span className="cortex-admin-suffix">Bookings</span></h1>
              <Button
                variant="outline-primary"
                className="my-bookings-refresh-btn"
                onClick={loadBookings}
                disabled={loading}
                title="Refresh bookings"
              >
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                Refresh
              </Button>
            </div>
            <p className="my-bookings-subtitle">Manage your Cortex study bookings</p>
          </div>
        </header>

        {/* Error Alert */}
        {error && (
          <div className="my-bookings-alert-container">
            <Alert variant="danger" dismissible onDismiss={() => setError(null)}>
              {error}
            </Alert>
          </div>
        )}

        {/* Upcoming Bookings Section */}
        <section className="my-bookings-section">
          <h2 className="my-bookings-section-title">Upcoming bookings</h2>
          {bookings.upcoming.length === 0 ? (
            <Card className="booking-card booking-card-empty">
              <CardBody className="empty-state-container">
                <CalendarX size={48} className="empty-state-icon" />
                <h3 className="empty-state-title">No upcoming sessions</h3>
                <p className="empty-state-subtitle">Browse the Cortex dashboard to find studies to participate in.</p>
                <Button
                  variant="primary"
                  onClick={() => navigate('/')}
                  className="mt-4"
                >
                  Browse studies
                </Button>
              </CardBody>
            </Card>
          ) : (
            <div className="booking-cards-grid">
              {bookings.upcoming.map((booking) => (
                <Card key={booking.id} className="booking-card booking-card-upcoming">
                  <CardBody className="booking-card-body">
                    {/* Badge Row */}
                    <div className="booking-card-badges">
                      {getStatusBadge(booking.status)}
                      {getTypeBadge(booking.opportunity_type)}
                    </div>
                    
                    {/* Title & Description */}
                    <h3 className="booking-card-title">{booking.opportunity_title}</h3>
                    <p className="booking-card-description">{booking.opportunity_purpose}</p>
                    
                    {/* Metadata Grid */}
                    <dl className="booking-metadata">
                      <div className="booking-metadata-row">
                        <dt className="booking-metadata-label">Date</dt>
                        <dd className="booking-metadata-value">{formatDate(booking.session_start_time)}</dd>
                      </div>
                      <div className="booking-metadata-row">
                        <dt className="booking-metadata-label">Time</dt>
                        <dd className="booking-metadata-value">{formatTime(booking.session_start_time)} - {formatTime(booking.session_end_time)}</dd>
                      </div>
                      {booking.session_location && (
                        <div className="booking-metadata-row">
                          <dt className="booking-metadata-label">Location</dt>
                          <dd className="booking-metadata-value">
                            {renderLocation(booking.session_location)}
                          </dd>
                        </div>
                      )}
                      <div className="booking-metadata-row">
                        <dt className="booking-metadata-label">Owner</dt>
                        <dd className="booking-metadata-value">{booking.owner_name}</dd>
                      </div>
                    </dl>
                  </CardBody>
                  <CardFooter className="booking-card-footer">
                    <div className="booking-actions">
                      {/* Primary action: Join meeting link (if available) */}
                      {booking.session_location && isUrl(booking.session_location) && (
                        <a 
                          href={booking.session_location} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="btn-booking-join"
                        >
                          {getMeetingPlatform(booking.session_location)}
                          <ExternalLink size={14} />
                        </a>
                      )}
                      {/* Secondary action: Reschedule */}
                      <button
                        className="btn-booking-reschedule"
                        disabled
                        title="Reschedule functionality coming soon"
                      >
                        Reschedule
                      </button>
                      {/* Tertiary action: Cancel */}
                      <button
                        className="btn-booking-cancel"
                        onClick={() => handleCancelBooking(booking.id)}
                        disabled={actionLoading === booking.id}
                      >
                        {actionLoading === booking.id ? 'Cancelling...' : 'Cancel'}
                      </button>
                    </div>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* Past Bookings Section */}
        <section className="my-bookings-section my-bookings-section-past">
          <h2 className="my-bookings-section-title">Past bookings</h2>
          {bookings.past.length === 0 ? (
            <Card className="booking-card booking-card-empty">
              <CardBody className="empty-state-container">
                <p className="empty-state-subtitle">No past bookings</p>
              </CardBody>
            </Card>
          ) : (
            <div className="booking-cards-grid">
              {bookings.past.map((booking) => (
                <Card key={booking.id} className="booking-card booking-card-past">
                  <CardBody className="booking-card-body">
                    {/* Badge Row */}
                    <div className="booking-card-badges">
                      {getStatusBadge(booking.status)}
                      {getTypeBadge(booking.opportunity_type)}
                    </div>
                    
                    {/* Title & Description */}
                    <h3 className="booking-card-title">{booking.opportunity_title}</h3>
                    <p className="booking-card-description">{booking.opportunity_purpose}</p>
                    
                    {/* Metadata Grid */}
                    <dl className="booking-metadata">
                      <div className="booking-metadata-row">
                        <dt className="booking-metadata-label">Date</dt>
                        <dd className="booking-metadata-value">{formatDate(booking.session_start_time)}</dd>
                      </div>
                      <div className="booking-metadata-row">
                        <dt className="booking-metadata-label">Time</dt>
                        <dd className="booking-metadata-value">{formatTime(booking.session_start_time)} - {formatTime(booking.session_end_time)}</dd>
                      </div>
                      {booking.session_location && (
                        <div className="booking-metadata-row">
                          <dt className="booking-metadata-label">Location</dt>
                          <dd className="booking-metadata-value">
                            {renderLocation(booking.session_location)}
                          </dd>
                        </div>
                      )}
                      <div className="booking-metadata-row">
                        <dt className="booking-metadata-label">Owner</dt>
                        <dd className="booking-metadata-value">{booking.owner_name}</dd>
                      </div>
                      {booking.cancelled_at && (
                        <div className="booking-metadata-row">
                          <dt className="booking-metadata-label">Cancelled</dt>
                          <dd className="booking-metadata-value">{formatHumanDate(booking.cancelled_at)}</dd>
                        </div>
                      )}
                    </dl>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </section>

        {sessionEvents.length > 0 && (
          <section className="my-bookings-section my-bookings-section-past">
            <h2 className="my-bookings-section-title">Self-guided sessions</h2>
            <div className="booking-cards-grid">
              {sessionEvents.map((event) => (
                <Card key={event.id} className="booking-card booking-card-past">
                  <CardBody className="booking-card-body">
                    <div className="booking-card-badges">
                      <span className={`booking-badge ${
                        event.event_type === 'session_completed' ? 'booking-badge-test' :
                        event.event_type === 'session_started' ? 'booking-badge-poll' :
                        'booking-badge-cancelled'
                      } ms-0`}>
                        {event.event_type === 'session_completed' ? 'Completed' :
                         event.event_type === 'session_started' ? 'Started' :
                         event.event_type === 'session_abandoned' ? 'Abandoned' : 'Failed'}
                      </span>
                    </div>
                    <h3 className="booking-card-title">{event.opportunity_title}</h3>
                    <dl className="booking-metadata">
                      <div className="booking-metadata-row">
                        <dt className="booking-metadata-label">Date</dt>
                        <dd className="booking-metadata-value">{formatDate(event.occurred_at)}</dd>
                      </div>
                      <div className="booking-metadata-row">
                        <dt className="booking-metadata-label">Type</dt>
                        <dd className="booking-metadata-value d-flex align-items-center gap-1">
                          <Monitor size={14} aria-hidden="true" />
                          Unmoderated
                        </dd>
                      </div>
                    </dl>
                  </CardBody>
                  <CardFooter className="booking-card-footer">
                    <a
                      href={`/opportunities/${event.opportunity_id}`}
                      className="btn-booking-reschedule"
                    >
                      View opportunity
                    </a>
                  </CardFooter>
                </Card>
              ))}
            </div>
          </section>
        )}

        {/* Modals */}
        <ConfirmationModal
          show={cancelConfirm.show}
          title="Cancel Booking"
          message="Are you sure you want to cancel this booking? This action will free up the slot for other participants and cannot be undone. If you added this session to your own calendar, please remove it there after cancelling."
          confirmLabel="Yes, Cancel Booking"
          cancelLabel="Keep My Booking"
          variant="danger"
          onConfirm={confirmCancelBooking}
          onCancel={cancelCancelBooking}
        />

        <ConfirmationModal
          show={rescheduleConfirm.show}
          title="Reschedule Booking"
          message="Are you sure you want to reschedule this booking? This action will move your booking to the selected time slot, free up your current slot, and cannot be undone."
          confirmLabel="Yes, Reschedule"
          cancelLabel="Cancel"
          variant="warning"
          onConfirm={confirmRescheduleBooking}
          onCancel={cancelRescheduleBooking}
        />
      </div>
    </div>
  );
};

export default MyBookings;
