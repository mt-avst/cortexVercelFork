import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { getOpportunities } from '../api/client';
import { Opportunity } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import { formatOpportunityType, getTypeBadgeClass } from '../utils/opportunityUtils';
import Landing from './Landing';
import ErrorState from '../components/ErrorState';
import { Users, Lock, Globe } from 'lucide-react';

const Home: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [showBookingSuccess, setShowBookingSuccess] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 6; // 6 studies per page (2 rows of 3 cards)
  
  const { user, loading: authLoading, initialAuthCheck } = useAuth();

  // Redirect admin users to admin dashboard
  if (!authLoading && initialAuthCheck && user?.role === 'researcher_admin') {
    return <Navigate to="/admin" replace />;
  }

  const loadOpportunities = async () => {
    try {
      setLoading(true);
      setError('');
      console.log('Loading opportunities...');
      const data = await getOpportunities({});
      console.log('Loaded opportunities:', data?.length || 0, 'opportunities');
      
      // Ensure data is an array and not HTML
      if (!Array.isArray(data)) {
        console.error('API returned non-array data (backend may not be deployed):', typeof data);
        setOpportunities([]);
        if (typeof data === 'string' && (data as string).includes('<!doctype html>')) {
          console.error('Received HTML instead of JSON - backend not deployed');
          setError('Backend API not available');
        } else {
          setError('No backend available. This is a production demo with frontend only.');
        }
      } else {
        setOpportunities(data);
        if (data.length > 0) {
          console.log('First opportunity sessions:', data[0].sessions?.length || 0);
        }
      }
      setCurrentPage(1); // Reset to first page when data loads
    } catch (err: any) {
      console.error('Error loading opportunities:', err);
      setError('Failed to load opportunities - backend not available in production demo');
      setOpportunities([]); // Set empty array on error
    } finally {
      setLoading(false);
    }
  };

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
  }, [location.search, navigate]);

  // Hide banner when location changes (navigation away)
  useEffect(() => {
    if (showBookingSuccess && location.pathname !== '/') {
      setShowBookingSuccess(false);
    }
  }, [location.pathname, showBookingSuccess]);

  

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'published': return 'badge bg-success text-white';
      case 'draft': return 'badge bg-warning text-white';
      case 'closed': return 'badge bg-secondary text-white';
      default: return 'badge bg-secondary text-white';
    }
  };

  // Pagination logic - ensure opportunities is always an array
  const safeOpportunities = Array.isArray(opportunities) ? opportunities : [];
  const totalPages = Math.ceil(safeOpportunities.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedOpportunities = safeOpportunities.slice(startIndex, endIndex);

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    // Scroll to top when page changes
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

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
                  <i className="bi bi-check-circle me-2"></i>
                  Session booked. Thanks!
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* AdaptaLabs Section */}
      {user && (
        <div className="container mt-4">
          <div className="row" style={{ marginBottom: 'var(--spacing-section)' }}>
            <div className="col-12">
              <h1 className="mb-3" style={{ marginBottom: '24px' }}>AdaptaLabs</h1>
              
              {/* Welcome text - half page width before wrapping */}
              <div className="row mb-4">
                <div className="col-md-6">
                  <p className="lead" style={{ lineHeight: 'var(--line-height-body)', fontSize: 'var(--font-size-body)', marginBottom: '16px' }}>
                    Welcome to AdaptaLabs - every action you take here strengthens our group, sparks new ideas and helps us to leverage all the talent and experience that we have across TAG
                  </p>
                  <p className="tagline" style={{ lineHeight: 'var(--line-height-body)', fontSize: 'var(--font-size-body)', fontWeight: '600', marginTop: '1rem' }}>
                    Together we turn <span style={{ fontStyle: 'italic' }}>participation into progress</span>
                  </p>
                </div>
              </div>
              
              {error && (
                <div className="mb-4">
                  <ErrorState
                    title="Failed to load studies"
                    message={error}
                    actionLabel="Reload Studies"
                    onAction={loadOpportunities}
                    icon="bi-exclamation-triangle"
                  />
                </div>
              )}
              
              {!loading && !error && opportunities.length === 0 && (
                <div className="text-center text-muted py-5">
                  <i className="bi bi-inbox" style={{ fontSize: '3rem', display: 'block', marginBottom: '1rem', opacity: 0.3 }}></i>
                  <h4 className="mb-3">No studies available</h4>
                  <p className="mb-2">No AdaptaLabs activities available at the moment.</p>
                  <p style={{ fontSize: '0.9rem' }}>Check back later for new opportunities to participate!</p>
                </div>
              )}
              
              {/* Loading skeleton cards */}
              {loading && (
                <div className="row">
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
              
              {!loading && !error && opportunities.length > 0 && (
                <div className="bento-grid">
                  {paginatedOpportunities.map((opportunity) => {
                    // Make "New Feature Validation" and "User Interface Testing" wide
                    const isWide = opportunity.title === 'New Feature Validation' || opportunity.title === 'User Interface Testing';
                    
                    return (
                      <div 
                        key={opportunity.id} 
                        className={isWide ? 'bento-grid-item-wide' : 'bento-grid-item'}
                      >
                        <div className="card h-100">
                          <div className="card-body d-flex flex-column">
                            <div className="mb-2">
                              <span className={getTypeBadgeClass(opportunity.type)}>
                                {formatOpportunityType(opportunity.type)}
                              </span>
                            </div>
                            
                            <h5 className="card-title">{opportunity.title}</h5>
                            <p className="card-text" style={{ fontSize: 'var(--font-size-body)', lineHeight: '1.25', fontWeight: '400' }}>{opportunity.purpose_one_liner}</p>
                            
                            {opportunity.description_optional && (
                              <p className="card-text small">{opportunity.description_optional}</p>
                            )}
                            
                            <div className="mt-auto">
                              {(opportunity.type === 'test' || opportunity.type === 'interview') && (
                                <>
                                  <div className="mb-2">
                                    <small className="text-muted">
                                      <i className="bi bi-clock me-1"></i>
                                      {opportunity.default_duration_minutes} min
                                    </small>
                                  </div>
                                  {(opportunity.type === 'test' || opportunity.type === 'interview') && opportunity.sessions && opportunity.sessions.length > 0 && (
                                    <div className="mb-2">
                                      <small className="text-muted d-flex align-items-center">
                                        <Users size={14} className="me-1" style={{ opacity: 0.7 }} />
                                        {opportunity.sessions.reduce((total, session) => total + (session.remaining || 0), 0)} slots available
                                      </small>
                                    </div>
                                  )}
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
                              
                              {opportunity.participant_type_required === 'specific' && opportunity.participant_type_specific_details && (
                                <div className="mb-2">
                                  <small className="text-muted">🎯 {opportunity.participant_type_specific_details}</small>
                                </div>
                              )}
                              
                              <div className="d-grid">
                                <button 
                                  className="btn btn-primary"
                                  onClick={() => navigate(`/opportunities/${opportunity.id}`)}
                                  aria-label={`View details for ${opportunity.title}`}
                                >
                                  View Details
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Pagination Controls */}
              {!loading && !error && opportunities.length > itemsPerPage && (
                <div className="row mt-4">
                  <div className="col-12 d-flex justify-content-center align-items-center">
                    <nav aria-label="Page navigation">
                      <ul className="pagination mb-0">
                        <li className={`page-item ${currentPage === 1 ? 'disabled' : ''}`}>
                          <button 
                            className="page-link"
                            onClick={() => handlePageChange(currentPage - 1)}
                            disabled={currentPage === 1}
                            aria-label="Previous page"
                          >
                            <i className="bi bi-chevron-left"></i>
                          </button>
                        </li>
                        {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                          <li key={page} className={`page-item ${currentPage === page ? 'active' : ''}`}>
                            <button 
                              className="page-link"
                              onClick={() => handlePageChange(page)}
                              aria-label={`Go to page ${page}`}
                              aria-current={currentPage === page ? 'page' : undefined}
                            >
                              {page}
                            </button>
                          </li>
                        ))}
                        <li className={`page-item ${currentPage === totalPages ? 'disabled' : ''}`}>
                          <button 
                            className="page-link"
                            onClick={() => handlePageChange(currentPage + 1)}
                            disabled={currentPage === totalPages}
                            aria-label="Next page"
                          >
                            <i className="bi bi-chevron-right"></i>
                          </button>
                        </li>
                      </ul>
                    </nav>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default Home;
