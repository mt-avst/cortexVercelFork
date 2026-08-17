import React, { useCallback, useEffect, useState } from 'react';
import { getFeedback, deleteFeedback, exportFeedbackCsv, FeedbackItem } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import LoadingSpinner from './LoadingSpinner';
import ConfirmationModal from './ConfirmationModal';
import { AppError } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { AlertTriangle, RefreshCw, Download, Inbox, ChevronRight, Trash2, X, Calendar, Link2, ChevronLeft } from 'lucide-react';

import { formatDateTime } from '../utils/datetime';
const AdminFeedback: React.FC = () => {
  const { user } = useAuth();
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
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
      const data = await getFeedback();
      setFeedback(data);
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
      <div className="alert" style={{
        backgroundColor: 'rgba(220, 53, 69, 0.15)',
        border: '1px solid rgba(220, 53, 69, 0.3)',
        color: '#ff6b6d',
        borderRadius: '8px'
      }}>
        <AlertTriangle size={18} className="me-2" />
        {error}
        <button className="btn btn-outline-danger btn-sm ms-3" onClick={loadFeedback}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="admin-feedback">
      <style>
        {`
          .admin-feedback .feedback-table {
            background-color: transparent !important;
          }
          .admin-feedback .feedback-table thead th {
            background-color: var(--bg-table-header) !important;
            color: var(--text-primary) !important;
            border-bottom: 1px solid var(--border-card) !important;
            padding: 12px 16px !important;
          }
          .admin-feedback .feedback-table tbody tr {
            background-color: transparent !important;
            border-bottom: 1px solid var(--border-table-row) !important;
            cursor: pointer;
            transition: background-color 0.15s ease;
          }
          .admin-feedback .feedback-table tbody tr:hover {
            background-color: var(--bg-hover) !important;
          }
          .admin-feedback .feedback-table tbody td {
            color: var(--text-primary) !important;
            padding: 16px !important;
            vertical-align: middle !important;
          }
          .admin-feedback .feedback-preview {
            max-width: 400px;
            white-space: pre-wrap;
            word-break: break-word;
            line-height: 1.5;
          }
          .admin-feedback .feedback-preview-text {
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
          }
          .admin-feedback .read-more {
            color: var(--brand-headline);
            font-size: 0.85rem;
            margin-top: 4px;
          }
          .admin-feedback .user-info {
            font-size: 0.85rem;
            color: var(--text-muted);
          }
          .admin-feedback .sortable {
            cursor: pointer;
            user-select: none;
          }
          .admin-feedback .sortable:hover {
            color: var(--brand-headline) !important;
          }
          .admin-feedback .feedback-heading {
            color: var(--text-primary);
          }
          .admin-feedback .empty-state-icon {
            color: var(--text-muted);
          }
          .admin-feedback .empty-state-title {
            color: var(--text-primary);
          }
          .admin-feedback .empty-state-text {
            color: var(--text-muted);
          }
          .admin-feedback .date-text {
            color: var(--text-muted);
          }
          /* Modal styling */
          .admin-feedback .feedback-modal-content {
            background: var(--bg-card);
            border: 1px solid var(--border-card);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
          }
          .admin-feedback .feedback-modal-header {
            border-bottom: 1px solid var(--border-card);
          }
          .admin-feedback .feedback-modal-header h5 {
            color: var(--text-primary);
          }
          .admin-feedback .feedback-modal-header small {
            color: var(--text-muted);
          }
          .admin-feedback .feedback-modal-header button {
            color: var(--text-muted);
          }
          .admin-feedback .feedback-modal-text {
            color: var(--text-primary);
          }
          .admin-feedback .feedback-modal-placeholder {
            color: var(--text-muted);
            font-style: italic;
          }
          .admin-feedback .feedback-modal-meta {
            border-top: 1px solid var(--border-table-row);
            color: var(--text-muted);
            font-size: 0.85rem;
          }
          .admin-feedback .feedback-modal-meta i {
            color: var(--brand-headline);
            opacity: 0.7;
            margin-right: 0.5rem;
          }
          .admin-feedback .feedback-modal-footer {
            border-top: 1px solid var(--border-card);
          }
          .admin-feedback .feedback-nav-btn {
            background: var(--bg-hover);
            border: 1px solid var(--border-card);
            color: var(--text-primary);
          }
          .admin-feedback .feedback-nav-btn:hover:not(:disabled) {
            background: var(--bg-table-header);
          }
          .admin-feedback .feedback-pagination-text {
            color: var(--text-muted);
          }
          
        `}
      </style>

      <div className="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
        <h3 className="feedback-heading mb-0">
          Feedback Inbox
          {feedback.length > 0 && (
            <span className="badge bg-secondary ms-2" style={{ fontSize: '0.65rem', verticalAlign: 'middle' }}>
              {feedback.length}
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
                <th 
                  className="sortable"
                  onClick={() => handleSort('created_at')}
                  style={{ width: '150px' }}
                >
                  Date {sortField === 'created_at' && (sortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th 
                  className="sortable"
                  onClick={() => handleSort('category')}
                  style={{ width: '130px' }}
                >
                  Category {sortField === 'category' && (sortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th 
                  className="sortable"
                  onClick={() => handleSort('user_name')}
                  style={{ width: '180px' }}
                >
                  User {sortField === 'user_name' && (sortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th>Feedback</th>
                {isSuperadmin && (
                  <th style={{ width: '80px', textAlign: 'center' }}>Actions</th>
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
                    <td>
                      <small className="date-text">
                        {formatDate(item.created_at)}
                      </small>
                    </td>
                    <td>
                      <span className={getCategoryBadgeClass(item.category)}>
                        {getCategoryLabel(item.category)}
                      </span>
                    </td>
                    <td>
                      <div>
                        <strong>{item.user_name}</strong>
                        <div className="user-info">{item.user_email}</div>
                      </div>
                    </td>
                    <td>
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
                      <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
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

      {/* View Feedback Modal */}
      {viewModal.show && currentFeedback && (
        <div 
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
                <h5 style={{ color: '#fff', marginTop: '0.5rem', marginBottom: 0 }}>
                  {currentFeedback.user_name}
                </h5>
                <small style={{ color: 'rgba(224, 224, 224, 0.6)' }}>
                  {currentFeedback.user_email}
                </small>
              </div>
              <button 
                onClick={closeViewModal} 
                aria-label="Close"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'rgba(224, 224, 224, 0.7)',
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
                <div style={{ fontSize: '0.85rem', color: 'rgba(224, 224, 224, 0.6)' }}>
                  <Calendar size={14} style={{ marginRight: '0.5rem', color: 'rgba(255, 78, 80, 0.7)' }} />
                  {formatDate(currentFeedback.created_at)}
                </div>
                {currentFeedback.url && currentFeedback.url !== 'Unknown' && (
                  <div style={{ fontSize: '0.85rem', color: 'rgba(224, 224, 224, 0.6)' }}>
                    <Link2 size={14} style={{ marginRight: '0.5rem', color: 'rgba(255, 78, 80, 0.7)' }} />
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
        </div>
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
