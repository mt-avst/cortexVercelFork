import React, { useState, useEffect } from 'react';
import { Session, CreateSessionRequest, UpdateSessionRequest, SessionFormData } from '../api/types';
import { createSessions, updateSession, deleteSession } from '../api/client';
import { SESSION_CAPACITY } from '../shared/constants';
import ConfirmationModal from './ConfirmationModal';

interface SessionEditorProps {
  opportunityId: string;
  sessions: Session[];
  onSessionsChange: (sessions: Session[]) => void;
  disabled?: boolean;
}

const SessionEditor: React.FC<SessionEditorProps> = ({
  opportunityId,
  sessions,
  onSessionsChange,
  disabled = false
}) => {
  const [editingSession, setEditingSession] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ show: boolean; sessionId: string | null }>({ show: false, sessionId: null });
  const [newSession, setNewSession] = useState<SessionFormData>({
    start_time: '',
    end_time: '',
    capacity: 1,
    location_or_meet_link_optional: ''
  });
  const [batchSessions, setBatchSessions] = useState<SessionFormData[]>([]);
  const [showBatchAdd, setShowBatchAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  // Helper function to format date for input
  const formatDateForInput = (date: Date | string): string => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };

  // Helper function to format date for display
  const formatDateForDisplay = (date: Date | string): string => {
    return new Date(date).toLocaleString();
  };

  // Helper function to check if session is in the past
  const isPastSession = (session: Session): boolean => {
    return new Date(session.end_time) < new Date();
  };

  // Validation functions
  const validateSession = (session: SessionFormData, index?: number): string[] => {
    const errors: string[] = [];
    const prefix = index !== undefined ? `Session ${index + 1}: ` : '';
    
    if (!session.start_time) {
      errors.push(`${prefix}Start time is required`);
    }
    
    if (!session.end_time) {
      errors.push(`${prefix}End time is required`);
    }
    
    if (session.start_time && session.end_time) {
      const start = new Date(session.start_time);
      const end = new Date(session.end_time);
      
      if (start >= end) {
        errors.push(`${prefix}End time must be after start time`);
      }
    }
    
    if (session.capacity < SESSION_CAPACITY.MIN || session.capacity > SESSION_CAPACITY.MAX) {
      errors.push(`${prefix}Capacity must be between ${SESSION_CAPACITY.MIN} and ${SESSION_CAPACITY.MAX}`);
    }
    
    return errors;
  };

  const validateAllSessions = (sessionsToValidate: SessionFormData[]): boolean => {
    const allErrors: string[] = [];
    
    sessionsToValidate.forEach((session, index) => {
      const errors = validateSession(session, index);
      allErrors.push(...errors);
    });
    
    // Check for overlaps within the batch
    for (let i = 0; i < sessionsToValidate.length; i++) {
      for (let j = i + 1; j < sessionsToValidate.length; j++) {
        const session1 = sessionsToValidate[i];
        const session2 = sessionsToValidate[j];
        
        if (session1.start_time && session1.end_time && session2.start_time && session2.end_time) {
          const start1 = new Date(session1.start_time);
          const end1 = new Date(session1.end_time);
          const start2 = new Date(session2.start_time);
          const end2 = new Date(session2.end_time);
          
          if ((start1 < end2) && (start2 < end1)) {
            allErrors.push(`Sessions ${i + 1} and ${j + 1} overlap in time`);
          }
        }
      }
    }
    
    if (allErrors.length > 0) {
      setError(allErrors.join(', '));
      return false;
    }
    
    setError('');
    return true;
  };

  // Handle adding a single session
  const handleAddSession = async () => {
    if (!validateAllSessions([newSession])) {
      return;
    }
    
    try {
      setSaving(true);
      const createdSessions = await createSessions(opportunityId, {
        start_time: newSession.start_time,
        end_time: newSession.end_time,
        capacity: newSession.capacity,
        location_or_meet_link_optional: newSession.location_or_meet_link_optional || undefined
      });
      
      onSessionsChange([...sessions, ...createdSessions]);
      setNewSession({
        start_time: '',
        end_time: '',
        capacity: 1,
        location_or_meet_link_optional: ''
      });
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } } };
      setError(axiosError.response?.data?.error || 'Failed to create session');
    } finally {
      setSaving(false);
    }
  };

  // Handle batch adding sessions
  const handleBatchAddSessions = async () => {
    if (!validateAllSessions(batchSessions)) {
      return;
    }
    
    try {
      setSaving(true);
      const createdSessions = await createSessions(opportunityId, batchSessions.map(session => ({
        start_time: session.start_time,
        end_time: session.end_time,
        capacity: session.capacity,
        location_or_meet_link_optional: session.location_or_meet_link_optional || undefined
      })));
      
      onSessionsChange([...sessions, ...createdSessions]);
      setBatchSessions([]);
      setShowBatchAdd(false);
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } } };
      setError(axiosError.response?.data?.error || 'Failed to create sessions');
    } finally {
      setSaving(false);
    }
  };

  // Handle updating a session
  const handleUpdateSession = async (sessionId: string, updates: UpdateSessionRequest) => {
    try {
      setSaving(true);
      const updatedSession = await updateSession(sessionId, updates);
      
      onSessionsChange(sessions.map(s => s.id === sessionId ? updatedSession : s));
      setEditingSession(null);
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } } };
      setError(axiosError.response?.data?.error || 'Failed to update session');
    } finally {
      setSaving(false);
    }
  };

  // Handle deleting a session
  const handleDeleteSession = (sessionId: string) => {
    setDeleteConfirm({ show: true, sessionId });
  };

  const confirmDeleteSession = async () => {
    if (!deleteConfirm.sessionId) return;
    
    try {
      setSaving(true);
      await deleteSession(deleteConfirm.sessionId);
      
      onSessionsChange(sessions.filter(s => s.id !== deleteConfirm.sessionId));
      setDeleteConfirm({ show: false, sessionId: null });
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } } };
      setError(axiosError.response?.data?.error || 'Failed to delete session');
    } finally {
      setSaving(false);
    }
  };

  const cancelDeleteSession = () => {
    setDeleteConfirm({ show: false, sessionId: null });
  };

  // Handle quick add for multi-day sessions
  const handleQuickAddMultiDay = () => {
    const startDate = newSession.start_time ? new Date(newSession.start_time) : new Date();
    const days = parseInt(prompt('How many days?', '5') || '5');
    
    if (days < 1 || days > 30) {
      setError('Days must be between 1 and 30');
      return;
    }
    
    const quickSessions: SessionFormData[] = [];
    
    for (let i = 0; i < days; i++) {
      const sessionDate = new Date(startDate);
      sessionDate.setDate(startDate.getDate() + i);
      
      const startTime = formatDateForInput(sessionDate);
      const endTime = formatDateForInput(new Date(sessionDate.getTime() + (newSession.capacity || 30) * 60000));
      
      quickSessions.push({
        start_time: startTime,
        end_time: endTime,
        capacity: newSession.capacity,
        location_or_meet_link_optional: newSession.location_or_meet_link_optional
      });
    }
    
    setBatchSessions(quickSessions);
    setShowBatchAdd(true);
  };

  return (
    <div className="session-editor">
      <h5 className="mb-3">Sessions</h5>
      
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      {/* Add new session form */}
      <div className="card mb-3">
        <div className="card-header">
          <h6 className="mb-0">Add Session</h6>
        </div>
        <div className="card-body">
          <div className="row">
            <div className="col-md-3">
              <label htmlFor="session-start-time" className="form-label">Start Time *</label>
              <input
                type="datetime-local"
                id="session-start-time"
                className="form-control"
                value={newSession.start_time}
                onChange={(e) => setNewSession(prev => ({ ...prev, start_time: e.target.value }))}
                disabled={disabled}
                aria-required="true"
                required
              />
            </div>
            <div className="col-md-3">
              <label htmlFor="session-end-time" className="form-label">End Time *</label>
              <input
                type="datetime-local"
                id="session-end-time"
                className="form-control"
                value={newSession.end_time}
                onChange={(e) => setNewSession(prev => ({ ...prev, end_time: e.target.value }))}
                disabled={disabled}
                aria-required="true"
                required
              />
            </div>
            <div className="col-md-2">
              <label htmlFor="session-capacity" className="form-label">Capacity *</label>
              <input
                type="number"
                id="session-capacity"
                className="form-control"
                value={newSession.capacity}
                onChange={(e) => setNewSession(prev => ({ ...prev, capacity: parseInt(e.target.value) || 1 }))}
                min="1"
                max="500"
                disabled={disabled}
                aria-required="true"
                required
              />
            </div>
            <div className="col-md-3">
              <label htmlFor="session-location" className="form-label">Location/Link</label>
              <input
                type="text"
                id="session-location"
                className="form-control"
                value={newSession.location_or_meet_link_optional}
                onChange={(e) => setNewSession(prev => ({ ...prev, location_or_meet_link_optional: e.target.value }))}
                placeholder="Room or Meet link"
                disabled={disabled}
              />
            </div>
            <div className="col-md-1 d-flex align-items-end">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleAddSession}
                disabled={disabled || saving || !newSession.start_time || !newSession.end_time}
              >
                Add
              </button>
            </div>
          </div>
          <div className="mt-2">
            <button
              type="button"
              className="btn btn-outline-secondary btn-sm me-2"
              onClick={handleQuickAddMultiDay}
              disabled={disabled || !newSession.start_time || !newSession.end_time}
            >
              Quick Add Multi-Day
            </button>
            <small className="text-muted">
              Creates multiple sessions starting from the specified date
            </small>
          </div>
        </div>
      </div>

      {/* Sessions list */}
      <div className="card">
        <style>
          {`
            .momentum-table-container {
              background: transparent;
              border-radius: var(--card-radius);
              overflow: hidden;
            }
            .momentum-table-container table {
              width: 100%;
              border-collapse: separate;
              border-spacing: 0;
              background: transparent;
            }
            .momentum-table-container thead {
              background: var(--bg-card);
              backdrop-filter: blur(16px);
            }
            .momentum-table-container thead th {
              background: var(--bg-card);
              color: var(--text-primary);
              border-bottom: 1px solid var(--border-card);
              font-weight: 600;
              padding: 16px 12px;
              font-size: var(--font-size-body);
              vertical-align: middle;
            }
            .momentum-table-container tbody tr {
              background: transparent;
              border-bottom: 1px solid rgba(255, 255, 255, 0.05);
              transition: background-color var(--transition-card);
            }
            .momentum-table-container tbody tr:hover {
              background: var(--bg-card);
            }
            .momentum-table-container tbody tr.table-secondary {
              opacity: 0.6;
            }
            .momentum-table-container tbody td {
              color: var(--text-primary);
              padding: 16px 12px;
              vertical-align: middle;
              font-size: var(--font-size-body);
            }
            .momentum-table-container tbody td small {
              color: var(--text-muted);
              font-size: var(--font-size-metadata);
            }
          `}
        </style>
        <div className="card-header d-flex justify-content-between align-items-center">
          <h6 className="mb-0">Sessions ({sessions.length})</h6>
          {sessions.length > 0 && (
            <small className="text-muted">
              Total slots: {sessions.reduce((sum, s) => sum + s.capacity, 0)} • 
              Remaining: {sessions.reduce((sum, s) => sum + s.remaining, 0)}
            </small>
          )}
        </div>
        <div className="card-body">
          {sessions.length === 0 ? (
            <div className="text-center text-muted py-3">
              No sessions added yet. Add sessions above to create time slots for this opportunity.
            </div>
          ) : (
            <div className="table-responsive momentum-table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Start Time</th>
                    <th>End Time</th>
                    <th>Capacity</th>
                    <th>Booked</th>
                    <th>Remaining</th>
                    <th>Location/Link</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.id} className={isPastSession(session) ? 'table-secondary' : ''}>
                      <td>{formatDateForDisplay(session.start_time)}</td>
                      <td>{formatDateForDisplay(session.end_time)}</td>
                      <td>{session.capacity}</td>
                      <td>{session.booked_count}</td>
                      <td>
                        <span className={`badge ${session.remaining > 0 ? 'bg-success' : 'bg-danger'}`}>
                          {session.remaining}
                        </span>
                      </td>
                      <td>
                        {session.location_or_meet_link_optional && (
                          <small className="text-muted">
                            {session.location_or_meet_link_optional.length > 30 
                              ? `${session.location_or_meet_link_optional.substring(0, 30)}...`
                              : session.location_or_meet_link_optional
                            }
                          </small>
                        )}
                      </td>
                      <td>
                        {!disabled && (
                          <div className="btn-group btn-group-sm">
                            <button
                              type="button"
                              className="btn btn-outline-primary"
                              onClick={() => setEditingSession(session.id)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn btn-outline-danger"
                              onClick={() => handleDeleteSession(session.id)}
                              disabled={session.booked_count > 0}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Batch add modal */}
      {showBatchAdd && (
        <div className="modal show d-block" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="modal-dialog modal-lg">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">Batch Add Sessions</h5>
                <button
                  type="button"
                  className="btn-close"
                  onClick={() => setShowBatchAdd(false)}
                ></button>
              </div>
              <div className="modal-body">
                <p>Review the sessions to be created:</p>
                <div className="table-responsive momentum-table-container">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Start Time</th>
                        <th>End Time</th>
                        <th>Capacity</th>
                        <th>Location/Link</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchSessions.map((session, index) => (
                        <tr key={index}>
                          <td>{formatDateForDisplay(session.start_time)}</td>
                          <td>{formatDateForDisplay(session.end_time)}</td>
                          <td>{session.capacity}</td>
                          <td>{session.location_or_meet_link_optional || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowBatchAdd(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleBatchAddSessions}
                  disabled={saving}
                >
                  {saving ? 'Creating...' : `Create ${batchSessions.length} Sessions`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmationModal
        show={deleteConfirm.show}
        title="Delete Session"
        message="Are you sure you want to delete this session? This action cannot be undone."
        confirmLabel="Yes, Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={confirmDeleteSession}
        onCancel={cancelDeleteSession}
      />
    </div>
  );
};

export default SessionEditor;
