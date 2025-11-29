import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMyBookings, cancelBooking, rescheduleBooking } from '../api/client';
import { BookingWithDetails } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import ConfirmationModal from '../components/ConfirmationModal';
import { Button, Card, CardHeader, CardBody, CardFooter, CardTitle, Alert, Spinner } from '../components/ui';
import { ArrowLeft, RefreshCw, ExternalLink, CalendarX } from 'lucide-react';

const MyBookings: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [bookings, setBookings] = useState<{ upcoming: BookingWithDetails[]; past: BookingWithDetails[] }>({ upcoming: [], past: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState<{ show: boolean; bookingId: string | null }>({ show: false, bookingId: null });
  const [rescheduleConfirm, setRescheduleConfirm] = useState<{ show: boolean; bookingId: string | null; targetSessionId: string | null }>({ show: false, bookingId: null, targetSessionId: null });

  useEffect(() => {
    loadBookings();
  }, []);

  // Refresh data when user returns to the page
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        console.log('Page became visible, refreshing bookings data');
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
      console.log('Loading my bookings...');
      const data = await getMyBookings();
      console.log('Loaded bookings data:', data);
      console.log('Upcoming bookings:', data.upcoming?.length || 0);
      console.log('Past bookings:', data.past?.length || 0);
      setBookings(data);
    } catch (err) {
      console.error('Error loading bookings:', err);
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
    } catch (err: any) {
      console.error('Error cancelling booking:', err);
      // Show more specific error message if available
      let errorMessage = 'Failed to cancel booking';
      if (err?.response?.data?.error) {
        errorMessage = typeof err.response.data.error === 'string' 
          ? err.response.data.error 
          : err.response.data.error?.message || errorMessage;
      } else if (err?.response?.data?.details) {
        errorMessage = typeof err.response.data.details === 'string'
          ? err.response.data.details
          : errorMessage;
      } else if (err?.message) {
        errorMessage = typeof err.message === 'string' ? err.message : errorMessage;
      } else if (err?.response?.statusText) {
        errorMessage = err.response.statusText;
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
    } catch (err: any) {
      console.error('Error rescheduling booking:', err);
      // Show more specific error message if available
      const errorMessage = err?.response?.data?.error || err?.message || 'Failed to reschedule booking';
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
    <div className="container mt-4 relative z-10 my-bookings-page">
      <div className="row">
        <div className="col">
          <div className="flex justify-between items-start">
            <div>
              <Button
                variant="outline-secondary"
                className="mb-3"
                onClick={() => navigate('/')}
                title="Back to AdaptaLabs"
              >
                <ArrowLeft size={16} className="me-1" />
                Back to AdaptaLabs
              </Button>
              <h2>My Bookings</h2>
              <p className="text-muted">Manage your AdaptaLabs activity bookings</p>
            </div>
            <Button
              variant="outline-primary"
              onClick={loadBookings}
              disabled={loading}
              title="Refresh bookings"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <div className="row mt-3">
          <div className="col">
            <Alert variant="danger" dismissible onDismiss={() => setError(null)}>
              {error}
            </Alert>
          </div>
        </div>
      )}

      {/* Upcoming Bookings */}
      <div className="row mt-4">
        <div className="col">
          <h4>Upcoming Bookings</h4>
          {bookings.upcoming.length === 0 ? (
            <Card>
              <CardBody className="empty-state-container">
                <CalendarX size={48} className="empty-state-icon" />
                <h5 className="empty-state-title">No upcoming sessions</h5>
                <p className="empty-state-subtitle">Check the dashboard to find new activities.</p>
                <Button
                  variant="primary"
                  onClick={() => navigate('/')}
                  className="mt-3"
                >
                  Browse Activities
                </Button>
              </CardBody>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {bookings.upcoming.map((booking) => (
                <Card key={booking.id} className="booking-card-upcoming">
                  <CardHeader className="flex justify-between items-center">
                    <div>
                      {getStatusBadge(booking.status)}
                      {getTypeBadge(booking.opportunity_type)}
                    </div>
                  </CardHeader>
                  <CardBody>
                    <CardTitle as="h6" className="font-bold">{booking.opportunity_title}</CardTitle>
                    <p className="text-sm text-muted">
                      {booking.opportunity_purpose}
                    </p>
                    <div className="booking-details">
                      <div className="booking-details-row">
                        <span className="booking-label">Date:</span>
                        <span className="booking-value">{formatDate(booking.session_start_time)}</span>
                      </div>
                      <div className="booking-details-row">
                        <span className="booking-label">Time:</span>
                        <span className="booking-value">{formatTime(booking.session_start_time)} - {formatTime(booking.session_end_time)}</span>
                      </div>
                      {booking.session_location && (
                        <div className="booking-details-row">
                          <span className="booking-label">Location:</span>
                          {renderLocation(booking.session_location)}
                        </div>
                      )}
                      <div className="booking-details-row">
                        <span className="booking-label">Owner:</span>
                        <span className="booking-value">{booking.owner_name}</span>
                      </div>
                    </div>
                  </CardBody>
                  <CardFooter>
                    <div className="flex gap-2">
                      <button
                        className="btn-booking-cancel"
                        onClick={() => handleCancelBooking(booking.id)}
                        disabled={actionLoading === booking.id}
                      >
                        {actionLoading === booking.id ? 'Cancelling...' : 'Cancel'}
                      </button>
                      {/* Reschedule functionality will be implemented in a future release */}
                      <button
                        className="btn-booking-reschedule"
                        disabled
                      >
                        Reschedule
                      </button>
                    </div>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Past Bookings */}
      <div className="row mt-12">
        <div className="col">
          <h4>Past Bookings</h4>
          {bookings.past.length === 0 ? (
            <Card>
              <CardBody className="text-center text-muted">
                <p>No past bookings</p>
              </CardBody>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {bookings.past.map((booking) => (
                <Card key={booking.id} className="booking-card-past">
                  <CardHeader className="flex justify-between items-center">
                    <div>
                      {getStatusBadge(booking.status)}
                      {getTypeBadge(booking.opportunity_type)}
                    </div>
                  </CardHeader>
                  <CardBody>
                    <CardTitle as="h6" className="font-bold">{booking.opportunity_title}</CardTitle>
                    <p className="text-sm text-muted">
                      {booking.opportunity_purpose}
                    </p>
                    <div className="booking-details">
                      <div className="booking-details-row">
                        <span className="booking-label">Date:</span>
                        <span className="booking-value">{formatDate(booking.session_start_time)}</span>
                      </div>
                      <div className="booking-details-row">
                        <span className="booking-label">Time:</span>
                        <span className="booking-value">{formatTime(booking.session_start_time)} - {formatTime(booking.session_end_time)}</span>
                      </div>
                      {booking.session_location && (
                        <div className="booking-details-row">
                          <span className="booking-label">Location:</span>
                          {renderLocation(booking.session_location)}
                        </div>
                      )}
                      <div className="booking-details-row">
                        <span className="booking-label">Owner:</span>
                        <span className="booking-value">{booking.owner_name}</span>
                      </div>
                      {booking.cancelled_at && (
                        <div className="booking-details-row">
                          <span className="booking-label">Cancelled:</span>
                          <span className="booking-value">{formatHumanDate(booking.cancelled_at)}</span>
                        </div>
                      )}
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <ConfirmationModal
        show={cancelConfirm.show}
        title="Cancel Booking"
        message="Are you sure you want to cancel this booking? This action will free up the slot for other participants and cannot be undone."
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
  );
};

export default MyBookings;
