import React, { useEffect, useState } from 'react';
import { getPendingApprovals, approveSession, rejectSession } from '../api/client';
import LoadingSpinner from './LoadingSpinner';
import { AppError } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { RefreshCw, CheckCircle, UserCheck, XCircle } from 'lucide-react';

import { formatDateTime } from '../utils/datetime';
interface PendingApproval {
  booking_id: string;
  user_id: string;
  session_id: string;
  completed_at: string;
  admin_notes: string | null;
  user_name: string;
  user_email: string;
  start_time: string;
  end_time: string;
  opportunity_title: string;
  opportunity_type: string;
  owner_user_id: string;
}

const PendingApprovals: React.FC = () => {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const [adminNotes, setAdminNotes] = useState<{ [key: string]: string }>({});

  useEffect(() => {
    loadPendingApprovals();
  }, []);

  const loadPendingApprovals = async () => {
    try {
      setLoading(true);
      const data = await getPendingApprovals();
      setApprovals(data);
    } catch (error: unknown) {
      logger.error('Failed to load pending approvals', {
        error: error instanceof Error ? error : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      setError(error instanceof AppError ? error.message : 'Failed to load pending approvals');
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (bookingId: string) => {
    try {
      setProcessing(bookingId);
      const notes = adminNotes[bookingId] || '';
      const result = await approveSession(bookingId, notes);
      
      // Show success message
      alert(`Session approved! User earned ${result.pointsAwarded} points${result.levelUp ? ' and leveled up!' : ''}`);
      
      // Reload the list
      await loadPendingApprovals();
      
      // Clear notes
      setAdminNotes(prev => ({ ...prev, [bookingId]: '' }));
    } catch (error: unknown) {
      logger.error('Failed to approve session', {
        error: error instanceof Error ? error : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
        bookingId,
      });
      alert(error instanceof AppError ? error.message : 'Failed to approve session');
    } finally {
      setProcessing(null);
    }
  };

  const handleReject = async (bookingId: string) => {
    try {
      setProcessing(bookingId);
      const notes = adminNotes[bookingId] || '';
      await rejectSession(bookingId, notes);
      
      // Show success message
      alert('Session rejected successfully');
      
      // Reload the list
      await loadPendingApprovals();
      
      // Clear notes
      setAdminNotes(prev => ({ ...prev, [bookingId]: '' }));
    } catch (error: unknown) {
      logger.error('Failed to reject session', {
        error: error instanceof Error ? error : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
        bookingId,
      });
      alert(error instanceof AppError ? error.message : 'Failed to reject session');
    } finally {
      setProcessing(null);
    }
  };

  const handleNotesChange = (bookingId: string, notes: string) => {
    setAdminNotes(prev => ({ ...prev, [bookingId]: notes }));
  };

  const formatDate = (dateString: string) => {
    return formatDateTime(dateString) ?? '';
  };

  if (loading) {
    return <LoadingSpinner text="Loading pending approvals..." />;
  }

  if (error) {
    return <div className="alert alert-danger">{error}</div>;
  }

  return (
    <div className="pending-approvals">
      <div className="d-flex justify-content-between align-items-center mb-4">
        <h3 className="text-white">Pending Completion Approvals</h3>
        <button 
          className="btn btn-outline-light"
          onClick={loadPendingApprovals}
          disabled={loading}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {approvals.length === 0 ? (
        <div className="alert alert-info">
          No sessions pending approval
        </div>
      ) : (
        <div className="row">
          {approvals.map((approval) => (
            <div key={approval.booking_id} className="col-12 mb-4">
              <div className="card border-secondary">
                <div className="card-header border-secondary d-flex justify-content-between align-items-center bg-dark">
                  <h5 className="mb-0 text-white">
                    <UserCheck size={18} className="me-2" />
                    {approval.user_name}
                  </h5>
                  <small className="text-light">
                    Completed: {formatDate(approval.completed_at)}
                  </small>
                </div>
                <div className="card-body bg-dark text-white">
                  <div className="row">
                    <div className="col-md-6">
                      <h6 className="text-white">Session Details</h6>
                      <p className="mb-1 text-white"><strong>Opportunity:</strong> {approval.opportunity_title}</p>
                      <p className="mb-1 text-white"><strong>Type:</strong> {approval.opportunity_type}</p>
                      <p className="mb-1 text-white"><strong>Start:</strong> {formatDate(approval.start_time)}</p>
                      <p className="mb-1 text-white"><strong>End:</strong> {formatDate(approval.end_time)}</p>
                    </div>
                    <div className="col-md-6">
                      <h6 className="text-white">User Details</h6>
                      <p className="mb-1 text-white"><strong>Name:</strong> {approval.user_name}</p>
                      <p className="mb-1 text-white"><strong>Email:</strong> {approval.user_email}</p>
                    </div>
                  </div>
                  
                  <div className="mt-3">
                    <label htmlFor={`notes-${approval.booking_id}`} className="form-label text-white">
                      Admin Notes (Optional)
                    </label>
                    <textarea
                      id={`notes-${approval.booking_id}`}
                      className="form-control border-secondary bg-dark text-white"
                      rows={3}
                      value={adminNotes[approval.booking_id] || ''}
                      onChange={(e) => handleNotesChange(approval.booking_id, e.target.value)}
                      placeholder="Add any notes about this session completion..."
                    />
                  </div>

                  <div className="mt-3 d-flex gap-2">
                    <button
                      className="btn btn-success"
                      onClick={() => handleApprove(approval.booking_id)}
                      disabled={processing === approval.booking_id}
                    >
                      {processing === approval.booking_id ? (
                        <>
                          <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
                          Processing...
                        </>
                      ) : (
                        <>
                          <CheckCircle size={16} className="me-2" />
                          Approve & Award Points
                        </>
                      )}
                    </button>
                    <button
                      className="btn btn-danger"
                      onClick={() => handleReject(approval.booking_id)}
                      disabled={processing === approval.booking_id}
                    >
                      {processing === approval.booking_id ? (
                        <>
                          <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
                          Processing...
                        </>
                      ) : (
                        <>
                          <XCircle size={16} className="me-2" />
                          Reject
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default PendingApprovals;
