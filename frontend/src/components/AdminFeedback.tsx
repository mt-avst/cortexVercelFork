import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getFeedback, deleteFeedback, exportFeedbackCsv, FeedbackItem } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import LoadingSpinner from './LoadingSpinner';
import ConfirmationModal from './ConfirmationModal';
import { AppError } from '../api/types';
import { logger } from '../utils/logger';
import { AlertTriangle, RefreshCw, Download, Inbox, ChevronRight, Trash2, X, Calendar, Link2, ChevronLeft } from 'lucide-react';
import { SortCaret } from './ui';
import './admin-feedback.css';

import { formatDateTime } from '../utils/datetime';
const AdminFeedback: React.FC = () => {
  const { user } = useAuth();
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  // cto/AdaptaLabs#81: the server caps the list and says when rows exist past
  // the cap. The sort/paginate below runs over the loaded slice, which is the
  // whole table until the cap is reached - the notice is what keeps that
  // honest once it is not. NOT named hasMore: getPreviewText's destructure in
  // the row renderer already binds that name to "the preview was cut", and a
  // byte-identical `{hasMore && (` resolving to two different variables is a
  // trap for readers and anchor-based tooling alike.
  const [listTruncated, setListTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ show: boolean; item: FeedbackItem | null }>({ show: false, item: null });
  const [deleting, setDeleting] = useState(false);
  const [sortField, setSortField] = useState<'created_at' | 'category' | 'user_name'>('created_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  
  // Modal state for viewing feedback
  const [viewModal, setViewModal] = useState<{ show: boolean; index: number }>({ show: false, index: 0 });

  const isSuperadmin = user?.role === 'superadmin';

  useEffect(() => {
    loadFeedback();
  }, []);

  const loadFeedback = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await getFeedback();
      setFeedback(result.items);
      setListTruncated(result.has_more);
    } catch (error: unknown) {
      logger.error('Failed to load feedback', {
        error: error instanceof Error ? error : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      setError(error instanceof AppError ? error.message : 'Failed to load feedback');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = (item: FeedbackItem) => {
    setDeleteConfirm({ show: true, item });
  };

  const confirmDelete = async () => {
    if (!deleteConfirm.item) return;
    
    try {
      setDeleting(true);
      await deleteFeedback(deleteConfirm.item.id);
      await loadFeedback();
      setDeleteConfirm({ show: false, item: null });
      // Close view modal if the deleted item was being viewed
      if (viewModal.show) {
        const deletedIndex = sortedFeedback.findIndex(f => f.id === deleteConfirm.item?.id);
        if (deletedIndex === viewModal.index) {
          // Move to previous or close if no more items
          if (sortedFeedback.length <= 1) {
            setViewModal({ show: false, index: 0 });
          } else if (viewModal.index >= sortedFeedback.length - 1) {
            setViewModal({ show: true, index: Math.max(0, viewModal.index - 1) });
          }
        }
      }
    } catch (error: unknown) {
      logger.error('Failed to delete feedback', {
        error: error instanceof Error ? error : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
        feedbackId: deleteConfirm.item?.id,
      });
      alert(error instanceof AppError ? error.message : 'Failed to delete feedback');
    } finally {
      setDeleting(false);
    }
  };

  const cancelDelete = () => {
    setDeleteConfirm({ show: false, item: null });
  };

  const handleExport = () => {
    exportFeedbackCsv();
  };

  const handleSort = (field: 'created_at' | 'category' | 'user_name') => {
    if (field === sortField) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // aria-sort carries the sorted column and direction to a screen reader (row 13).
  const ariaSortFor = (field: 'created_at' | 'category' | 'user_name'): 'ascending' | 'descending' | 'none' =>
    sortField === field ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none';

  const sortedFeedback = [...feedback].sort((a, b) => {
    let aValue: string | number | null = a[sortField];
    let bValue: string | number | null = b[sortField];
    
    if (sortField === 'created_at') {
      aValue = new Date(a.created_at).getTime();
      bValue = new Date(b.created_at).getTime();
    }
    
    if (typeof aValue === 'string' && typeof bValue === 'string') {
      aValue = aValue.toLowerCase();
      bValue = bValue.toLowerCase();
    }
    
    if (aValue === null) return 1;
    if (bValue === null) return -1;
    
    if (sortDirection === 'asc') {
      return aValue > bValue ? 1 : -1;
    } else {
      return aValue < bValue ? 1 : -1;
    }
  });

  const getCategoryBadgeClass = (category: string) => {
    switch (category) {
      case 'bug': return 'badge bg-danger';
      case 'feature': return 'badge bg-primary';
      case 'question': return 'badge bg-info text-dark';
      case 'other': return 'badge bg-secondary';
      default: return 'badge bg-secondary';
    }
  };

  const getCategoryLabel = (category: string) => {
    switch (category) {
      case 'bug': return 'Bug Report';
      case 'feature': return 'Feature Request';
      case 'question': return 'Question';
      case 'other': return 'Other';
      default: return category;
    }
  };

  const formatDate = (dateString: string) => {
    return formatDateTime(dateString) ?? '';
  };

  // Get first two lines of feedback text
  const getPreviewText = (text: string) => {
    const lines = text.split('\n').filter(line => line.trim());
    const preview = lines.slice(0, 2).join('\n');
    const hasMore = lines.length > 2 || preview.length < text.length;
    return { preview, hasMore };
  };

  // View modal handlers
  const openViewModal = (index: number) => {
    setViewModal({ show: true, index });
  };

  // These three are named by the keyboard effect below, so they are memoised
  // on what they actually read - otherwise being rebuilt every render would
  // re-register the window listener on every render.
  const closeViewModal = useCallback(() => {
    setViewModal({ show: false, index: 0 });
  }, []);

  const goToPrevious = useCallback(() => {
    setViewModal((current) =>
      current.index > 0 ? { show: true, index: current.index - 1 } : current
    );
  }, []);

  const goToNext = useCallback(() => {
    setViewModal((current) =>
      current.index < sortedFeedback.length - 1
        ? { show: true, index: current.index + 1 }
        : current
    );
  }, [sortedFeedback.length]);

  // Handle keyboard navigation in modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!viewModal.show) return;
      
      if (e.key === 'ArrowLeft') {
        goToPrevious();
      } else if (e.key === 'ArrowRight') {
        goToNext();
      } else if (e.key === 'Escape') {
        closeViewModal();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // viewModal.show rather than the whole object: the handlers read the index
    // through the state updater, so the listener no longer has to be torn down
    // and re-registered every time the index moves.
  }, [viewModal.show, goToPrevious, goToNext, closeViewModal]);

  const currentFeedback = sortedFeedback[viewModal.index];

  if (loading) {
    return <LoadingSpinner text="Loading feedback..." />;
  }

  if (error) {
    return (
      <div className="admin-feedback">
        <div className="alert feedback-error-text feedback-alert feedback-alert--danger">
          <AlertTriangle size={18} className="me-2" />
          {error}
          <button className="btn btn-outline-danger btn-sm ms-3" onClick={loadFeedback}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-feedback">
      <div className="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
        <h3 className="feedback-heading mb-0">
          Feedback Inbox
          {feedback.length > 0 && (
            <span className="badge bg-secondary ms-2" style={{ fontSize: '0.65rem', verticalAlign: 'middle' }}>
              {/* A truncated list's count is a floor, not a total. */}
              {listTruncated ? `${feedback.length}+` : feedback.length}
            </span>
          )}
        </h3>
        <div className="d-flex gap-2">
          <button 
            className="btn btn-outline-light"
            onClick={loadFeedback}
            disabled={loading}
          >
            <RefreshCw size={14} className="me-1" />
            Refresh
          </button>
          <button 
            className="btn btn-outline-light"
            onClick={handleExport}
            disabled={feedback.length === 0}
          >
            <Download size={14} className="me-1" />
            Export
          </button>
        </div>
      </div>

      {listTruncated && (
        <div
          data-testid="feedback-truncation-notice"
          role="status"
          className="alert d-flex align-items-center gap-2 mb-3 feedback-alert feedback-alert--warning"
        >
          <AlertTriangle size={16} />
          <span>
            {/* The count is the rows actually shown, so this sentence cannot
                drift from the server's cap. */}
            Showing the most recent {feedback.length} feedback items. Older items are not listed here - use Export to download the full set.
          </span>
        </div>
      )}

      {feedback.length === 0 ? (
        <div className="text-center py-5">
          <Inbox size={48} className="empty-state-icon" />
          <h4 className="mt-3 empty-state-title">No feedback yet</h4>
          <p className="empty-state-text">
            Feedback submitted by users will appear here.
          </p>
        </div>
      ) : (
        <div className="table-responsive">
          <table className="table feedback-table">
            <thead>
              <tr>
                <th className="sortable" scope="col" aria-sort={ariaSortFor('created_at')} style={{ width: '150px' }}>
                  <button type="button" className="feedback-th-sort" onClick={() => handleSort('created_at')}>
                    Date
                    <SortCaret active={sortField === 'created_at'} direction={sortDirection} />
                  </button>
                </th>
                <th className="sortable" scope="col" aria-sort={ariaSortFor('category')} style={{ width: '168px' }}>
                  <button type="button" className="feedback-th-sort" onClick={() => handleSort('category')}>
                    Category
                    <SortCaret active={sortField === 'category'} direction={sortDirection} />
                  </button>
                </th>
                <th className="sortable" scope="col" aria-sort={ariaSortFor('user_name')} style={{ width: '180px' }}>
                  <button type="button" className="feedback-th-sort" onClick={() => handleSort('user_name')}>
                    User
                    <SortCaret active={sortField === 'user_name'} direction={sortDirection} />
                  </button>
                </th>
                <th scope="col">Feedback</th>
                {isSuperadmin && (
                  <th scope="col" style={{ width: '80px', textAlign: 'center' }}>Actions</th>
                )}
              </tr>
            </thead>
            <tbody>
              {sortedFeedback.map((item, index) => {
                const { preview, hasMore } = getPreviewText(item.feedback);
                return (
                  <tr 
                    key={item.id}
                    onClick={() => openViewModal(index)}
                  >
                    <td data-label="Date">
                      <small className="date-text">
                        {formatDate(item.created_at)}
                      </small>
                    </td>
                    <td data-label="Category">
                      <span className={getCategoryBadgeClass(item.category)}>
                        {getCategoryLabel(item.category)}
                      </span>
                    </td>
                    <td data-label="User">
                      <div>
                        <strong>{item.user_name}</strong>
                        <div className="user-info">{item.user_email}</div>
                      </div>
                    </td>
                    <td data-label="Feedback">
                      <div className="feedback-preview">
                        <div className="feedback-preview-text">{preview}</div>
                        {hasMore && (
                          <div className="read-more">
                            <ChevronRight size={14} className="me-1" />
                            Click to read more
                          </div>
                        )}
                      </div>
                    </td>
                    {isSuperadmin && (
                      <td data-label="Actions" style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                        <button
                          className="btn btn-outline-danger btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(item);
                          }}
                          title="Delete feedback"
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* View Feedback Modal. Portalled to document.body - the admin-tabs
          card this component lives inside carries backdrop-filter, which
          induces its own stacking context and traps a plain-nested z-index
          below the page-level FeedbackFooter (cto/AdaptaLabs#150). Same
          pattern ConfirmationModal already uses for the same reason. */}
      {viewModal.show && currentFeedback && createPortal(
        // ponytail: the scrim (rgba(0, 0, 0, 0.85) below) and the dialog's
        // drop shadow (rgba(0, 0, 0, 0.5), a few lines down) stay hardcoded
        // black rather than routed through a token. Both are theme-neutral
        // overlay effects, not content colour, and the only shadow token
        // available (--shadow-card-current) is tuned for an ambient card
        // lift, not a dialog floating over a near-black scrim - swapping it
        // in would make the dialog's edge nearly disappear in dark theme.
        // Upgrade path: a dedicated --shadow-modal-current token, if a
        // second modal ever needs the same shape.
        <div
          data-testid="feedback-view-modal"
          onClick={closeViewModal}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1050,
            padding: '20px'
          }}
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="feedback-modal-content"
            style={{
              borderRadius: '16px',
              maxWidth: '700px',
              width: '100%',
              maxHeight: '80vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
            }}
          >
            <div className="feedback-modal-header" style={{
              padding: '1.5rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start'
            }}>
              <div>
                <span className={getCategoryBadgeClass(currentFeedback.category)}>
                  {getCategoryLabel(currentFeedback.category)}
                </span>
                <h5 style={{ marginTop: '0.5rem', marginBottom: 0 }}>
                  {currentFeedback.user_name}
                </h5>
                <small>
                  {currentFeedback.user_email}
                </small>
              </div>
              <button
                onClick={closeViewModal}
                aria-label="Close"
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '1.5rem',
                  cursor: 'pointer',
                  padding: 0,
                  lineHeight: 1
                }}
              >
                <X size={20} />
              </button>
            </div>
            
            <div style={{
              padding: '1.5rem',
              overflowY: 'auto',
              flex: 1
            }}>
              <div className="feedback-modal-text" style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                lineHeight: 1.7,
                fontSize: '1rem',
                minHeight: '60px'
              }}>
                {currentFeedback.feedback || <span className="feedback-modal-placeholder">No feedback text provided</span>}
              </div>
              
              <div className="feedback-modal-meta" style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '1rem',
                marginTop: '1rem',
                paddingTop: '1rem'
              }}>
                <div className="feedback-modal-meta-item" style={{ fontSize: '0.85rem' }}>
                  <Calendar size={14} className="feedback-modal-meta-icon" />
                  {formatDate(currentFeedback.created_at)}
                </div>
                {currentFeedback.url && currentFeedback.url !== 'Unknown' && (
                  <div className="feedback-modal-meta-item" style={{ fontSize: '0.85rem' }}>
                    <Link2 size={14} className="feedback-modal-meta-icon" />
                    {currentFeedback.url}
                  </div>
                )}
              </div>
            </div>
            
            <div className="feedback-modal-footer" style={{
              padding: '1rem 1.5rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <button 
                onClick={goToPrevious}
                disabled={viewModal.index === 0}
                aria-label="Previous feedback"
                className="feedback-nav-btn"
                style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: viewModal.index === 0 ? 'not-allowed' : 'pointer',
                  fontSize: '1.25rem',
                  opacity: viewModal.index === 0 ? 0.3 : 1
                }}
              >
                <ChevronLeft size={20} />
              </button>
              
              <div className="d-flex align-items-center gap-3">
                <span className="feedback-pagination-text" style={{ fontSize: '0.9rem' }}>
                  {viewModal.index + 1} of {sortedFeedback.length}
                </span>
                {isSuperadmin && (
                  <button
                    className="btn btn-outline-danger btn-sm"
                    onClick={() => handleDelete(currentFeedback)}
                    title="Delete this feedback"
                  >
                    <Trash2 size={14} className="me-1" />
                    Delete
                  </button>
                )}
              </div>
              
              <button 
                onClick={goToNext}
                disabled={viewModal.index === sortedFeedback.length - 1}
                aria-label="Next feedback"
                className="feedback-nav-btn"
                style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: viewModal.index === sortedFeedback.length - 1 ? 'not-allowed' : 'pointer',
                  fontSize: '1.25rem',
                  opacity: viewModal.index === sortedFeedback.length - 1 ? 0.3 : 1
                }}
              >
                <ChevronRight size={20} />
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      <ConfirmationModal
        show={deleteConfirm.show}
        title="Delete Feedback"
        message={`Are you sure you want to delete this feedback from ${deleteConfirm.item?.user_name}? This action cannot be undone.`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </div>
  );
};

export default AdminFeedback;
