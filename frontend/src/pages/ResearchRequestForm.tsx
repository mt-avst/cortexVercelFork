import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import OpportunityForm from './OpportunityForm';

/**
 * Research Request Form Page
 * Allows regular users to submit research requests
 * This wraps the OpportunityForm with user-friendly defaults
 */
const ResearchRequestForm: React.FC = () => {
  const { user, loading } = useAuth();

  // Redirect to home if not authenticated
  if (!loading && !user) {
    return <Navigate to="/" replace />;
  }

  // Redirect admins to admin form
  if (!loading && user?.role === 'researcher_admin') {
    return <Navigate to="/admin/opportunities/new" replace />;
  }

  // Show loading while checking auth
  if (loading || !user) {
    return (
      <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '400px' }}>
        <div className="spinner-border" role="status">
          <span className="visually-hidden">Loading...</span>
        </div>
      </div>
    );
  }

  // Render the OpportunityForm component with allowUserSubmission prop
  // The form will handle creating the opportunity as a draft
  return <OpportunityForm allowUserSubmission={true} />;
};

export default ResearchRequestForm;

