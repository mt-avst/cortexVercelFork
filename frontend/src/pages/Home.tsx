import React, { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { getOpportunities } from '../api/client';
import { Opportunity } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import { formatOpportunityType, getTypeBadgeClass, getCardHoverColor, getStudyDateRange, getTimeRemaining, isExternalLinkType, getDirectDateRange, getDirectTimeRemaining } from '../utils/opportunityUtils';
import Landing from './Landing';
import ErrorState from '../components/ErrorState';
import { Lock, Globe, Calendar, Clock, Timer, CheckCircle, Inbox, Filter } from 'lucide-react';

/**
 * Home Page Component
 * Displays the main landing page and opportunity listings.
 */
const Home: React.FC = memo(() => {
  const navigate = useNavigate();
  const location = useLocation();
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [showBookingSuccess, setShowBookingSuccess] = useState(false);
  const [selectedType, setSelectedType] = useState<string>('all');
  
  const { user, loading: authLoading, initialAuthCheck } = useAuth();

  // Memoized check for admin redirect
  const shouldRedirectToAdmin = useMemo(() => {
    return !authLoading && initialAuthCheck && (user?.role === 'researcher_admin' || user?.role === 'superadmin');
  }, [authLoading, initialAuthCheck, user?.role]);

  // Load opportunities function - memoized to prevent recreation
  const loadOpportunities = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const data = await getOpportunities({});
      
      // Ensure data is an array and not HTML
      if (!Array.isArray(data)) {
        setOpportunities([]);
        if (typeof data === 'string' && (data as string).includes('<!doctype html>')) {
          setError('Backend API not available');
        } else {
          setError('No backend available. This is a production demo with frontend only.');
        }
      } else {
        setOpportunities(data);
      }
    } catch (err: any) {
      setError('Failed to load opportunities - backend not available in production demo');
      setOpportunities([]); // Set empty array on error
    } finally {
      setLoading(false);
    }
  }, []);

  // Consolidated effect to load opportunities - prevents duplicate API calls
  useEffect(() => {
    // Only load if we're on the home page
    if (location.pathname !== '/') {
      return;
    }

    // Use a small delay to ensure component is fully mounted and navigation is complete
    // Also check if returning from admin to ensure fresh data
    const isReturningFromAdmin = document.referrer.includes('/admin');
    const delay = isReturningFromAdmin ? 150 : 50;

    const timer = setTimeout(() => {
      loadOpportunities();
    }, delay);

    return () => clearTimeout(timer);
  }, [location.pathname]); // Only re-run when pathname changes


  // Check for booking success parameter and show banner
  useEffect(() => {
    const urlParams = new URLSearchParams(location.search);
    if (urlParams.get('bookingSuccess') === 'true') {
      setShowBookingSuccess(true);
      // Clean up URL parameter
      navigate('/', { replace: true });
    }
    
    // Check for OAuth error parameters
    const authError = urlParams.get('error');
    if (authError === 'google_auth_failed') {
      const errorDetails = urlParams.get('details') || 'Authentication failed';
      setError(`Login failed: ${decodeURIComponent(errorDetails)}. Please try again.`);
      // Clean up URL parameter
      navigate('/', { replace: true });
    }
  }, [location.search, navigate]);

  // Hide banner when location changes (navigation away)
  useEffect(() => {
    if (showBookingSuccess && location.pathname !== '/') {
      setShowBookingSuccess(false);
    }
  }, [location.pathname, showBookingSuccess]);

  // Memoized status badge class getter
  const getStatusBadgeClass = useCallback((status: string) => {
    switch (status) {
      case 'published': return 'badge bg-success text-white';
      case 'draft': return 'badge bg-warning text-white';
      case 'closed': return 'badge bg-secondary text-white';
      default: return 'badge bg-secondary text-white';
    }
  }, []);

  // Memoized filtered and arranged opportunities
  const filteredOpportunities = useMemo(() => {
    const safeOpportunities = Array.isArray(opportunities) ? opportunities : [];
    
    // Filter by type
    const filteredByType = selectedType === 'all' 
      ? safeOpportunities 
      : safeOpportunities.filter(opp => {
          const baseType = opp.type?.toLowerCase().replace(/published|draft|closed$/, '') || '';
          return baseType === selectedType.toLowerCase();
        });
    
    // Sort by type (test first)
    const sortedByType = [...filteredByType].sort((a, b) => {
      const aType = a.type?.toLowerCase().replace(/published|draft|closed$/, '') || '';
      const bType = b.type?.toLowerCase().replace(/published|draft|closed$/, '') || '';
      const aIsTest = aType === 'test';
      const bIsTest = bType === 'test';
      if (aIsTest && !bIsTest) return -1;
      if (!aIsTest && bIsTest) return 1;
      return 0;
    });
    
    // Arrange for bento grid layout
    const doubles = sortedByType.filter(o => o.display_width === 'double');
    const singles = sortedByType.filter(o => o.display_width !== 'double');
    const result: Array<Opportunity & { _gridPosition?: 'left' | 'right' }> = [];
    
    let doubleIndex = 0;
    let singleIndex = 0;
    let rowNumber = 0;
    
    while (doubleIndex < doubles.length || singleIndex < singles.length) {
      rowNumber++;
      
      if (rowNumber % 2 === 1) {
        if (doubleIndex < doubles.length) {
          result.push({ ...doubles[doubleIndex++], _gridPosition: 'left' as const });
          if (singleIndex < singles.length) {
            result.push(singles[singleIndex++]);
          }
        } else {
          for (let i = 0; i < 3 && singleIndex < singles.length; i++) {
            result.push(singles[singleIndex++]);
          }
        }
      } else {
        if (doubleIndex < doubles.length) {
          if (singleIndex < singles.length) {
            result.push(singles[singleIndex++]);
          }
          result.push({ ...doubles[doubleIndex++], _gridPosition: 'right' as const });
        } else {
          for (let i = 0; i < 3 && singleIndex < singles.length; i++) {
            result.push(singles[singleIndex++]);
          }
        }
      }
    }
    
    return result;
  }, [opportunities, selectedType]);

  // Admin redirect - placed after all hooks to comply with React's rules
  if (shouldRedirectToAdmin) {
    return <Navigate to="/admin" replace />;
  }

  return (
    <>
      {!user && (
        <div className="mb-4">
          <Landing />
        </div>
      )}
      {/* Success Banner */}
      {showBookingSuccess && (
        <div className="booking-success-banner">
          <div className="container">
            <div className="row">
              <div className="col-12">
                <div className="alert alert-success mb-0 text-center">
                  <CheckCircle size={18} className="me-2" />
                  Session booked. Thanks!
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* AdaptaLabs Section */}
      {user && (
        <div className="container mt-4" style={{ position: 'relative', zIndex: 10 }}>
          <div className="row" style={{ marginBottom: 'var(--spacing-section)' }}>
            <div className="col-12">
              <h1 className="mb-3 adaptalabs-home-title">AdaptaLabs</h1>
              
              {/* Welcome text and filter - aligned with bento grid */}
              <div className="home-header-grid mb-4">
                <div className="home-header-text">
                  <p className="lead mb-3">
                    Welcome to AdaptaLabs - every action you take here strengthens our group, sparks new ideas and helps us to leverage all the talent and experience that we have across TAG
                  </p>
                  <p className="tagline fw-semibold mt-3 mb-0">
                    Together we turn <span className="fst-italic">participation into progress</span>
                  </p>
                </div>
                {/* Type filter dropdown - aligned with third column */}
                {!loading && !error && opportunities.length > 0 && (
                  <div className="home-header-filter">
                    <label htmlFor="opportunity-type-filter" className="visually-hidden">
                      Filter opportunities by study type
                    </label>
                    <select 
                      id="opportunity-type-filter"
                      className="form-select study-type-filter" 
                      value={selectedType} 
                      onChange={(e) => setSelectedType(e.target.value)}
                      aria-label="Filter opportunities by study type"
                      style={{
                        width: '100%',
                        backgroundColor: 'var(--bg-card)',
                        color: 'var(--text-primary)',
                        fontSize: 'var(--font-size-body)'
                      }}
                    >
                      <option value="all">Filter by study type</option>
                      <option value="survey">Survey</option>
                      <option value="poll">Poll</option>
                      <option value="interview">Interview</option>
                      <option value="test">App Testing</option>
                      <option value="question">Question</option>
                    </select>
                  </div>
                )}
              </div>
              
              {error && (
                <div className="mb-4">
                  <ErrorState
                    title="Failed to load studies"
                    message={error}
                    actionLabel="Reload Studies"
                    onAction={loadOpportunities}
                    icon="alert-triangle"
                  />
                </div>
              )}
              
              {!loading && !error && opportunities.length === 0 && (
                <div className="empty-state">
                  <Inbox size={48} className="empty-state-icon" />
                  <h4 className="empty-state-title">No studies available</h4>
                  <p className="mb-2">No AdaptaLabs activities available at the moment.</p>
                  <p className="empty-state-text">Check back later for new opportunities to participate!</p>
                </div>
              )}
              
              {!loading && !error && opportunities.length > 0 && filteredOpportunities.length === 0 && (
                <div className="empty-state">
                  <Filter size={48} className="empty-state-icon" />
                  <h4 className="empty-state-title">No opportunities found</h4>
                  <p className="mb-2">No opportunities match the selected filter.</p>
                  <button 
                    className="btn btn-outline-primary mt-3" 
                    onClick={() => setSelectedType('all')}
                  >
                    Show All Types
                  </button>
                </div>
              )}
              
              {/* Loading skeleton cards */}
              {loading && (
                <div className="row" aria-busy="true" aria-live="polite" aria-label="Loading opportunities">
                  {[...Array(6)].map((_, index) => (
                    <div key={index} className="col-md-6 col-lg-4 mb-4">
                      <div className="card h-100">
                        <div className="card-body d-flex flex-column">
                          <div className="mb-2">
                            <div className="badge bg-secondary" style={{ width: '80px', height: '24px' }}></div>
                          </div>
                          <div className="mb-3">
                            <div className="placeholder-glow">
                              <span className="placeholder col-11" style={{ height: '24px' }}></span>
                            </div>
                            <div className="placeholder-glow mt-2">
                              <span className="placeholder col-10" style={{ height: '16px' }}></span>
                            </div>
                          </div>
                          <div className="mt-auto">
                            <div className="placeholder-glow mb-2">
                              <span className="placeholder col-6" style={{ height: '14px' }}></span>
                            </div>
                            <div className="placeholder-glow">
                              <span className="placeholder col-12" style={{ height: '38px' }}></span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              {!loading && !error && opportunities.length > 0 && filteredOpportunities.length > 0 && (
                <div className="bento-grid">
                  {filteredOpportunities.map((opportunity, index) => {
                    // Use display_width from database (set by superadmin), default to single
                    const isWide = opportunity.display_width === 'double';
                    // Use _gridPosition to determine if double-width should be on left or right
                    const gridPosition = (opportunity as any)._gridPosition;
                    const gridClass = isWide 
                      ? (gridPosition === 'right' ? 'bento-grid-item-wide-right' : 'bento-grid-item-wide')
                      : 'bento-grid-item';
                    
                    return (
                      <div 
                        key={opportunity.id} 
                        className={gridClass}
                      >
                        <div 
                          className="card card-clickable" 
                          style={{ '--dynamic-hover-color': getCardHoverColor(opportunity.type) } as React.CSSProperties}
                          onClick={() => navigate(`/opportunities/${opportunity.id}`)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              navigate(`/opportunities/${opportunity.id}`);
                            }
                          }}
                          aria-label={`View ${opportunity.title}`}
                        >
                          <div className="card-body opportunity-card-body">
                            <div className="mb-4">
                              <span className={getTypeBadgeClass(opportunity.type)}>
                                {formatOpportunityType(opportunity.type)}
                              </span>
                            </div>
                            
                            <h2 className="card-title h5">{opportunity.title}</h2>
                            <p className="card-text">{opportunity.purpose_one_liner}</p>
                            
                            {opportunity.description_optional && (
                              <p className="card-text small">{opportunity.description_optional}</p>
                            )}
                            
                            <div className="card-content-bottom">
                              {/* Timing Info Section - Bookable Types (Test/Interview) */}
                              {(opportunity.type === 'test' || opportunity.type === 'interview') && (
                                <>
                                  {/* Study Period, Time Remaining, Duration and Slots */}
                                  {(() => {
                                    const hasSessions = opportunity.sessions && opportunity.sessions.length > 0;
                                    const dateRange = hasSessions ? getStudyDateRange(opportunity.sessions!) : { formatted: null };
                                    const timeRemaining = hasSessions ? getTimeRemaining(opportunity.sessions!) : { text: null, urgency: 'normal' };
                                    
                                    return (
                                      <div className="timing-info">
                                        {/* Duration Row */}
                                        <div className="d-flex flex-wrap gap-3 mb-1">
                                          <small className="text-muted d-flex align-items-center">
                                            <Clock size={14} className="me-1 opacity-75" />
                                            {opportunity.default_duration_minutes} min session
                                          </small>
                                        </div>

                                        {/* Date Range Row */}
                                        {hasSessions && dateRange.formatted && (
                                          <div className="d-flex align-items-center mb-1">
                                            <Calendar size={14} className="me-2 opacity-75 flex-shrink-0" />
                                            <small className="text-muted">{dateRange.formatted}</small>
                                          </div>
                                        )}
                                        {/* Time Remaining Row */}
                                        {hasSessions && timeRemaining.text && (
                                          <div className="d-flex align-items-center">
                                            <Timer size={14} className="me-2 opacity-75 flex-shrink-0" />
                                            <small className={`timing-urgency-${timeRemaining.urgency} fw-medium`}>
                                              {timeRemaining.text}
                                            </small>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })()}
                                  
                                  {/* Participant Type */}
                                  {opportunity.participant_type_required !== 'specific' && (
                                    <div className="mb-2">
                                      <small className="text-muted d-flex align-items-center">
                                        {(() => {
                                          switch (opportunity.participant_type_required) {
                                            case 'any': 
                                              return (
                                                <>
                                                  <Globe size={14} className="me-1" style={{ opacity: 0.7 }} />
                                                  Open To All
                                                </>
                                              );
                                            case 'internal': 
                                              return (
                                                <>
                                                  <Lock size={14} className="me-1" style={{ opacity: 0.7 }} />
                                                  Internal
                                                </>
                                              );
                                            case 'external': 
                                              return (
                                                <>
                                                  <Globe size={14} className="me-1" style={{ opacity: 0.7 }} />
                                                  External
                                                </>
                                              );
                                            default: 
                                              return (
                                                <>
                                                  <Globe size={14} className="me-1" style={{ opacity: 0.7 }} />
                                                  Open To All
                                                </>
                                              );
                                          }
                                        })()}
                                      </small>
                                    </div>
                                  )}
                                </>
                              )}
                              
                              {/* Timing Info Section - External Link Types (Poll/Survey/Question/Unmoderated) */}
                              {isExternalLinkType(opportunity.type) && (() => {
                                const dateRange = getDirectDateRange(opportunity);
                                const timeRemaining = getDirectTimeRemaining(opportunity);
                                
                                return (
                                  <div className="timing-info mb-3 p-2" style={{ 
                                    backgroundColor: 'rgba(255, 255, 255, 0.05)', 
                                    borderRadius: '6px',
                                    border: '1px solid rgba(255, 255, 255, 0.1)'
                                  }}>
                                    {/* Date Range Row - only if dates are set */}
                                    {dateRange.formatted && (
                                      <div className="d-flex align-items-center mb-1">
                                        <Calendar size={14} className="me-2" style={{ opacity: 0.7, flexShrink: 0 }} />
                                        <small style={{ color: 'var(--text-muted)' }}>{dateRange.formatted}</small>
                                      </div>
                                    )}
                                    {/* Time Remaining Row - only if end date is set */}
                                    {timeRemaining.text && (
                                      <div className="d-flex align-items-center mb-1">
                                        <Timer size={14} className="me-2" style={{ opacity: 0.7, flexShrink: 0 }} />
                                        <small style={{ 
                                          color: timeRemaining.urgency === 'critical' ? 'var(--accent-coral)' :
                                                 timeRemaining.urgency === 'warning' ? 'var(--accent-amber)' :
                                                 timeRemaining.urgency === 'ended' ? 'var(--text-muted)' :
                                                 'var(--accent-teal)',
                                          fontWeight: timeRemaining.urgency === 'critical' || timeRemaining.urgency === 'warning' ? '600' : 'normal'
                                        }}>
                                          {timeRemaining.text}
                                        </small>
                                      </div>
                                    )}
                                    {/* Duration Row */}
                                    <div className="d-flex align-items-center">
                                      <Clock size={14} className="me-2" style={{ opacity: 0.7, flexShrink: 0 }} />
                                      <small style={{ color: 'var(--text-muted)' }}>
                                        ~{opportunity.default_duration_minutes || 5} min to complete
                                      </small>
                                    </div>
                                  </div>
                                );
                              })()}
                              
                              {opportunity.participant_type_required === 'specific' && opportunity.participant_type_specific_details && (
                                <div className="mb-2">
                                  <small className="text-muted">🎯 {opportunity.participant_type_specific_details}</small>
                                </div>
                              )}
                              
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
});

Home.displayName = 'Home';

export default Home;
