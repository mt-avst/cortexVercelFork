import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getOpportunity, bookSession, trackOpportunityClick, getMyCalendarEvents } from '../api/client';
import { Opportunity, CalendarEvent } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import CalendarGrid from '../components/CalendarGrid';
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
  const [userCalendarEvents, setUserCalendarEvents] = useState<CalendarEvent[]>([]);
  const [loadingCalendar, setLoadingCalendar] = useState(false);

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
    <div className="container-fluid py-4" style={{ backgroundColor: '#0A091A', minHeight: '100vh' }}>
      <style>
        {`
          .opportunity-detail-page {
            background-color: #0A091A;
            min-height: 100vh;
          }
          .opportunity-detail-page .card {
            background-color: rgba(255, 255, 255, 0.05) !important;
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: 16px !important;
          }
          .opportunity-detail-page .card-header {
            background-color: transparent !important;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1) !important;
          }
          .opportunity-detail-page .card-body {
            background-color: transparent !important;
          }
          .opportunity-detail-page h1,
          .opportunity-detail-page h2,
          .opportunity-detail-page h3,
          .opportunity-detail-page h4,
          .opportunity-detail-page h5,
          .opportunity-detail-page h6 {
            color: var(--text-primary) !important;
          }
          .opportunity-detail-page .text-muted {
            color: var(--text-muted) !important;
          }
          .opportunity-detail-page p {
            color: var(--text-primary) !important;
          }
          .opportunity-detail-page .alert {
            background-color: rgba(255, 255, 255, 0.05) !important;
            border-color: rgba(255, 255, 255, 0.1) !important;
            color: var(--text-primary) !important;
          }
          .opportunity-detail-page .alert-info {
            background-color: rgba(33, 150, 243, 0.1) !important;
            border-color: rgba(33, 150, 243, 0.3) !important;
            color: #81d4fa !important;
          }
          .opportunity-detail-page .alert-success {
            background-color: rgba(40, 167, 69, 0.1) !important;
            border-color: rgba(40, 167, 69, 0.3) !important;
            color: #a5d6a7 !important;
          }
          .opportunity-detail-page .alert-danger {
            background-color: rgba(220, 53, 69, 0.1) !important;
            border-color: rgba(220, 53, 69, 0.3) !important;
            color: #ffcdd2 !important;
          }
          .opportunity-detail-page .alert-danger .btn-outline-danger {
            color: #c82333 !important;
            border-color: #c82333 !important;
          }
          .opportunity-detail-page .alert-danger .btn-outline-danger:hover {
            background-color: #c82333 !important;
            border-color: #c82333 !important;
            color: #FFFFFF !important;
          }
          .opportunity-detail-page .alert-warning {
            background-color: rgba(255, 193, 7, 0.1) !important;
            border-color: rgba(255, 193, 7, 0.3) !important;
            color: #ffe082 !important;
          }
          .opportunity-detail-page .btn-outline-secondary {
            border-color: rgba(255, 255, 255, 0.2) !important;
            color: var(--text-primary) !important;
          }
          .opportunity-detail-page .btn-outline-secondary:hover {
            background-color: rgba(255, 255, 255, 0.1) !important;
            border-color: rgba(255, 255, 255, 0.3) !important;
            color: #FFFFFF !important;
          }
          .opportunity-detail-page .btn-primary {
            background-color: #FF4E50 !important;
            border-color: #FF4E50 !important;
            color: #FFFFFF !important;
          }
          .opportunity-detail-page .btn-primary:hover {
            background-color: #ff5e60 !important;
            border-color: #ff5e60 !important;
          }
          .opportunity-detail-page .btn-outline-primary {
            border-color: #FF4E50 !important;
            color: #FF4E50 !important;
            background-color: transparent !important;
          }
          .opportunity-detail-page .btn-outline-primary:hover {
            background-color: #FF4E50 !important;
            border-color: #FF4E50 !important;
            color: #FFFFFF !important;
          }
          .opportunity-detail-page .btn-outline-success {
            border-color: #28a745 !important;
            color: #28a745 !important;
            background-color: transparent !important;
          }
          .opportunity-detail-page .btn-outline-success:hover {
            background-color: #28a745 !important;
            border-color: #28a745 !important;
            color: #FFFFFF !important;
          }
          .opportunity-detail-page .btn-outline-danger {
            border-color: #dc3545 !important;
            color: #dc3545 !important;
            background-color: transparent !important;
          }
          .opportunity-detail-page .btn-outline-danger:hover {
            background-color: #dc3545 !important;
            border-color: #dc3545 !important;
            color: #FFFFFF !important;
          }
          .opportunity-detail-page .btn-danger {
            background-color: #dc3545 !important;
            border-color: #dc3545 !important;
            color: #FFFFFF !important;
          }
          .opportunity-detail-page .btn-danger:hover {
            background-color: #c82333 !important;
            border-color: #c82333 !important;
          }
          .opportunity-detail-page .btn-success {
            background-color: #28a745 !important;
            border-color: #28a745 !important;
            color: #FFFFFF !important;
          }
          .opportunity-detail-page .btn-success:hover {
            background-color: #218838 !important;
            border-color: #218838 !important;
          }
          /* Override Bootstrap table defaults */
          .opportunity-detail-page .table,
          .opportunity-detail-page table.table {
            background-color: transparent !important;
            background: transparent !important;
            color: var(--text-primary) !important;
          }
          .opportunity-detail-page .table-responsive {
            background-color: transparent !important;
            background: transparent !important;
          }
          .opportunity-detail-page table thead {
            background-color: var(--bg-card) !important;
            background: var(--bg-card) !important;
          }
          .opportunity-detail-page table thead th {
            background-color: var(--bg-card) !important;
            background: var(--bg-card) !important;
            color: var(--text-primary) !important;
            border-color: var(--border-card) !important;
          }
          .opportunity-detail-page table tbody {
            background-color: transparent !important;
            background: transparent !important;
          }
          .opportunity-detail-page table tbody tr {
            background-color: transparent !important;
            background: transparent !important;
          }
          .opportunity-detail-page table tbody td {
            background-color: transparent !important;
            background: transparent !important;
            color: var(--text-primary) !important;
          }
        `}
      </style>
      <section className="container mt-4 opportunity-detail-page" aria-label="Opportunity details">
        <div className="row">
          <div className="col-12">
          {/* Back button */}
          <button 
            className="btn btn-outline-secondary mb-3"
            onClick={() => navigate('/')}
            style={{ color: '#ffffff' }}
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
                  <i className="bi bi-arrow-clockwise me-1" aria-hidden="true"></i>
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
                  <i className="bi bi-arrow-repeat me-1" aria-hidden="true"></i>
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

          <div className="card">
            <div className="card-header">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <div className="d-flex align-items-center gap-2 mb-4">
                    <span className={getTypeBadgeClass(opportunity?.type)}>
                      {formatOpportunityType(opportunity?.type)}
                    </span>
                    {(user?.role === 'researcher_admin' || user?.role === 'superadmin') && (
                      <span className={getStatusBadgeClass(opportunity.status)}>
                        {opportunity.status}
                      </span>
                    )}
                  </div>
                  <h1 className="mb-0">{opportunity.title}</h1>
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
                      <p className="mb-0" style={{ color: 'var(--text-primary)', fontSize: 'var(--font-size-body)', lineHeight: '1.25' }}>{opportunity.purpose_one_liner}</p>
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
                    <div className="alert alert-success d-flex justify-content-between align-items-center" style={{ marginBottom: '1.5rem' }} role="alert" aria-live="polite">
                      <div>
                        <i className="bi bi-check-circle me-2" aria-hidden="true"></i>
                        {bookingSuccess}
                        <button 
                          className="btn btn-sm btn-outline-success ms-3"
                          onClick={() => navigate('/my-bookings')}
                          aria-label="Navigate to My Bookings page"
                        >
                          <i className="bi bi-calendar-check me-1" aria-hidden="true"></i>
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
                  ) : (
                    <div className="alert alert-info" style={{ marginBottom: '1.5rem' }} role="status">
                      <i className="bi bi-info-circle me-2" aria-hidden="true"></i>
                      Click on a timeslot to book yourself in
                    </div>
                  )}

                  {/* Calendar Integration */}
                  <div className="mb-4">
                    <div className="d-flex justify-content-between align-items-center mb-3">
                      <h5>Available Sessions</h5>
                    <div className="d-flex gap-2">
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() => loadOpportunity(true)}
                        disabled={loading}
                        aria-label="Refresh sessions data"
                        title="Refresh sessions data"
                      >
                        <i className={`bi bi-arrow-clockwise ${loading ? 'spinner-border spinner-border-sm' : ''}`} aria-hidden="true"></i>
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
                          <i className="bi bi-calendar-grid me-1" aria-hidden="true"></i>
                          Calendar
                        </button>
                        <button
                          type="button"
                          className={`btn btn-sm ${viewMode === 'table' ? 'btn-primary' : 'btn-outline-primary'}`}
                          onClick={() => setViewMode('table')}
                          aria-pressed={viewMode === 'table'}
                          aria-label="Switch to table view"
                        >
                          <i className="bi bi-table me-1" aria-hidden="true"></i>
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
                          <style>
                            {`
                              /* Momentum Design System - Table List View */
                              .momentum-table-container {
                                background: transparent !important;
                                background-color: transparent !important;
                                border-radius: 16px;
                                overflow: hidden;
                              }
                              .momentum-table-container .table,
                              .momentum-table-container table,
                              .momentum-table-container table.table {
                                width: 100%;
                                border-collapse: separate;
                                border-spacing: 0;
                                background: transparent !important;
                                background-color: transparent !important;
                                --bs-table-bg: transparent !important;
                                --bs-table-color: #E0E0E0 !important;
                              }
                              .momentum-table-container thead,
                              .momentum-table-container .table > thead,
                              .momentum-table-container table > thead {
                                background: rgba(255, 255, 255, 0.08) !important;
                                background-color: rgba(255, 255, 255, 0.08) !important;
                                backdrop-filter: blur(16px);
                                -webkit-backdrop-filter: blur(16px);
                              }
                              .momentum-table-container thead th,
                              .momentum-table-container .table > thead > tr > th,
                              .momentum-table-container table > thead > tr > th,
                              .momentum-table-container thead tr th {
                                background: rgba(255, 255, 255, 0.08) !important;
                                background-color: rgba(255, 255, 255, 0.08) !important;
                                color: #E0E0E0 !important;
                                border-bottom: 1px solid rgba(255, 255, 255, 0.15) !important;
                                border-top: none !important;
                                border-left: none !important;
                                border-right: none !important;
                                font-weight: 600;
                                padding: 16px 12px;
                                font-size: 15px;
                                vertical-align: middle;
                                --bs-table-bg: rgba(255, 255, 255, 0.08) !important;
                              }
                              .momentum-table-container tbody,
                              .momentum-table-container .table > tbody,
                              .momentum-table-container table > tbody {
                                background: transparent !important;
                                background-color: transparent !important;
                              }
                              .momentum-table-container tbody tr,
                              .momentum-table-container .table > tbody > tr,
                              .momentum-table-container table > tbody > tr {
                                background: transparent !important;
                                background-color: transparent !important;
                                border-bottom: 1px solid rgba(255, 255, 255, 0.05) !important;
                                transition: background-color 180ms ease;
                                --bs-table-bg: transparent !important;
                              }
                              .momentum-table-container tbody tr:hover,
                              .momentum-table-container .table > tbody > tr:hover,
                              .momentum-table-container table > tbody > tr:hover {
                                background: rgba(255, 255, 255, 0.05) !important;
                                background-color: rgba(255, 255, 255, 0.05) !important;
                                --bs-table-hover-bg: rgba(255, 255, 255, 0.05) !important;
                              }
                              .momentum-table-container tbody td,
                              .momentum-table-container .table > tbody > tr > td,
                              .momentum-table-container table > tbody > tr > td,
                              .momentum-table-container tbody tr td {
                                background: transparent !important;
                                background-color: transparent !important;
                                color: #E0E0E0 !important;
                                border: none !important;
                                border-bottom: 1px solid rgba(255, 255, 255, 0.05) !important;
                                padding: 16px 12px;
                                vertical-align: middle;
                                font-size: 15px;
                                --bs-table-bg: transparent !important;
                              }
                              .momentum-table-container tbody td small {
                                color: rgba(224, 224, 224, 0.7) !important;
                                font-size: 14px;
                              }
                              .momentum-table-container .badge {
                                color: #FFFFFF !important;
                              }
                              /* Override Bootstrap table striping */
                              .momentum-table-container .table-striped > tbody > tr:nth-of-type(odd) > * {
                                background-color: transparent !important;
                                --bs-table-bg-type: transparent !important;
                              }
                            `}
                          </style>
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
                                  <div className="alert alert-info mb-3" style={{ marginBottom: '1rem' }}>
                                    <i className="bi bi-info-circle me-2"></i>
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
                                              onClick={() => handleBookSession(session.id)}
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
                    <div className="alert alert-info">
                      <i className="bi bi-info-circle me-2"></i>
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
                        <small className="text-muted">
                          <i className="bi bi-box-arrow-up-right me-1" aria-hidden="true"></i>
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
    </div>
  );
};

export default OpportunityDetail;
