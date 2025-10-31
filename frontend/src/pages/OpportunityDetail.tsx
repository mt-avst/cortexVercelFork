import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getOpportunity, bookSession, getMyBookingsDebug } from '../api/client';
import { Opportunity } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import CalendarGrid from '../components/CalendarGrid';
import CalendarConnection from '../components/CalendarConnection';
import { formatOpportunityType, getTypeBadgeClass } from '../utils/opportunityUtils';

const OpportunityDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, login } = useAuth();
  const [opportunity, setOpportunity] = useState<Opportunity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [bookingLoading, setBookingLoading] = useState<string | null>(null);
  const [bookingSuccess, setBookingSuccess] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'table' | 'calendar'>('calendar');
  const [calendarConnected, setCalendarConnected] = useState(false);

  const loadOpportunity = async (forceRefresh = false) => {
    if (!id) return;
    
    try {
      setLoading(true);
      setError('');
      console.log('Loading opportunity with ID:', id, 'forceRefresh:', forceRefresh);
      
      // Always use cache busting when force refreshing or when coming back to the page
      const params = forceRefresh ? { _t: Date.now() } : undefined;
      const data = await getOpportunity(id, params);
      
      console.log('Loaded opportunity data:', data);
      console.log('Sessions data:', data.sessions?.map(s => ({ id: s.id, remaining: s.remaining, booked_count: s.booked_count, capacity: s.capacity })));
      setOpportunity(data);
    } catch (err) {
      console.error('Error loading opportunity:', err);
      setError('Failed to load opportunity');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Always force refresh when component mounts to ensure fresh data
    loadOpportunity(true);
  }, [id]);

  // Refresh data when user returns to the page (handles browser back/forward)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && id) {
        console.log('Page became visible, refreshing opportunity data');
        loadOpportunity(true);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [id]);

  const handleBookSession = async (sessionId: string) => {
    if (!user) {
      setError('Please log in to book sessions');
      return;
    }

    // Additional validation
    if (!user.id) {
      setError('User session invalid. Please log in again.');
      return;
    }

    try {
      setBookingLoading(sessionId);
      setError('');
      setBookingSuccess(null);
      
      console.log('Attempting to book session:', sessionId);
      
      // Log session details before booking attempt
      const sessionToBook = opportunity?.sessions?.find(s => s.id === sessionId);
      if (sessionToBook) {
        console.log('Session details before booking:', {
          id: sessionToBook.id,
          capacity: sessionToBook.capacity,
          booked_count: sessionToBook.booked_count,
          remaining: sessionToBook.remaining,
          start_time: sessionToBook.start_time,
          end_time: sessionToBook.end_time
        });
      }
      
      // Store the session ID for potential retry
      sessionStorage.setItem('lastAttemptedSession', sessionId);
      
      const bookingResult = await bookSession(sessionId);
      console.log('Booking successful:', bookingResult);
      
      setBookingSuccess('Successfully booked! Check your bookings page.');
      
      // Small delay to ensure database transaction is committed
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Reload opportunity to update remaining slots with cache busting
      await loadOpportunity(true);
    } catch (err: any) {
      console.error('Error booking session:', err);
      console.error('Error response:', err.response?.data);
      console.error('Error status:', err.response?.status);
      console.error('Error code:', err.code);
      console.error('Error message:', err.message);
      console.error('Full error object:', {
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
        code: err.code,
        message: err.message,
        stack: err.stack
      });
      
      if (err.response?.status === 409) {
        // Use the specific error message from the backend
        const errorMessage = err.response?.data?.error || 'Session is full or you are already booked';
        setError(errorMessage);
        
        // If it's a capacity issue, refresh the opportunity data to get latest info
        if (errorMessage.includes('full') || errorMessage.includes('capacity')) {
          console.log('Capacity issue detected, refreshing opportunity data...');
          await loadOpportunity(true);
        }
      } else if (err.response?.status === 401) {
        setError('Please log in to book sessions');
      } else if (err.response?.status === 404) {
        setError('Session not found or opportunity not published');
      } else if (err.response?.status === 400) {
        setError('Cannot book past sessions');
      } else if (err.response?.status === 503) {
        setError('Database not available. Please try again later.');
      } else if (err.response?.status === 500) {
        setError('Server error occurred. Please try again.');
      } else if (err.code === 'NETWORK_ERROR' || err.message === 'Network Error') {
        setError('Network error. Please check your connection and try again.');
      } else if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
        setError('Request timed out. Please try again.');
      } else {
        // Show more detailed error information
        const errorMessage = err.response?.data?.error || err.message || 'Failed to book session';
        setError(`Failed to book session: ${errorMessage}`);
      }
    } finally {
      setBookingLoading(null);
    }
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'published': return 'badge bg-success text-white';
      case 'draft': return 'badge bg-warning text-white';
      case 'closed': return 'badge bg-secondary text-white';
      default: return 'badge bg-secondary text-white';
    }
  };

  if (loading) {
    return (
      <div className="container mt-4">
        <div className="text-center py-5">
          <div className="spinner-border" role="status">
            <span className="visually-hidden">Loading...</span>
          </div>
          <p className="mt-2">Loading opportunity...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mt-4">
        <div className="alert alert-danger" role="alert">
          {error}
          <button 
            className="btn btn-sm btn-outline-danger ms-2"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!opportunity) {
    return (
      <div className="container mt-4">
        <div className="alert alert-warning" role="alert">
          Opportunity not found
        </div>
      </div>
    );
  }

  return (
    <div className="container mt-4">
      <div className="row">
        <div className="col-12">
          {/* Back button */}
          <button 
            className="btn btn-outline-secondary mb-3"
            onClick={() => navigate('/')}
            style={{ color: '#ffffff' }}
          >
            ← Back to Impact Lab
          </button>


          {/* Error message */}
          {error && (
            <div className="alert alert-danger alert-dismissible fade show" role="alert">
              {error}
              <div className="mt-2">
                <button 
                  className="btn btn-sm btn-outline-danger me-2"
                  onClick={() => loadOpportunity(true)}
                  disabled={loading}
                >
                  <i className="bi bi-arrow-clockwise me-1"></i>
                  Refresh Data
                </button>
                <button 
                  className="btn btn-sm btn-danger me-2"
                  onClick={async () => {
                    setError('');
                    
                    // First, debug the booking situation
                    try {
                      const debugData = await getMyBookingsDebug();
                      console.log('=== DEBUG BOOKINGS DATA ===');
                      console.log('User ID:', debugData.user_id);
                      console.log('Total bookings:', debugData.total_bookings);
                      console.log('All bookings:', debugData.bookings);
                      
                      // Check for bookings for this specific opportunity
                      const sessionBookings = debugData.bookings.filter((b: any) => 
                        opportunity?.sessions?.some(s => s.id === b.session_id)
                      );
                      console.log('Bookings for this opportunity:', sessionBookings);
                      
                      if (sessionBookings.length > 0) {
                        alert(`Found ${sessionBookings.length} booking(s) for this opportunity. Check console for details.`);
                        return;
                      }
                    } catch (err) {
                      console.error('Error fetching debug data:', err);
                    }
                    
                    // If no bookings found, try to book
                    const sessionToRetry = opportunity?.sessions?.find(s => s.remaining > 0);
                    if (sessionToRetry) {
                      handleBookSession(sessionToRetry.id);
                    }
                  }}
                  disabled={loading}
                >
                  <i className="bi bi-arrow-repeat me-1"></i>
                  Retry Booking
                </button>
              </div>
              <button 
                type="button" 
                className="btn-close" 
                onClick={() => setError('')}
              ></button>
            </div>
          )}

          <div className="card">
            <div className="card-header">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <div className="d-flex align-items-center gap-2 mb-2">
                    <span className={getTypeBadgeClass(opportunity?.type)}>
                      {formatOpportunityType(opportunity?.type)}
                    </span>
                    {user?.role === 'researcher_admin' && (
                      <span className={getStatusBadgeClass(opportunity.status)}>
                        {opportunity.status}
                      </span>
                    )}
                  </div>
                  <h1 className="h3 mb-0">{opportunity.title}</h1>
                </div>
              </div>
            </div>
            
            <div className="card-body">
              {/* Three-column layout for opportunity details */}
              <div className="row mb-4">
                {/* Column 1: Purpose and Description */}
                <div className="col-md-4">
                  {/* Purpose - only show for non-question types */}
                  {opportunity.type !== 'question' && (
                    <div className="mb-3">
                      <h6 className="fw-bold">Purpose</h6>
                      <p className="text-muted mb-0">{opportunity.purpose_one_liner}</p>
                    </div>
                  )}

                  {/* Description */}
                  {opportunity.description_optional && (
                    <div className="mb-3">
                      <h6 className="fw-bold">Description</h6>
                      <p className="mb-0">{opportunity.description_optional}</p>
                    </div>
                  )}
                </div>

                {/* Column 2: Product and Duration */}
                <div className="col-md-4">
                  {/* Product - only show for non-question types */}
                  {opportunity.type !== 'question' && opportunity.product_optional && (
                    <div className="mb-3">
                      <h6 className="fw-bold">Product</h6>
                      <p className="mb-0">{opportunity.product_optional}</p>
                    </div>
                  )}

                  {/* Duration - only show for test and interview types */}
                  {(opportunity.type === 'test' || opportunity.type === 'interview') && (
                    <div className="mb-3">
                      <h6 className="fw-bold">Duration</h6>
                      <p className="mb-0">{opportunity.default_duration_minutes} minutes</p>
                    </div>
                  )}
                </div>

                {/* Column 3: Participants Sought */}
                <div className="col-md-4">
                  <div className="mb-3">
                    <h6 className="fw-bold">Participants Sought</h6>
                    <p className="mb-0">
                      {(() => {
                        switch (opportunity.participant_type_required) {
                          case 'any': return '👥 Any participants';
                          case 'internal': return '🏢 Internal employees only';
                          case 'external': return '🌐 External participants only';
                          case 'specific': 
                            return (
                              <>
                                <span>🎯 {opportunity.participant_type_specific_details || 'Specific participants'}</span>
                              </>
                            );
                          default: return '👥 Any participants';
                        }
                      })()}
                    </p>
                  </div>
                </div>
              </div>

              {/* Sessions for test and interview opportunities */}
              {(opportunity.type === 'test' || opportunity.type === 'interview') && (
                <>
                  {/* Help bar for test opportunities */}
                  {bookingSuccess ? (
                    <div className="alert alert-success d-flex justify-content-between align-items-center" style={{ marginBottom: '1.5rem' }}>
                      <div>
                        <i className="bi bi-check-circle me-2"></i>
                        {bookingSuccess}
                        <button 
                          className="btn btn-sm btn-outline-success ms-3"
                          onClick={() => navigate('/my-bookings')}
                        >
                          <i className="bi bi-calendar-check me-1"></i>
                          View My Bookings
                        </button>
                      </div>
                      <button 
                        type="button" 
                        className="btn-close" 
                        onClick={() => setBookingSuccess(null)}
                        aria-label="Close"
                      ></button>
                    </div>
                  ) : (
                    <div className="alert alert-info" style={{ marginBottom: '1.5rem' }}>
                      <i className="bi bi-info-circle me-2"></i>
                      Click on a timeslot to book yourself in
                    </div>
                  )}

                  {/* Calendar Integration */}
                  {user && (
                    <div className="card mb-4">
                      <div className="card-body">
                        <h6 className="card-title mb-3">
                          <i className="bi bi-calendar-check me-2"></i>
                          Calendar Integration
                        </h6>
                        <CalendarConnection onStatusChange={setCalendarConnected} />
                      </div>
                    </div>
                  )}
                  
                  <div className="mb-4">
                    <div className="d-flex justify-content-between align-items-center mb-3">
                      <h5>Available Sessions</h5>
                    <div className="d-flex gap-2">
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() => loadOpportunity(true)}
                        disabled={loading}
                        title="Refresh sessions data"
                      >
                        <i className={`bi bi-arrow-clockwise ${loading ? 'spinner-border spinner-border-sm' : ''}`}></i>
                        Refresh
                      </button>
                      <div className="btn-group" role="group">
                        <button
                          type="button"
                          className={`btn btn-sm ${viewMode === 'calendar' ? 'btn-primary' : 'btn-outline-primary'}`}
                          onClick={() => setViewMode('calendar')}
                        >
                          <i className="bi bi-calendar-grid me-1"></i>
                          Calendar
                        </button>
                        <button
                          type="button"
                          className={`btn btn-sm ${viewMode === 'table' ? 'btn-primary' : 'btn-outline-primary'}`}
                          onClick={() => setViewMode('table')}
                        >
                          <i className="bi bi-table me-1"></i>
                          Table
                        </button>
                      </div>
                    </div>
                  </div>

                  {opportunity.sessions && opportunity.sessions.length > 0 ? (
                    <>
                      {viewMode === 'calendar' ? (
                        <CalendarGrid
                          key={`calendar-${opportunity.id}-${opportunity.sessions?.length || 0}-${opportunity.sessions?.reduce((sum, s) => sum + s.booked_count, 0) || 0}`}
                          sessions={opportunity.sessions}
                          onBookSession={handleBookSession}
                          bookingLoading={bookingLoading}
                        />
                      ) : (
                        <div className="table-responsive">
                          <table className="table table-striped">
                            <thead>
                              <tr>
                                <th>Start Time</th>
                                <th>End Time</th>
                                <th>Capacity</th>
                                <th>Remaining</th>
                                <th>Location/Link</th>
                                <th>Action</th>
                              </tr>
                            </thead>
                            <tbody>
                              {opportunity.sessions
                                .filter(session => new Date(session.end_time) >= new Date()) // Only show future sessions
                                .map((session) => (
                                <tr key={session.id}>
                                  <td>{new Date(session.start_time).toLocaleString()}</td>
                                  <td>{new Date(session.end_time).toLocaleString()}</td>
                                  <td>{session.capacity}</td>
                                  <td>
                                    <span className={`badge ${session.remaining > 0 ? 'bg-success' : 'bg-danger'}`}>
                                      {session.remaining}
                                    </span>
                                  </td>
                                  <td>
                                    {session.location_or_meet_link_optional && (
                                      <small className="text-muted">
                                        {session.location_or_meet_link_optional.length > 30 
                                          ? `${session.location_or_meet_link_optional.substring(0, 30)}...`
                                          : session.location_or_meet_link_optional
                                        }
                                      </small>
                                    )}
                                  </td>
                                  <td>
                                    {session.remaining > 0 ? (
                                      <button 
                                        className="btn btn-primary btn-sm"
                                        onClick={() => handleBookSession(session.id)}
                                        disabled={bookingLoading === session.id}
                                      >
                                        {bookingLoading === session.id ? 'Booking...' : 'Book'}
                                      </button>
                                    ) : (
                                      <span className="badge bg-danger">Full</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="alert alert-info">
                      <i className="bi bi-info-circle me-2"></i>
                      Sessions will appear here when they are added by the researcher.
                    </div>
                  )}
                  </div>
                </>
              )}

              {/* External link for polls, surveys, and questions - only show if not test or interview */}
              {opportunity.type !== 'test' && opportunity.type !== 'interview' && (
                <div className="mb-4">
                  <div className="row">
                    <div className="col-md-4">
                      {opportunity.type === 'poll' ? (
                        <button 
                          className="btn btn-primary w-100"
                          onClick={() => navigate(`/poll/${opportunity.id}`)}
                        >
                          Open Poll
                        </button>
                      ) : (
                        <a 
                          href={opportunity.external_link_optional}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn btn-primary w-100"
                        >
                          {opportunity.type === 'question' ? 'Answer Question' : 'Participate'}
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer with owner info (admin only) */}
            {user?.role === 'researcher_admin' && opportunity.owner_name && (
              <div className="card-footer bg-light">
                <small className="text-muted">
                  <strong>Owner:</strong> {opportunity.owner_name} ({opportunity.owner_email})
                </small>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default OpportunityDetail;
