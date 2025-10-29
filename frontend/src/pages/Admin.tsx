import React, { useState, useEffect, useRef } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getOpportunities, deleteOpportunity, duplicateOpportunity } from '../api/client';
import { Opportunity } from '../api/types';
import { formatOpportunityType, getTypeBadgeClass } from '../utils/opportunityUtils';
import PendingApprovals from '../components/PendingApprovals';
import ErrorState from '../components/ErrorState';
import useKeyboardShortcuts from '../hooks/useKeyboardShortcuts';
import ConfirmationModal from '../components/ConfirmationModal';

const Admin: React.FC = () => {
  const { user, loading, initialAuthCheck } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loadingOpportunities, setLoadingOpportunities] = useState(true);
  const [error, setError] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [deleteConfirm, setDeleteConfirm] = useState<{ show: boolean; opportunity: { id: string; title: string } | null }>({ show: false, opportunity: null });
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'opportunities' | 'approvals'>('opportunities');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [sortField, setSortField] = useState<'title' | 'created_at' | 'type' | 'status'>('created_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  
  // Keyboard shortcuts
  useKeyboardShortcuts([
    {
      key: '/',
      callback: () => {
        if (activeTab === 'opportunities' && searchInputRef.current) {
          searchInputRef.current.focus();
        }
      },
      description: 'Focus search'
    },
    {
      key: 'n',
      ctrlKey: true,
      callback: () => {
        navigate('/admin/opportunities/new');
      },
      description: 'Create new study'
    }
  ]);
  
  // Filter opportunities based on search query
  const filteredOpportunities = opportunities.filter(opp => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      opp.title.toLowerCase().includes(query) ||
      opp.purpose_one_liner.toLowerCase().includes(query) ||
      (opp.description_optional && opp.description_optional.toLowerCase().includes(query))
    );
  });

  // Sort filtered opportunities
  const sortedOpportunities = [...filteredOpportunities].sort((a, b) => {
    let aValue: any = a[sortField];
    let bValue: any = b[sortField];
    
    if (sortField === 'created_at') {
      aValue = new Date(a.created_at).getTime();
      bValue = new Date(b.created_at).getTime();
    }
    
    if (typeof aValue === 'string') {
      aValue = aValue.toLowerCase();
      bValue = bValue.toLowerCase();
    }
    
    if (sortDirection === 'asc') {
      return aValue > bValue ? 1 : -1;
    } else {
      return aValue < bValue ? 1 : -1;
    }
  });

  const handleSort = (field: 'title' | 'created_at' | 'type' | 'status') => {
    if (field === sortField) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const loadOpportunities = async (forceClearFilter = false) => {
    try {
      setLoadingOpportunities(true);
      setError('');
      const params: any = {};
      // If forceClearFilter is true, don't apply filters to ensure new items are visible
      if (!forceClearFilter) {
        if (statusFilter) params.status = statusFilter;
        if (typeFilter) params.type = typeFilter;
      }
      console.log('Loading opportunities with params:', params);
      const data = await getOpportunities(params);
      console.log('Loaded opportunities:', data?.length || 0);
      setOpportunities(data || []);
    } catch (err) {
      console.error('Error loading research studies:', err);
      setError('Failed to load research studies');
      setOpportunities([]);
    } finally {
      setLoadingOpportunities(false);
    }
  };

  useEffect(() => {
    if (user?.role === 'researcher_admin') {
      loadOpportunities();
    }
  }, [user, statusFilter, typeFilter]);

  // Refresh opportunities when returning from editing or creating
  useEffect(() => {
    if (location.state?.refresh && user?.role === 'researcher_admin') {
      console.log('Admin: Refresh triggered from navigation state', location.state);
      // Clear the refresh state first to prevent duplicate calls
      navigate(location.pathname, { replace: true, state: {} });
      // Force refresh without filters to ensure new items are visible
      // Use a small delay to ensure navigation is complete
      setTimeout(() => {
        console.log('Admin: Forcing refresh without filters');
        loadOpportunities(true); // true = force clear filters
      }, 150);
    }
  }, [location.state, user, navigate, location.pathname]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.dropdown')) {
        closeDropdown();
      }
    };

    if (openDropdownId) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [openDropdownId]);

  const handleDelete = (id: string, title: string) => {
    setDeleteConfirm({ show: true, opportunity: { id, title } });
  };

  const confirmDelete = async () => {
    if (!deleteConfirm.opportunity) return;
    
    try {
      await deleteOpportunity(deleteConfirm.opportunity.id);
      await loadOpportunities();
      setDeleteConfirm({ show: false, opportunity: null });
    } catch (err) {
      console.error('Error deleting research study:', err);
      setError('Failed to delete research study');
    }
  };

  const cancelDelete = () => {
    setDeleteConfirm({ show: false, opportunity: null });
  };

  const handleDuplicate = async (id: string) => {
    try {
      await duplicateOpportunity(id);
      await loadOpportunities();
    } catch (err) {
      console.error('Error duplicating research study:', err);
      setError('Failed to duplicate research study');
    }
  };

  const toggleDropdown = (id: string) => {
    setOpenDropdownId(openDropdownId === id ? null : id);
  };

  const closeDropdown = () => {
    setOpenDropdownId(null);
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'published': return 'badge bg-success text-white';
      case 'draft': return 'badge bg-warning text-white';
      case 'closed': return 'badge bg-secondary text-white';
      default: return 'badge bg-secondary text-white';
    }
  };

  // Wait for initial auth check to complete before making redirect decisions
  // This ensures we don't redirect away if auth check is still in progress
  // CRITICAL: When returning from login, wait for auth to complete before redirecting
  if (loading || !initialAuthCheck) {
    return <div className="card text-center">Loading...</div>;
  }

  // Only redirect if we're sure the user is not authenticated
  // When returning from login, user might be null temporarily while auth check runs
  if (!user) {
    return <Navigate to="/" replace />;
  }

  if (user.role !== 'researcher_admin') {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="container-fluid" style={{ minHeight: '100vh', padding: '2rem' }}>
      <style>
        {`
          .custom-tab-button {
            color: #ffffff !important;
            background-color: #343a40 !important;
            border: none !important;
            padding: 0.5rem 1rem !important;
            cursor: pointer !important;
            width: 100% !important;
            text-align: center !important;
            font-weight: 500 !important;
          }
          .custom-tab-button.active {
            background-color: #007bff !important;
          }
          .custom-tab-button:hover {
            background-color: #495057 !important;
          }
          .custom-tab-button.active:hover {
            background-color: #0056b3 !important;
          }
          .custom-tab-button i,
          .custom-tab-button span {
            color: #ffffff !important;
          }
        `}
      </style>
      <div className="row">
        <div className="col-12">
          <div className="card" style={{ minHeight: 'calc(100vh - 4rem)' }}>
            <div className="card-header d-flex justify-content-between align-items-center border-0 bg-transparent" style={{ marginBottom: '2rem' }}>
              <h1 className="h3 mb-0">Admin Dashboard</h1>
              <button 
                className="btn btn-primary"
                onClick={() => navigate('/admin/opportunities/new')}
                aria-label="Create new research study"
              >
                Create Research Study
              </button>
            </div>

            {/* Navigation Tabs */}
            <div className="card-header border-0 bg-transparent" style={{ paddingBottom: '0.5rem' }}>
              <ul className="nav nav-tabs nav-fill" role="tablist" style={{ borderBottom: 'none' }}>
                <li className="nav-item">
                  <button
                    className={`custom-tab-button ${activeTab === 'opportunities' ? 'active' : ''}`}
                    onClick={() => setActiveTab('opportunities')}
                    role="tab"
                    aria-selected={activeTab === 'opportunities'}
                    aria-controls="research-studies-tab"
                    tabIndex={0}
                  >
                    <i className="bi bi-list-ul me-2"></i>
                    <span>Research Studies</span>
                  </button>
                </li>
                <li className="nav-item">
                  <button
                    className={`custom-tab-button ${activeTab === 'approvals' ? 'active' : ''}`}
                    onClick={() => setActiveTab('approvals')}
                    role="tab"
                    aria-selected={activeTab === 'approvals'}
                    aria-controls="completion-approvals-tab"
                    tabIndex={0}
                  >
                    <i className="bi bi-clock-history me-2"></i>
                    <span>Completion Approvals</span>
                  </button>
                </li>
              </ul>
            </div>
            
            <div className="card-body">
              {/* Tab Content */}
              <div className="tab-content">
                {/* Research Studies Tab */}
                <div 
                  className={`tab-pane fade ${activeTab === 'opportunities' ? 'show active' : ''}`}
                  id="research-studies-tab"
                  role="tabpanel"
                  aria-labelledby="research-studies-tab-button"
                >
                  {/* Filters */}
                  <div className="row mb-4">
                    <div className="col-md-4">
                      <label htmlFor="searchFilter" className="form-label mb-2">
                        <i className="bi bi-search me-1"></i>Search Studies
                      </label>
                      <input
                        ref={searchInputRef}
                        type="text"
                        id="searchFilter"
                        className="form-control"
                        placeholder="Search by title or description... (Press / to focus)"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        style={{ 
                          fontSize: '1.1em', 
                          padding: '0.75rem 1rem',
                          height: 'auto',
                          minHeight: '2.5rem'
                        }}
                      />
                    </div>
                    <div className="col-md-4">
                      <label htmlFor="statusFilter" className="form-label mb-2">Status</label>
                      <select
                        id="statusFilter"
                        className="form-select"
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                        style={{ 
                          fontSize: '1.1em', 
                          padding: '0.75rem 1rem',
                          height: 'auto',
                          minHeight: '2.5rem'
                        }}
                      >
                        <option value="">All Statuses</option>
                        <option value="draft">Draft</option>
                        <option value="published">Published</option>
                        <option value="closed">Closed</option>
                      </select>
                    </div>
                    <div className="col-md-4">
                      <label htmlFor="typeFilter" className="form-label mb-2">Study Type</label>
                      <select
                        id="typeFilter"
                        className="form-select"
                        value={typeFilter}
                        onChange={(e) => setTypeFilter(e.target.value)}
                        style={{ 
                          fontSize: '1.1em', 
                          padding: '0.75rem 1rem',
                          height: 'auto',
                          minHeight: '2.5rem'
                        }}
                      >
                        <option value="">All Types</option>
                        <option value="test">🧪 User Test</option>
                        <option value="interview">💼 Interview</option>
                        <option value="poll">📊 Poll</option>
                        <option value="survey">📋 Survey</option>
                        <option value="question">❓ Question</option>
                      </select>
                    </div>
                  </div>

                  {/* Error State */}
                  {error && (
                    <ErrorState
                      title="Failed to load studies"
                      message={error}
                      actionLabel="Retry"
                      onAction={loadOpportunities}
                      icon="bi-exclamation-triangle"
                    />
                  )}

                  {/* Loading State */}
                  {loadingOpportunities && (
                    <div className="text-center py-4">
                      <div className="spinner-border" role="status">
                        <span className="visually-hidden">Loading...</span>
                      </div>
                      <p className="mt-2">Loading research studies...</p>
                    </div>
                  )}

                  {/* Empty State */}
                  {!loadingOpportunities && !error && sortedOpportunities.length === 0 && (
                    <div className="text-center py-5">
                      <h4>No research studies found</h4>
                      <p className="text-muted">
                        {searchQuery || statusFilter || typeFilter ? 'No research studies match your search or filters.' : 'Create your first research study to get started.'}
                      </p>
                      <button 
                        className="btn btn-primary"
                        onClick={() => navigate('/admin/opportunities/new')}
                      >
                        Create Research Study
                      </button>
                    </div>
                  )}

                  {/* Research Studies Table */}
                  {!loadingOpportunities && !error && sortedOpportunities.length > 0 && (
                    <div className="table-responsive" style={{ minHeight: '400px', overflow: 'visible' }}>
                      <table className="table table-hover table-striped">
                        <thead className="table-light">
                          <tr>
                            <th 
                              style={{ cursor: 'pointer', userSelect: 'none' }}
                              onClick={() => handleSort('title')}
                            >
                              Title {sortField === 'title' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th 
                              style={{ cursor: 'pointer', userSelect: 'none' }}
                              onClick={() => handleSort('type')}
                            >
                              Type {sortField === 'type' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th>Participants</th>
                            <th 
                              style={{ cursor: 'pointer', userSelect: 'none' }}
                              onClick={() => handleSort('status')}
                            >
                              Status {sortField === 'status' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th>Sessions</th>
                            <th>Total Slots</th>
                            <th>Remaining</th>
                            <th>Duration</th>
                            <th 
                              style={{ cursor: 'pointer', userSelect: 'none' }}
                              onClick={() => handleSort('created_at')}
                            >
                              Created {sortField === 'created_at' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedOpportunities.map((opportunity) => (
                            <tr 
                              key={opportunity.id}
                              style={{ cursor: 'pointer' }}
                              onClick={() => navigate(`/admin/opportunities/${opportunity.id}/edit`)}
                            >
                              <td>
                                <div>
                                  <strong>{opportunity.title}</strong>
                                  <br />
                                  <small className="text-muted">{opportunity.purpose_one_liner}</small>
                                </div>
                              </td>
                              <td>
                                <span className={getTypeBadgeClass(opportunity.type)}>
                                  {formatOpportunityType(opportunity.type)}
                                </span>
                              </td>
                              <td>
                                <span className="badge bg-secondary text-white">
                                  {(() => {
                                    switch (opportunity.participant_type_required) {
                                      case 'any': return '👥 Any';
                                      case 'internal': return '🏢 Internal';
                                      case 'external': return '🌐 External';
                                      case 'specific': return '🎯 Specific';
                                      default: return '👥 Any';
                                    }
                                  })()}
                                </span>
                              </td>
                              <td>
                                <span className={getStatusBadgeClass(opportunity.status)}>
                                  {opportunity.status}
                                </span>
                                {opportunity.status === 'closed' && (
                                  <span className="badge bg-dark ms-1">Auto-closed</span>
                                )}
                              </td>
                              <td>
                                {(opportunity.type === 'test' || opportunity.type === 'interview') ? (
                                  opportunity.sessions?.length || 0
                                ) : (
                                  ''
                                )}
                              </td>
                              <td>
                                {(opportunity.type === 'test' || opportunity.type === 'interview') ? (
                                  opportunity.sessions?.reduce((sum, s) => sum + s.capacity, 0) || 0
                                ) : (
                                  ''
                                )}
                              </td>
                              <td>
                                {(opportunity.type === 'test' || opportunity.type === 'interview') ? (
                                  <span className={`badge ${(opportunity.sessions?.reduce((sum, s) => sum + s.remaining, 0) || 0) > 0 ? 'bg-success' : 'bg-danger'}`}>
                                    {opportunity.sessions?.reduce((sum, s) => sum + s.remaining, 0) || 0}
                                  </span>
                                ) : (
                                  ''
                                )}
                              </td>
                              <td>{opportunity.default_duration_minutes} min</td>
                              <td>
                                <small className="text-muted">
                                  {new Date(opportunity.created_at).toLocaleDateString()}
                                </small>
                              </td>
                              <td>
                                <div className="dropdown" style={{ position: 'relative' }}>
                                  <button
                                    className="btn btn-outline-secondary btn-sm"
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleDropdown(opportunity.id);
                                    }}
                                    aria-expanded={openDropdownId === opportunity.id}
                                    title="Actions"
                                    style={{ fontSize: '16px', fontWeight: 'bold', padding: '4px 8px' }}
                                  >
                                    ⋮
                                  </button>
                                  {openDropdownId === opportunity.id && (
                                    <div 
                                      className="dropdown-menu show" 
                                      style={{ 
                                        position: 'absolute', 
                                        zIndex: 1000,
                                        minWidth: '120px',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        width: 'auto',
                                        top: '100%',
                                        left: '0',
                                        marginTop: '2px'
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <button
                                        className="dropdown-item"
                                        onClick={() => {
                                          navigate(`/opportunities/${opportunity.id}`);
                                          closeDropdown();
                                        }}
                                        style={{ width: '100%', textAlign: 'left', padding: '8px 16px' }}
                                      >
                                        View
                                      </button>
                                      <button
                                        className="dropdown-item"
                                        onClick={() => {
                                          navigate(`/admin/opportunities/${opportunity.id}/edit`);
                                          closeDropdown();
                                        }}
                                        style={{ width: '100%', textAlign: 'left', padding: '8px 16px' }}
                                      >
                                        Edit
                                      </button>
                                      <button
                                        className="dropdown-item"
                                        onClick={() => {
                                          handleDuplicate(opportunity.id);
                                          closeDropdown();
                                        }}
                                        style={{ width: '100%', textAlign: 'left', padding: '8px 16px' }}
                                      >
                                        Copy
                                      </button>
                                      <div className="dropdown-divider"></div>
                                      <button
                                        className="dropdown-item text-danger"
                                        onClick={() => {
                                          handleDelete(opportunity.id, opportunity.title);
                                          closeDropdown();
                                        }}
                                        style={{ width: '100%', textAlign: 'left', padding: '8px 16px' }}
                                      >
                                        Delete
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Completions Tab */}
                <div 
                  className={`tab-pane fade ${activeTab === 'approvals' ? 'show active' : ''}`}
                  id="completion-approvals-tab"
                  role="tabpanel"
                  aria-labelledby="completion-approvals-tab-button"
                >
                  <PendingApprovals />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ConfirmationModal
        show={deleteConfirm.show}
        title="Delete Research Study"
        message={`Are you sure you want to delete "${deleteConfirm.opportunity?.title}"? This action cannot be undone.`}
        confirmLabel="Yes, Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </div>
  );
};

export default Admin;
