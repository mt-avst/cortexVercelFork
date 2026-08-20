import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
// rescheduleBooking is deliberately not imported: the control was removed
// (it shipped permanently disabled) and the endpoint stays live and guarded
// server-side for a future rebuild.
import { getMyBookings, cancelBooking, getMySessionEvents } from '../api/client';
import { BookingWithDetails, MySessionEvent } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { logger } from '../utils/logger';
import { getParticipantFacingType } from '../utils/opportunityUtils';
import {
  formatStudyDate,
  formatTimeRange,
  formatTimeZoneLabel,
  formatDateTime,
} from '../utils/datetime';
import ConfirmationModal from '../components/ConfirmationModal';
import SlowNeuralBackground from '../components/SlowNeuralBackground';
import { Button, Card, CardHeader, CardBody, CardFooter, CardTitle, Alert, Spinner } from '../components/ui';
import { ArrowLeft, RefreshCw, ExternalLink, CalendarX, Monitor } from 'lucide-react';
import { isPublishableExternalLink } from '../shared/firsthand/url-safety';

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




  // Formatting comes from utils/datetime so this page cannot drift into its own
  // dialect again. It previously carried THREE: toLocaleDateString() for the
  // session date (DD/MM/YYYY here), a 24-hour toLocaleTimeString for the range,
  // and an en-US "Jul 25, 12:13 PM" for the cancellation - the last two on the
  // same card.

  /**
   * Whether this location is something to LINK to, decided by parsing it.
   *
   * This was a substring test - `str.includes('meet.google.com')` and friends -
   * and the value it tested has never been validated on the way in. So
   * `javascript:alert(document.cookie)//meet.google.com` satisfied it and was
   * rendered as an `href` labelled "Join via Google Meet", the `//` turning the
   * allowlisted host into a JavaScript comment. A researcher sets it once on a
   * session; every participant who books sees the button.
   *
   * The same predicate the schema now refuses on, so a value that reached
   * storage before that guard existed still cannot become a link here. Anything
   * that is not an http(s) URL - including a plain "Room 3B" - falls through to
   * being rendered as text, which is what it always did.
   */
  const isUrl = (str: string): boolean => isPublishableExternalLink(str);

  /**
   * Which platform a joining link belongs to, read from the HOSTNAME.
   *
   * `url.includes('meet.google.com')` matched anywhere in the string, so
   * `https://evil.example.com/?next=meet.google.com` was labelled "Join via
   * Google Meet" - a phishing label this app would have printed itself. The
   * host is the only part of a URL that says where it goes.
   */
  const getMeetingPlatform = (url: string): string => {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return 'Join Meeting';
    }
    const isHost = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    if (isHost('meet.google.com')) return 'Join via Google Meet';
    if (isHost('zoom.us')) return 'Join via Zoom';
    if (isHost('teams.microsoft.com')) return 'Join via Teams';
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

  // Participant vocabulary, from the same helper the browse index and the
  // filter chips use. This said "Test" while the index said "Usability test".
  const getTypeBadge = (type: string) => (
    <span className={`booking-badge booking-badge-${type} ms-2`}>
      {getParticipantFacingType(type)}
    </span>
  );

  /**
   * What became of a past booking.
   *
   * The database has carried this all along and the page showed none of it, so
   * a session you turned up to and one you missed looked identical - and this
   * is what AdaptaBits points hang off.
   */
  const getOutcome = (booking: BookingWithDetails) => {
    if (booking.status === 'cancelled') return null;
    switch (booking.completion_status) {
      case 'approved':
        return <span className="booking-outcome booking-outcome-approved">Attendance confirmed</span>;
      case 'completed':
        return <span className="booking-outcome booking-outcome-completed">Marked complete, awaiting confirmation</span>;
      case 'rejected':
        return <span className="booking-outcome booking-outcome-rejected">Not confirmed</span>;
      default:
        return <span className="booking-outcome">Awaiting confirmation</span>;
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
        <section className="my-bookings-section" data-testid="upcoming-bookings">
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
                        <dt className="booking-metadata-label">When</dt>
                        <dd className="booking-metadata-value">
                          {formatStudyDate(booking.session_start_time)}
                          <br />
                          {formatTimeRange(booking.session_start_time, booking.session_end_time)}{' '}
                          <span className="booking-timezone">
                            {formatTimeZoneLabel(booking.session_start_time)}
                          </span>
                        </dd>
                      </div>
                      {/* The meeting link is NOT repeated here. It was rendered
                          as both this field and the button below, eight pixels
                          apart. Non-URL locations (a room name) still show. */}
                      {booking.session_location && !isUrl(booking.session_location) && (
                        <div className="booking-metadata-row">
                          <dt className="booking-metadata-label">Location</dt>
                          <dd className="booking-metadata-value">
                            {renderLocation(booking.session_location)}
                          </dd>
                        </div>
                      )}
                      <div className="booking-metadata-row">
                        <dt className="booking-metadata-label">Researcher</dt>
                        <dd className="booking-metadata-value">{booking.owner_name}</dd>
                      </div>
                    </dl>
                  </CardBody>
                  <CardFooter className="booking-card-footer">
                    <div className="booking-actions">
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
                      {/* No Reschedule. It shipped permanently `disabled` with
                          title="Reschedule functionality coming soon" - a
                          feature promised on every card and never built. The
                          path that does work is named instead. */}
                      <button
                        className="btn-booking-cancel"
                        onClick={() => handleCancelBooking(booking.id)}
                        disabled={actionLoading === booking.id}
                      >
                        {actionLoading === booking.id ? 'Cancelling...' : 'Cancel'}
                      </button>
                    </div>
                    <p className="booking-reschedule-note">
                      Need a different time? Cancel this and book another slot.
                    </p>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* Past Bookings Section */}
        <section className="my-bookings-section my-bookings-section-past" data-testid="past-bookings">
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
                        <dt className="booking-metadata-label">When</dt>
                        <dd className="booking-metadata-value">
                          {formatStudyDate(booking.session_start_time)}
                          <br />
                          {formatTimeRange(booking.session_start_time, booking.session_end_time)}{' '}
                          <span className="booking-timezone">
                            {formatTimeZoneLabel(booking.session_start_time)}
                          </span>
                        </dd>
                      </div>
                      {/* No meeting link on a past booking. A session that
                          finished three weeks ago was still offering a live
                          "Join via Google Meet" as its only affordance -
                          including the cancelled one. */}
                      <div className="booking-metadata-row">
                        <dt className="booking-metadata-label">Researcher</dt>
                        <dd className="booking-metadata-value">{booking.owner_name}</dd>
                      </div>
                      {booking.cancelled_at && (
                        <div className="booking-metadata-row">
                          <dt className="booking-metadata-label">Cancelled</dt>
                          <dd className="booking-metadata-value">{formatDateTime(booking.cancelled_at)}</dd>
                        </div>
                      )}
                      {getOutcome(booking) && (
                        <div className="booking-metadata-row">
                          <dt className="booking-metadata-label">Outcome</dt>
                          <dd className="booking-metadata-value">{getOutcome(booking)}</dd>
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
                        <dd className="booking-metadata-value">{formatDateTime(event.occurred_at)}</dd>
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

        
      </div>
    </div>
  );
};

export default MyBookings;
