import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { getOpportunities } from '../api/client';
import { Opportunity } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import { formatOpportunityType, getTypeBadgeClass } from '../utils/opportunityUtils';
import Landing from './Landing';
import ErrorState from '../components/ErrorState';

const Home: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [showBookingSuccess, setShowBookingSuccess] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 6; // 6 studies per page (2 rows of 3 cards)
  
  const { user } = useAuth();

  // Redirect admin users to admin dashboard
  useEffect(() => {
    if (user?.role === 'researcher_admin') {
      navigate('/admin', { replace: true });
    }
  }, [user, navigate]);

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
        setError('No backend available. This is a production demo with frontend only.');
      } else if (typeof data === 'string' && data.includes('<!doctype html>')) {
        console.error('Received HTML instead of JSON - backend not deployed');
        setOpportunities([]);
        setError('Backend API not available');
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

  // Initial load (filters removed)
  useEffect(() => {
    loadOpportunities();
  }, []);

  // Force refresh on component mount to ensure fresh data
  useEffect(() => {
    // Small delay to ensure component is fully mounted
    const timer = setTimeout(() => {
      loadOpportunities();
    }, 50);
    return () => clearTimeout(timer);
  }, []); // Empty dependency array means this runs only on mount

  // Refresh opportunities when navigating to home page
  useEffect(() => {
    if (location.pathname === '/') {
      // Force refresh with a small delay to ensure navigation is complete
      setTimeout(() => {
        loadOpportunities();
      }, 100);
    }
  }, [location.pathname]);

  // Refresh opportunities when returning from admin (check for admin referrer)
  useEffect(() => {
    if (location.pathname === '/' && document.referrer.includes('/admin')) {
      // Force refresh when returning from admin
      setTimeout(() => {
        loadOpportunities();
      }, 200);
    }
  }, [location.pathname]);


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

  // Helper function to check if opportunity was recently updated (within last 3 days)
  const isRecentlyUpdated = (updatedAt: string): boolean => {
    const now = new Date();
    const updated = new Date(updatedAt);
    const daysSinceUpdate = (now.getTime() - updated.getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceUpdate <= 3;
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
      
      {/* Impact Lab Section */}
      {user && (
        <div className="container mt-4">
          <div className="row">
            <div className="col-12">
              <h2 className="mb-3">Impact Lab</h2>
              
              {/* Welcome text - half page width before wrapping */}
              <div className="row mb-4">
                <div className="col-md-6">
                  <p className="text-muted" style={{ lineHeight: '1.6', fontSize: '1rem' }}>
                    Welcome to the Impact Lab - every action you take here strengthens our group, sparks new ideas and helps us to leverage all the talent and experience that we have across TAG
                  </p>
                  <p style={{ lineHeight: '1.6', fontSize: '1.3rem', fontWeight: 'bold', marginTop: '1rem', color: '#ffffff' }}>
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
                  <p className="mb-2">No impact lab activities available at the moment.</p>
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
                <div className="row">
                  {paginatedOpportunities.map((opportunity) => (
                    <div key={opportunity.id} className="col-md-6 col-lg-4 mb-4">
                      <div className="card h-100">
                        <div className="card-body d-flex flex-column">
                          <div className="mb-2 d-flex justify-content-between align-items-center">
                            <span className={getTypeBadgeClass(opportunity.type)}>
                              {formatOpportunityType(opportunity.type)}
                            </span>
                            {isRecentlyUpdated(opportunity.updated_at) && (
                              <span className="badge bg-primary text-white" title="Recently updated">
                                ✨ New
                              </span>
                            )}
                          </div>
                          
                          <h5 className="card-title">{opportunity.title}</h5>
                          <p className="card-text text-muted">{opportunity.purpose_one_liner}</p>
                          
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
                                    <small className="text-muted">
                                      {opportunity.sessions.reduce((total, session) => total + (session.remaining || 0), 0)} slots available
                                    </small>
                                  </div>
                                )}
                                {opportunity.participant_type_required !== 'specific' && (
                                  <div className="mb-2">
                                    <small className="text-muted">
                                      {(() => {
                                        switch (opportunity.participant_type_required) {
                                          case 'any': return '👥 Open To All';
                                          case 'internal': return '🏢 Internal';
                                          case 'external': return '🌐 External';
                                          default: return '👥 Open To All';
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
                  ))}
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
