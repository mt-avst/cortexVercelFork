import React, { useEffect, useRef, useState } from 'react';
import { getPendingApprovals, approveSession, rejectSession } from '../api/client';
import LoadingSpinner from './LoadingSpinner';
import { AppError } from '../api/types';
import { logger } from '../utils/logger';
import { RefreshCw, CheckCircle, UserCheck, XCircle } from 'lucide-react';

import { formatDateTime } from '../utils/datetime';
import { getParticipantFacingType } from '../utils/opportunityUtils';
import './pending-approvals.css';

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

/** A resolved-action banner, shown inline instead of a blocking browser alert. */
interface ActionMessage {
  kind: 'success' | 'error';
  text: string;
}

const PendingApprovals: React.FC = () => {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const [adminNotes, setAdminNotes] = useState<{ [key: string]: string }>({});
  // A reason is required to REJECT (an irreversible action); this holds the
  // per-card validation message when someone tries to reject with no reason.
  const [rejectErrors, setRejectErrors] = useState<{ [key: string]: string }>({});
  // Replaces the browser alert()s: the outcome of the last approve/reject,
  // announced in place so it never blocks and never discloses a points award
  // in an OS dialog.
  const [actionMessage, setActionMessage] = useState<ActionMessage | null>(null);
  const notesRefs = useRef<{ [key: string]: HTMLTextAreaElement | null }>({});

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
      setActionMessage(null);
      const notes = adminNotes[bookingId] || '';
      const result = await approveSession(bookingId, notes);

      setActionMessage({
        kind: 'success',
        text: `Session approved. ${result.pointsAwarded} points awarded${result.levelUp ? ', and the participant levelled up.' : '.'}`,
      });

      // Reload the list
      await loadPendingApprovals();

      // Clear notes and any stale reject-reason validation for this card.
      setAdminNotes(prev => ({ ...prev, [bookingId]: '' }));
      setRejectErrors(prev => {
        const next = { ...prev };
        delete next[bookingId];
        return next;
      });
    } catch (error: unknown) {
      logger.error('Failed to approve session', {
        error: error instanceof Error ? error : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
        bookingId,
      });
      setActionMessage({
        kind: 'error',
        text: error instanceof AppError ? error.message : 'Failed to approve session',
      });
    } finally {
      setProcessing(null);
    }
  };

  const handleReject = async (bookingId: string) => {
    // A reason is mandatory: rejection is irreversible and used to be one
    // unconfirmed click. Requiring the note makes it deliberate and leaves a
    // record of why. Validate before touching the API.
    const notes = (adminNotes[bookingId] || '').trim();
    if (!notes) {
      setRejectErrors(prev => ({
        ...prev,
        [bookingId]: 'Add a reason before rejecting this completion.',
      }));
      notesRefs.current[bookingId]?.focus();
      return;
    }

    try {
      setProcessing(bookingId);
      setActionMessage(null);
      await rejectSession(bookingId, notes);

      setActionMessage({ kind: 'success', text: 'Completion rejected.' });

      // Reload the list
      await loadPendingApprovals();

      // Clear notes and any stale validation message
      setAdminNotes(prev => ({ ...prev, [bookingId]: '' }));
      setRejectErrors(prev => {
        const next = { ...prev };
        delete next[bookingId];
        return next;
      });
    } catch (error: unknown) {
      logger.error('Failed to reject session', {
        error: error instanceof Error ? error : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
        bookingId,
      });
      setActionMessage({
        kind: 'error',
        text: error instanceof AppError ? error.message : 'Failed to reject session',
      });
    } finally {
      setProcessing(null);
    }
  };

  const handleNotesChange = (bookingId: string, notes: string) => {
    setAdminNotes(prev => ({ ...prev, [bookingId]: notes }));
    // Typing a reason clears the "reason required" message for that card.
    if (notes.trim() && rejectErrors[bookingId]) {
      setRejectErrors(prev => {
        const next = { ...prev };
        delete next[bookingId];
        return next;
      });
    }
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
      <div className="pending-approvals__head">
        <h3 className="pending-approvals__heading">Pending Completion Approvals</h3>
        <button
          className="btn btn-outline-secondary btn-sm"
          onClick={loadPendingApprovals}
          disabled={loading}
        >
          <RefreshCw size={14} className={`me-1 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {actionMessage && (
        // A failure is announced assertively (it may sit above the fold while
        // the admin acted on a card lower down); a success stays polite.
        <div
          className={`alert ${actionMessage.kind === 'success' ? 'alert-success' : 'alert-danger'}`}
          role={actionMessage.kind === 'success' ? 'status' : 'alert'}
          aria-live={actionMessage.kind === 'success' ? 'polite' : 'assertive'}
        >
          {actionMessage.text}
        </div>
      )}

      {approvals.length === 0 ? (
        <div className="alert alert-info">
          No sessions pending approval
        </div>
      ) : (
        approvals.map((approval) => {
          const rejectError = rejectErrors[approval.booking_id];
          const notesId = `notes-${approval.booking_id}`;
          const errorId = `notes-error-${approval.booking_id}`;
          return (
            <div key={approval.booking_id} className="pending-approvals__card">
              <div className="pending-approvals__card-head">
                <h5 className="pending-approvals__participant">
                  <UserCheck size={18} aria-hidden="true" />
                  {approval.user_name}
                </h5>
                <span className="pending-approvals__completed">
                  Completed: {formatDate(approval.completed_at)}
                </span>
              </div>
              <div className="pending-approvals__card-body">
                <div className="pending-approvals__grid">
                  <div>
                    <p className="pending-approvals__detail-title">Session Details</p>
                    <p className="pending-approvals__detail"><strong>Study:</strong> {approval.opportunity_title}</p>
                    <p className="pending-approvals__detail"><strong>Type:</strong> {getParticipantFacingType(approval.opportunity_type)}</p>
                    <p className="pending-approvals__detail"><strong>Start:</strong> {formatDate(approval.start_time)}</p>
                    <p className="pending-approvals__detail"><strong>End:</strong> {formatDate(approval.end_time)}</p>
                  </div>
                  <div>
                    <p className="pending-approvals__detail-title">User Details</p>
                    <p className="pending-approvals__detail"><strong>Name:</strong> {approval.user_name}</p>
                    <p className="pending-approvals__detail"><strong>Email:</strong> {approval.user_email}</p>
                  </div>
                </div>

                <div className="mt-3">
                  <label htmlFor={notesId} className="pending-approvals__notes-label">
                    Admin notes <span className="pending-approvals__notes-hint">(required to reject)</span>
                  </label>
                  <textarea
                    id={notesId}
                    ref={(el) => { notesRefs.current[approval.booking_id] = el; }}
                    className={`pending-approvals__textarea ${rejectError ? 'pending-approvals__textarea--invalid' : ''}`}
                    rows={3}
                    value={adminNotes[approval.booking_id] || ''}
                    onChange={(e) => handleNotesChange(approval.booking_id, e.target.value)}
                    placeholder="Add any notes about this session completion..."
                    aria-invalid={rejectError ? true : undefined}
                    aria-describedby={rejectError ? errorId : undefined}
                  />
                  {rejectError && (
                    <p id={errorId} className="pending-approvals__field-error" role="alert">
                      {rejectError}
                    </p>
                  )}
                </div>

                <div className="pending-approvals__actions">
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
                        Approve &amp; Award Points
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
          );
        })
      )}
    </div>
  );
};

export default PendingApprovals;
