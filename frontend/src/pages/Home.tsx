import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { getOpportunities } from '../api/client';
import { Opportunity } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import { formatOpportunityType, getTypeBadgeClass } from '../utils/opportunityUtils';
import Landing from './Landing';

const Home: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [showBookingSuccess, setShowBookingSuccess] = useState(false);
  
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
      console.log('Loaded opportunities:', data.length, 'opportunities');
      if (data.length > 0) {
        console.log('First opportunity sessions:', data[0].sessions?.length || 0);
      }
      setOpportunities(data);
    } catch (err) {
      console.error('Error loading opportunities:', err);
      setError('Failed to load opportunities');
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
      case 'published': return 'badge bg-success';
      case 'draft': return 'badge bg-warning';
      case 'closed': return 'badge bg-secondary';
      default: return 'badge bg-secondary';
    }
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
      
      {/* Research Opportunities Section */}
      {user && (
        <div className="container mt-4">
          <div className="row">
            <div className="col-12">
              <h2 className="mb-4">Research Opportunities</h2>
              
              {loading && (
                <div className="text-center">
                  <div className="spinner-border" role="status">
                    <span className="visually-hidden">Loading...</span>
                  </div>
                  <p className="mt-2">Loading opportunities...</p>
                </div>
              )}
              
              {error && (
                <div className="alert alert-danger" role="alert">
                  {error}
                </div>
              )}
              
              {!loading && !error && opportunities.length === 0 && (
                <div className="text-center text-muted">
                  <p>No research opportunities available at the moment.</p>
                  <p>Check back later for new opportunities!</p>
                </div>
              )}
              
              {!loading && !error && opportunities.length > 0 && (
                <div className="row">
                  {opportunities.map((opportunity) => (
                    <div key={opportunity.id} className="col-md-6 col-lg-4 mb-4">
                      <div className="card h-100">
                        <div className="card-body d-flex flex-column">
                          <div className="d-flex justify-content-between align-items-start mb-2">
                            <span className={getTypeBadgeClass(opportunity.type)}>
                              {formatOpportunityType(opportunity.type)}
                            </span>
                            <span className={getStatusBadgeClass(opportunity.status)}>
                              {opportunity.status}
                            </span>
                          </div>
                          
                          <h5 className="card-title">{opportunity.title}</h5>
                          <p className="card-text text-muted">{opportunity.purpose_one_liner}</p>
                          
                          {opportunity.description_optional && (
                            <p className="card-text small">{opportunity.description_optional}</p>
                          )}
                          
                          <div className="mt-auto">
                            <div className="d-flex justify-content-between align-items-center mb-2">
                              <small className="text-muted">
                                <i className="bi bi-clock me-1"></i>
                                {opportunity.default_duration_minutes} min
                              </small>
                              <small className="text-muted">
                                {(() => {
                                  switch (opportunity.participant_type_required) {
                                    case 'any': return '👥 Any';
                                    case 'internal': return '🏢 Internal';
                                    case 'external': return '🌐 External';
                                    case 'specific': return '🎯 Specific';
                                    default: return '👥 Any';
                                  }
                                })()}
                              </small>
                            </div>
                            
                            {opportunity.sessions && opportunity.sessions.length > 0 && (
                              <div className="mb-2">
                                <small className="text-muted">
                                  {opportunity.sessions.reduce((total, session) => total + (session.remaining || 0), 0)} slots available
                                </small>
                              </div>
                            )}
                            
                            <div className="d-grid">
                              <button 
                                className="btn btn-primary"
                                onClick={() => navigate(`/opportunities/${opportunity.id}`)}
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
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default Home;
