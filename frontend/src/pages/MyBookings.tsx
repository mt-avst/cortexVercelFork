import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMyBookings, cancelBooking, rescheduleBooking } from '../api/client';
import { BookingWithDetails } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import ConfirmationModal from '../components/ConfirmationModal';
import { Button, Card, CardHeader, CardBody, CardFooter, CardTitle, Badge, Alert, Spinner } from '../components/ui';

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

  const formatDateTime = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'booked':
        return null; // Don't show "Booked" badge
      case 'cancelled':
        return <Badge variant="secondary">Cancelled</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const getTypeBadge = (type: string) => {
    switch (type) {
      case 'test':
        return <Badge className="ms-2">Test</Badge>;
      case 'poll':
        return <Badge variant="info" className="ms-2">Poll</Badge>;
      case 'survey':
        return <Badge variant="warning" className="ms-2">Survey</Badge>;
      default:
        return <Badge className="ms-2">{type}</Badge>;
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
    <div className="container mt-4 relative z-10">
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
                <i className="bi bi-arrow-left me-1"></i>
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
              <i className={`bi bi-arrow-clockwise ${loading ? 'spinner-border spinner-border-sm' : ''}`}></i>
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
              <CardBody className="text-center text-muted">
                <p>No upcoming bookings</p>
              </CardBody>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {bookings.upcoming.map((booking) => (
                <Card key={booking.id}>
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
                    <div className="text-sm">
                      <div><strong>Date:</strong> {formatDate(booking.session_start_time)}</div>
                      <div><strong>Time:</strong> {formatTime(booking.session_start_time)} - {formatTime(booking.session_end_time)}</div>
                      {booking.session_location && (
                        <div><strong>Location:</strong> {booking.session_location}</div>
                      )}
                      <div><strong>Owner:</strong> {booking.owner_name}</div>
                    </div>
                  </CardBody>
                  <CardFooter>
                    <div className="flex gap-2">
                      <Button
                        variant="outline-danger"
                        size="sm"
                        onClick={() => handleCancelBooking(booking.id)}
                        disabled={actionLoading === booking.id}
                        loading={actionLoading === booking.id}
                      >
                        Cancel
                      </Button>
                      {/* Reschedule functionality will be implemented in a future release */}
                      <Button
                        variant="outline-primary"
                        size="sm"
                        disabled
                      >
                        Reschedule
                      </Button>
                    </div>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Past Bookings */}
      <div className="row mt-5">
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
                <Card key={booking.id} className="opacity-75">
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
                    <div className="text-sm">
                      <div><strong>Date:</strong> {formatDate(booking.session_start_time)}</div>
                      <div><strong>Time:</strong> {formatTime(booking.session_start_time)} - {formatTime(booking.session_end_time)}</div>
                      {booking.session_location && (
                        <div><strong>Location:</strong> {booking.session_location}</div>
                      )}
                      <div><strong>Owner:</strong> {booking.owner_name}</div>
                      {booking.cancelled_at && (
                        <div><strong>Cancelled:</strong> {formatDateTime(booking.cancelled_at)}</div>
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
