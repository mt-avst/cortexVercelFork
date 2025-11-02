import React, { useState, useEffect } from 'react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getOpportunityAnalytics, getOpportunity, type OpportunityAnalytics } from '../api/client';
import { Opportunity } from '../api/types';
import ErrorState from '../components/ErrorState';

const OpportunityAnalyticsPage: React.FC = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useAuth();
  
  const [opportunity, setOpportunity] = useState<Opportunity | null>(null);
  const [analytics, setAnalytics] = useState<OpportunityAnalytics | null>(null);
  const [loadingOpportunity, setLoadingOpportunity] = useState(true);
  const [loadingAnalytics, setLoadingAnalytics] = useState(true);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    if (!loading && !user) {
      // User will be redirected by AuthContext
      return;
    }
    
    if (id) {
      loadData();
    }
  }, [id, user, loading]);

  const loadData = async () => {
    if (!id) return;

    try {
      // Load opportunity first to verify it exists and is poll/survey
      const opp = await getOpportunity(id);
      setOpportunity(opp);
      
      // Only load analytics for polls and surveys
      if (opp.type === 'poll' || opp.type === 'survey') {
        const data = await getOpportunityAnalytics(id);
        setAnalytics(data);
      } else {
        setError('Analytics are only available for polls and surveys');
      }
    } catch (err: any) {
      console.error('Error loading data:', err);
      if (err.response?.status === 404) {
        setError('Opportunity not found');
      } else if (err.response?.status === 403) {
        setError('You do not have permission to view analytics for this opportunity');
      } else {
        setError('Failed to load analytics');
      }
    } finally {
      setLoadingOpportunity(false);
      setLoadingAnalytics(false);
    }
  };

  // Redirect if not authenticated
  if (!loading && !user) {
    return <Navigate to="/" replace />;
  }

  // Show loading state
  if (loading || loadingOpportunity) {
    return (
      <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '400px' }}>
        <div className="text-center">
          <div className="spinner-border text-primary" role="status">
            <span className="visually-hidden">Loading...</span>
          </div>
          <p className="mt-3 text-muted">Loading analytics...</p>
        </div>
      </div>
    );
  }

  // Show error state
  if (error || !opportunity) {
    return (
      <div className="container py-5">
        <div className="row">
          <div className="col-12">
            <button
              className="btn btn-outline-secondary mb-4"
              onClick={() => navigate('/admin')}
            >
              <i className="bi bi-arrow-left me-2"></i>
              Back to Admin Dashboard
            </button>
            <ErrorState 
              title="Unable to Load Analytics"
              message={error || 'Opportunity not found'}
              onAction={() => loadData()}
              actionLabel="Retry"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container py-5">
      <div className="row">
        <div className="col-12">
          {/* Header */}
          <div className="d-flex justify-content-between align-items-start mb-4">
            <div>
              <button
                className="btn btn-outline-secondary mb-3"
                onClick={() => navigate('/admin')}
              >
                <i className="bi bi-arrow-left me-2"></i>
                Back to Admin Dashboard
              </button>
              <h1 className="h3 mb-2">Click Analytics</h1>
              <p className="text-muted mb-0">
                Track how many times <strong>{opportunity.title}</strong> has been opened
              </p>
            </div>
          </div>

          {/* Analytics Content */}
          {loadingAnalytics ? (
            <div className="text-center py-5">
              <div className="spinner-border text-primary" role="status">
                <span className="visually-hidden">Loading analytics...</span>
              </div>
            </div>
          ) : analytics ? (
            <div className="row g-4">
              <div className="col-md-4">
                <div className="card border-0 shadow-sm h-100">
                  <div className="card-body text-center">
                    <h5 className="card-title text-muted mb-3" style={{ fontSize: '0.875rem', fontWeight: '600' }}>
                      Total Clicks
                    </h5>
                    <h2 className="mb-0" style={{ fontSize: '2.5rem', fontWeight: 'bold', color: '#ffaa50' }}>
                      {analytics.clicks_total}
                    </h2>
                  </div>
                </div>
              </div>
              <div className="col-md-4">
                <div className="card border-0 shadow-sm h-100">
                  <div className="card-body text-center">
                    <h5 className="card-title text-muted mb-3" style={{ fontSize: '0.875rem', fontWeight: '600' }}>
                      Last 24 Hours
                    </h5>
                    <h2 className="mb-0" style={{ fontSize: '2.5rem', fontWeight: 'bold', color: '#198754' }}>
                      {analytics.clicks_24h}
                    </h2>
                  </div>
                </div>
              </div>
              <div className="col-md-4">
                <div className="card border-0 shadow-sm h-100">
                  <div className="card-body">
                    <h5 className="card-title text-muted mb-3" style={{ fontSize: '0.875rem', fontWeight: '600' }}>
                      30-Day Trend
                    </h5>
                    {analytics.clicks_by_day.length > 0 ? (
                      <div className="text-center">
                        <div className="mb-2">
                          <span className="badge bg-success" style={{ fontSize: '0.75rem' }}>
                            {analytics.clicks_by_day.length} days with activity
                          </span>
                        </div>
                        <div className="mt-3">
                          <small className="text-muted d-block mb-1">Peak Activity</small>
                          <strong className="text-success" style={{ fontSize: '1.25rem' }}>
                            {Math.max(...analytics.clicks_by_day.map(d => d.count))} clicks
                          </strong>
                        </div>
                        {analytics.clicks_by_day.length > 1 && (
                          <div className="mt-3">
                            <small className="text-muted d-block mb-1">Average per day</small>
                            <strong className="text-primary" style={{ fontSize: '1.25rem' }}>
                              {Math.round(
                                analytics.clicks_by_day.reduce((sum, d) => sum + d.count, 0) / 
                                analytics.clicks_by_day.length
                              )} clicks
                            </strong>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-center text-muted py-3">
                        <i className="bi bi-graph-up" style={{ fontSize: '2rem', opacity: 0.3 }}></i>
                        <p className="mt-2 mb-0">No clicks yet</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="alert alert-info">
              <i className="bi bi-info-circle me-2"></i>
              No analytics data available
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OpportunityAnalyticsPage;

