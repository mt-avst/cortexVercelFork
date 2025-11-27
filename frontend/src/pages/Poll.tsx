import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, BarChart3, Info } from 'lucide-react';

const Poll: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  return (
    <div className="container mt-4">
      <div className="row justify-content-center">
        <div className="col-md-8">
          <div className="card">
            <div className="card-header">
              <div className="d-flex justify-content-between align-items-center">
                <h2 className="mb-0">DEMO POLL</h2>
                <button 
                  className="btn btn-outline-secondary"
                  onClick={() => navigate(-1)}
                >
                  <ArrowLeft size={16} className="me-1" />
                  Back
                </button>
              </div>
            </div>
            <div className="card-body text-center py-5">
              <div className="mb-4">
                <BarChart3 size={64} className="text-primary" />
              </div>
              <h3 className="text-muted mb-3">Poll Feature Coming Soon</h3>
              <p className="text-muted mb-4">
                This is a placeholder page for the poll functionality. 
                The actual poll interface will be implemented in a future milestone.
              </p>
              <div className="alert alert-info">
                <Info size={18} className="me-2" />
                <strong>Poll ID:</strong> {id || 'N/A'}
              </div>
              <button 
                className="btn btn-primary"
                onClick={() => navigate(-1)}
              >
                Return to Opportunity
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Poll;
