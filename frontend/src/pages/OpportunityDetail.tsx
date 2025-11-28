import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getOpportunity, bookSession, trackOpportunityClick, getMyCalendarEvents } from '../api/client';
import { Opportunity, CalendarEvent, Session } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import CalendarGrid from '../components/CalendarGrid';
import ConfirmationModal from '../components/ConfirmationModal';
import { formatOpportunityType, getTypeBadgeClass, getCardHoverColor } from '../utils/opportunityUtils';
import { RefreshCw, RotateCcw, CheckCircle, CalendarCheck, Info, LayoutGrid, Table2, ExternalLink } from 'lucide-react';

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
  const [userCalendarEvents, setUserCalendarEvents] = useState<CalendarEvent[]>([]);
  const [loadingCalendar, setLoadingCalendar] = useState(false);
  // Table view booking confirmation state
  const [confirmBooking, setConfirmBooking] = useState<{ show: boolean; session: Session | null }>({ show: false, session: null });

  const loadOpportunity = async (forceRefresh = false) => {
    if (!id) return;
    
    try {
      setLoading(true);
      setError('');
      
      // Always use cache busting when force refreshing or when coming back to the page
      const params = forceRefresh ? { _t: Date.now() } : undefined;
      const data = await getOpportunity(id, params);
      
      setOpportunity(data);
    } catch (err: any) {
      console.error('Error loading opportunity:', err);
      
      // Provide more specific error messages
      if (err.response?.status === 404) {
        // Could be: opportunity doesn't exist, or it's a draft and user is not admin
        setError('Opportunity not found. It may have been deleted or you may not have permission to view it.');
      } else if (err.response?.status === 401) {
        setError('Please log in to view this opportunity.');
      } else if (err.response?.status === 403) {
        setError('You do not have permission to view this opportunity.');
      } else {
        const errorMessage = err.response?.data?.error || err.message || 'Failed to load opportunity';
        setError(`Failed to load opportunity: ${errorMessage}`);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Always force refresh when component mounts to ensure fresh data
    loadOpportunity(true);
  }, [id]);

  // Track view click when user opens the study details page
  useEffect(() => {
    if (opportunity && id) {
      // Track the view (user clicked to view study details)
      trackOpportunityClick(id, 'view').catch(() => {
        // Silently fail - tracking shouldn't block user experience
      });
    }
  }, [opportunity?.id]); // Only run once when opportunity is first loaded

  // Fetch calendar events when sessions are available
  useEffect(() => {
    const loadCalendarEvents = async () => {
      if (!opportunity?.sessions || opportunity.sessions.length === 0) {
        setUserCalendarEvents([]);
        return;
      }

      try {
        setLoadingCalendar(true);
        
        // Get date range from sessions
        const dates = opportunity.sessions
          .map(s => new Date(s.start_time))
          .sort((a, b) => a.getTime() - b.getTime());
        
        if (dates.length === 0) return;

        const startTime = new Date(dates[0]);
        startTime.setHours(0, 0, 0, 0);
        
        const endTime = new Date(dates[dates.length - 1]);
        endTime.setHours(23, 59, 59, 999);

        // Fetch calendar events
        const events = await getMyCalendarEvents(
          startTime.toISOString(),
          endTime.toISOString()
        );
        
        setUserCalendarEvents(events);
      } catch (error: any) {
        console.error('Error fetching calendar events:', error);
        // Don't show error to user, just log it
        setUserCalendarEvents([]);
      } finally {
        setLoadingCalendar(false);
      }
    };

    loadCalendarEvents();
  }, [opportunity?.sessions]);

  // Check if a session conflicts with user's calendar
  const hasCalendarConflict = useCallback((session: { start_time: string; end_time: string }): boolean => {
    if (userCalendarEvents.length === 0) {
      return false;
    }

    const sessionStart = new Date(session.start_time);
    const sessionEnd = new Date(session.end_time);

    const hasConflict = userCalendarEvents.some(event => {
      // Skip cancelled or declined events
      if (event.status === 'cancelled' || event.status === 'declined') {
        return false;
      }
      
      const eventStart = new Date(event.start);
      const eventEnd = new Date(event.end);
      
      // Skip if event times are invalid
      if (isNaN(eventStart.getTime()) || isNaN(eventEnd.getTime())) {
        return false;
      }
      
      // Check for actual overlap (not just touching)
      // Events overlap if: sessionStart < eventEnd AND sessionEnd > eventStart
      return (sessionStart < eventEnd && sessionEnd > eventStart);
    });
    
    return hasConflict;
  }, [userCalendarEvents]);

  // Refresh data when user returns to the page (handles browser back/forward)
  // Throttled to prevent excessive refreshes - only refresh if page was hidden for > 30 seconds
  useEffect(() => {
    let hiddenTime: number | null = null;
    
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Record when page became hidden
        hiddenTime = Date.now();
      } else if (!document.hidden && id && hiddenTime) {
        // Page became visible - only refresh if hidden for > 30 seconds
        const hiddenDuration = Date.now() - hiddenTime;
        if (hiddenDuration > 30000) {
          loadOpportunity(true);
        }
        hiddenTime = null;
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
      
      // Store the session ID for potential retry
      sessionStorage.setItem('lastAttemptedSession', sessionId);
      
      const bookingResult = await bookSession(sessionId);
      
      // Track action click for successful booking
      if (id) {
        trackOpportunityClick(id, 'action').catch(() => {
          // Silently fail - tracking shouldn't block user experience
        });
      }
      
      setBookingSuccess('Successfully booked! Check your bookings page.');
      
      // Small delay to ensure database transaction is committed
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Reload opportunity to update remaining slots with cache busting
      await loadOpportunity(true);
    } catch (err: any) {
      // Performance: verbose error logging disabled in production
      
      if (err.response?.status === 409) {
        // Use the specific error message from the backend
        const errorMessage = err.response?.data?.error || 'Session is full or you are already booked';
        setError(errorMessage);
        
        // If it's a capacity issue, refresh the opportunity data to get latest info
        if (errorMessage.includes('full') || errorMessage.includes('capacity')) {
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
      <div className="container mt-4" aria-busy="true" aria-live="polite">
        <h1>Loading Opportunity</h1>
        <div className="text-center py-5">
          <div className="spinner-border" role="status" aria-label="Loading opportunity">
            <span className="visually-hidden">Loading opportunity...</span>
          </div>
          <p className="mt-2">Loading opportunity...</p>
        </div>
      </div>
    );
  }

  if (error) {
    // If error is 404 and user is not admin, offer helpful guidance
    const is404Error = error.includes('not found') || error.includes('404');
    const isNotAdmin = !user || (user.role !== 'researcher_admin' && user.role !== 'superadmin');
    
    return (
      <div className="container mt-4">
        <h1>Opportunity Details</h1>
        <div className="alert alert-danger" role="alert">
          {error}
          <button 
            className="btn btn-sm btn-outline-danger ms-2"
            onClick={() => window.location.reload()}
            style={{ color: '#c82333', borderColor: '#c82333' }}
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
        <h1>Opportunity Details</h1>
        <div className="alert alert-warning" role="alert">
          Opportunity not found
        </div>
      </div>
    );
  }

  return (
    <div className="container-fluid py-4 opportunity-detail-page">
      <section className="container mt-4" aria-label="Opportunity details">
        <div className="row">
          <div className="col-12">
          {/* Back button */}
          <button 
            className="btn btn-outline-secondary mb-3"
            onClick={() => navigate('/')}
            aria-label="Navigate back to AdaptaLabs home"
          >
            ← Back to AdaptaLabs
          </button>


          {/* Error message */}
          {error && (
            <div className="alert alert-danger alert-dismissible fade show" role="alert" aria-live="assertive">
              {error}
              <div className="mt-2">
                <button 
                  className="btn btn-sm btn-outline-danger me-2"
                  onClick={() => loadOpportunity(true)}
                  disabled={loading}
                  aria-label="Refresh opportunity data"
                >
                  <RefreshCw size={14} className="me-1" aria-hidden="true" />
                  Refresh Data
                </button>
                <button 
                  className="btn btn-sm btn-danger me-2"
                  onClick={async () => {
                    setError('');
                    // Try to book a session
                    const sessionToRetry = opportunity?.sessions?.find(s => s.remaining > 0);
                    if (sessionToRetry) {
                      handleBookSession(sessionToRetry.id);
                    }
                  }}
                  disabled={loading}
                  aria-label="Retry booking a session"
                >
                  <RotateCcw size={14} className="me-1" aria-hidden="true" />
                  Retry Booking
                </button>
              </div>
              <button 
                type="button" 
                className="btn-close" 
                onClick={() => setError('')}
                aria-label="Close error message"
              ></button>
            </div>
          )}

          <div 
            className="card opportunity-detail-card"
            style={{ 
              borderTop: `4px solid ${getCardHoverColor(opportunity?.type)}`,
              borderLeft: '1px solid var(--border-subtle)',
              borderRight: '1px solid var(--border-subtle)',
              borderBottom: '1px solid var(--border-subtle)'
            }}
          >
            <div className="card-header" style={{ borderBottom: 'none', paddingBottom: 0 }}>
              {/* Hero Section - Two Column Layout */}
              <div className="opportunity-hero">
                {/* Left Column: Content */}
                <div className="opportunity-hero-content">
                  <div className="d-flex align-items-center gap-2 mb-3">
                    <span className={getTypeBadgeClass(opportunity?.type)}>
                      {formatOpportunityType(opportunity?.type)}
                    </span>
                    {(user?.role === 'researcher_admin' || user?.role === 'superadmin') && (
                      <span className={getStatusBadgeClass(opportunity.status)}>
                        {opportunity.status}
                      </span>
                    )}
                  </div>
                  <h1 className="opportunity-hero-title">{opportunity.title}</h1>
                  {/* Purpose/Description */}
                  {opportunity.type !== 'question' && opportunity.purpose_one_liner && (
                    <p className="opportunity-hero-description">{opportunity.purpose_one_liner}</p>
                  )}
                  {opportunity.description_optional && (
                    <p className="opportunity-hero-description" style={{ marginTop: '12px' }}>{opportunity.description_optional}</p>
                  )}
                </div>

                {/* Right Column: Metadata Box */}
                <div className="opportunity-hero-meta">
                  <div className="opportunity-hero-meta-grid">
                    {/* Product - only show for non-question types */}
                    {opportunity.type !== 'question' && opportunity.product_optional && (
                      <div className="meta-item">
                        <span className="meta-label">Product</span>
                        <span className="meta-value">{opportunity.product_optional}</span>
                      </div>
                    )}

                    {/* Duration - only show for test and interview types */}
                    {(opportunity.type === 'test' || opportunity.type === 'interview') && (
                      <div className="meta-item">
                        <span className="meta-label">Duration</span>
                        <span className="meta-value">{opportunity.default_duration_minutes} minutes</span>
                      </div>
                    )}

                    {/* Participants */}
                    <div className="meta-item">
                      <span className="meta-label">Participants Sought</span>
                      <span className="meta-value">
                        {(() => {
                          switch (opportunity.participant_type_required) {
                            case 'any': return 'Any participants';
                            case 'internal': return 'Internal employees only';
                            case 'external': return 'External participants only';
                            case 'specific': 
                              return opportunity.participant_type_specific_details || 'Specific participants';
                            default: return 'Any participants';
                          }
                        })()}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="card-body">

              {/* Sessions for test and interview opportunities */}
              {(opportunity.type === 'test' || opportunity.type === 'interview') && (
                <>
                  {/* Success message for bookings */}
                  {bookingSuccess && (
                    <div className="alert alert-success d-flex justify-content-between align-items-center" style={{ marginBottom: '1.5rem' }} role="alert" aria-live="polite">
                      <div>
                        <CheckCircle size={18} className="me-2" aria-hidden="true" />
                        {bookingSuccess}
                        <button 
                          className="btn btn-sm btn-outline-success ms-3"
                          onClick={() => navigate('/my-bookings')}
                          aria-label="Navigate to My Bookings page"
                        >
                          <CalendarCheck size={14} className="me-1" aria-hidden="true" />
                          View My Bookings
                        </button>
                      </div>
                      <button 
                        type="button" 
                        className="btn-close" 
                        onClick={() => setBookingSuccess(null)}
                        aria-label="Close success message"
                      ></button>
                    </div>
                  )}

                  {/* Calendar Integration */}
                  <div className="mb-4">
                    <div className="d-flex justify-content-between align-items-center mb-3">
                      {/* Header with inline hint */}
                      <div className="d-flex align-items-center gap-2">
                        <h5 className="mb-0">Available Sessions</h5>
                        {!bookingSuccess && (
                          <>
                            <span className="calendar-hint-divider" aria-hidden="true">•</span>
                            <span className="calendar-hint-inline" aria-label="Click a timeslot to book">
                              Click a timeslot to book
                            </span>
                          </>
                        )}
                      </div>
                      <div className="d-flex align-items-center gap-3">
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-secondary"
                          onClick={() => loadOpportunity(true)}
                          disabled={loading}
                          aria-label="Refresh sessions data"
                          title="Refresh sessions data"
                        >
                          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
                          <span className="visually-hidden">{loading ? 'Refreshing' : 'Refresh'}</span>
                          Refresh
                        </button>
                        <div className="btn-group" role="group" aria-label="View mode selection">
                          <button
                            type="button"
                            className={`btn btn-sm ${viewMode === 'calendar' ? 'btn-primary' : 'btn-outline-primary'}`}
                            onClick={() => setViewMode('calendar')}
                            aria-pressed={viewMode === 'calendar'}
                            aria-label="Switch to calendar view"
                          >
                            <LayoutGrid size={14} className="me-1" aria-hidden="true" />
                            Calendar
                          </button>
                          <button
                            type="button"
                            className={`btn btn-sm ${viewMode === 'table' ? 'btn-primary' : 'btn-outline-primary'}`}
                            onClick={() => setViewMode('table')}
                            aria-pressed={viewMode === 'table'}
                            aria-label="Switch to table view"
                          >
                            <Table2 size={14} className="me-1" aria-hidden="true" />
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
                        <>
                          {(() => {
                            // Filter sessions: only future sessions without calendar conflicts
                            const futureSessions = opportunity.sessions.filter(
                              session => new Date(session.end_time) >= new Date()
                            );
                            
                            const sessionsWithoutConflicts = futureSessions.filter(
                              session => !hasCalendarConflict(session)
                            );
                            
                            const conflictedCount = futureSessions.length - sessionsWithoutConflicts.length;
                            
                            return (
                              <>
                                {conflictedCount > 0 && (
                                  <div className="alert alert-info mb-3 d-flex align-items-center" style={{ marginBottom: '1rem' }}>
                                    <Info size={16} className="me-2" />
                                    {conflictedCount} conflicted slot{conflictedCount !== 1 ? 's' : ''} hidden from view
                                  </div>
                                )}
                                <div className="table-responsive momentum-table-container">
                                  <table className="table" aria-label="Available sessions">
                                    <thead>
                                      <tr>
                                        <th scope="col">Date</th>
                                        <th scope="col">Time</th>
                                        <th scope="col">Action</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {sessionsWithoutConflicts.length === 0 ? (
                                        <tr>
                                          <td colSpan={3} className="text-center py-4">
                                            <small className="text-muted">
                                              {futureSessions.length === 0 
                                                ? 'No available sessions'
                                                : 'All available sessions conflict with your calendar'}
                                            </small>
                                          </td>
                                        </tr>
                                      ) : (
                                        sessionsWithoutConflicts.map((session) => {
                                    const startDate = new Date(session.start_time);
                                    const endDate = new Date(session.end_time);
                                    
                                    // Format date (e.g., "Nov 5, 2025")
                                    const dateStr = startDate.toLocaleDateString('en-US', {
                                      month: 'short',
                                      day: 'numeric',
                                      year: 'numeric'
                                    });
                                    
                                    // Format timeslot (e.g., "9:00 AM to 9:30 AM")
                                    const startTimeStr = startDate.toLocaleTimeString('en-US', {
                                      hour: 'numeric',
                                      minute: '2-digit',
                                      hour12: true
                                    });
                                    const endTimeStr = endDate.toLocaleTimeString('en-US', {
                                      hour: 'numeric',
                                      minute: '2-digit',
                                      hour12: true
                                    });
                                    const timeSlotStr = `${startTimeStr} to ${endTimeStr}`;
                                    
                                    return (
                                      <tr key={session.id}>
                                        <td>{dateStr}</td>
                                        <td>{timeSlotStr}</td>
                                        <td>
                                          {session.remaining > 0 ? (
                                            <button 
                                              className="btn btn-primary btn-sm"
                                              onClick={() => setConfirmBooking({ show: true, session })}
                                              disabled={bookingLoading === session.id}
                                              aria-label={`Book session on ${dateStr} from ${timeSlotStr}`}
                                            >
                                              {bookingLoading === session.id ? (
                                                <>
                                                  <span className="visually-hidden">Booking session...</span>
                                                  Booking...
                                                </>
                                              ) : (
                                                'Book'
                                              )}
                                            </button>
                                          ) : (
                                            <span className="badge bg-danger" aria-label="Session is full">Full</span>
                                          )}
                                        </td>
                                      </tr>
                                    );
                                  })
                                      )}
                                    </tbody>
                                  </table>
                                </div>
                              </>
                            );
                          })()}
                        </>
                      )}
                    </>
                  ) : (
                    <div className="alert alert-info d-flex align-items-center">
                      <Info size={18} className="me-2" />
                      Sessions will appear here when they are added by the researcher.
                    </div>
                  )}
                  </div>
                </>
              )}

              {/* External link for polls, surveys, questions, and unmoderated - only show if not test or interview */}
              {opportunity.type !== 'test' && opportunity.type !== 'interview' && (
                <div className="mb-4">
                  <div className="row">
                    <div className="col-md-4">
                      {opportunity.type === 'poll' || opportunity.type === 'survey' || opportunity.type === 'unmoderated' ? (
                        <button 
                          className="btn btn-primary w-100"
                          onClick={async () => {
                            // Track action click before opening external link
                            if (opportunity.external_link_optional) {
                              await trackOpportunityClick(opportunity.id, 'action');
                              window.open(opportunity.external_link_optional, '_blank', 'noopener,noreferrer');
                            }
                          }}
                          disabled={!opportunity.external_link_optional}
                          aria-label={
                            opportunity.type === 'poll' ? 'Open poll in new tab' : 
                            opportunity.type === 'survey' ? 'Open survey in new tab' : 
                            'Start unmoderated test in new tab'
                          }
                          title={!opportunity.external_link_optional ? 'Link not available' : 'Opens in a new tab'}
                        >
                          {opportunity.type === 'poll' ? 'Open Poll' : 
                           opportunity.type === 'survey' ? 'Open Survey' : 
                           'Start Test'}
                        </button>
                      ) : (
                        <a 
                          href={opportunity.external_link_optional}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn btn-primary w-100"
                          aria-label={opportunity.type === 'question' ? 'Answer question in new tab' : 'Participate in new tab'}
                          onClick={async () => {
                            // Track click for questions too if desired (though M6 spec only mentions poll/survey)
                          }}
                        >
                          {opportunity.type === 'question' ? 'Answer Question' : 'Participate'}
                        </a>
                      )}
                    </div>
                  </div>
                  {(opportunity.type === 'poll' || opportunity.type === 'survey' || opportunity.type === 'unmoderated') && (
                    <div className="row mt-2">
                      <div className="col-md-4">
                        <small className="text-muted d-flex align-items-center">
                          <ExternalLink size={14} className="me-1" aria-hidden="true" />
                          Opens in a new tab
                        </small>
                      </div>
                    </div>
                  )}
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
      </section>

      {/* Table View Booking Confirmation Modal */}
      <ConfirmationModal
        show={confirmBooking.show}
        title="Confirm Booking"
        message={confirmBooking.session ? `Book this session?\n\n${new Date(confirmBooking.session.start_time).toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          year: 'numeric'
        })} at ${new Date(confirmBooking.session.start_time).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        })}` : 'Book this session?'}
        confirmLabel="Confirm"
        cancelLabel="Cancel"
        variant="primary"
        onConfirm={() => {
          if (confirmBooking.session) {
            handleBookSession(confirmBooking.session.id);
          }
          setConfirmBooking({ show: false, session: null });
        }}
        onCancel={() => setConfirmBooking({ show: false, session: null })}
      />
    </div>
  );
};

export default OpportunityDetail;
