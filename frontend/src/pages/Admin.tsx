import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import SlowNeuralBackground from '../components/SlowNeuralBackground';
import { getOpportunities, deleteOpportunity, duplicateOpportunity, getDashboardStats, DashboardStats } from '../api/client';
import { Opportunity } from '../api/types';
import { formatOpportunityType, getTypeBadgeClass } from '../utils/opportunityUtils';
import PendingApprovals from '../components/PendingApprovals';
import AdminFeedback from '../components/AdminFeedback';
import ErrorState from '../components/ErrorState';
import ConfirmationModal from '../components/ConfirmationModal';
import { Settings, ClipboardList, CalendarCheck, Users, Clock, List, History, MessageSquare, AlertTriangle, Calendar } from 'lucide-react';

const Admin: React.FC = () => {
  const { user, loading, initialAuthCheck } = useAuth();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const navigate = useNavigate();
  const location = useLocation();

  // Add admin-page class to body for wider header alignment
  useEffect(() => {
    document.body.classList.add('admin-page');
    return () => {
      document.body.classList.remove('admin-page');
    };
  }, []);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loadingOpportunities, setLoadingOpportunities] = useState(true);
  const [error, setError] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>('');
  const [deleteConfirm, setDeleteConfirm] = useState<{ show: boolean; opportunity: { id: string; title: string } | null }>({ show: false, opportunity: null });

  // Debounce search query to prevent filtering on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'opportunities' | 'approvals' | 'feedback'>('opportunities');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [sortField, setSortField] = useState<'title' | 'created_at' | 'type' | 'status'>('created_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  
  
  // Filter opportunities based on debounced search query (memoized for performance)
  const filteredOpportunities = useMemo(() => {
    if (!debouncedSearchQuery) return opportunities;
    const query = debouncedSearchQuery.toLowerCase();
    return opportunities.filter(opp => 
      opp.title.toLowerCase().includes(query) ||
      opp.purpose_one_liner.toLowerCase().includes(query) ||
      (opp.description_optional && opp.description_optional.toLowerCase().includes(query))
    );
  }, [opportunities, debouncedSearchQuery]);

  // Sort filtered opportunities (memoized for performance)
  const sortedOpportunities = useMemo(() => {
    return [...filteredOpportunities].sort((a, b) => {
      let aValue: string | number = a[sortField];
      let bValue: string | number = b[sortField];
      
      if (sortField === 'created_at') {
        aValue = new Date(a.created_at).getTime();
        bValue = new Date(b.created_at).getTime();
      }
      
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        aValue = aValue.toLowerCase();
        bValue = bValue.toLowerCase();
      }
      
      if (sortDirection === 'asc') {
        return aValue > bValue ? 1 : -1;
      } else {
        return aValue < bValue ? 1 : -1;
      }
    });
  }, [filteredOpportunities, sortField, sortDirection]);

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
      const params: { status?: string; type?: string } = {};
      // If forceClearFilter is true, don't apply filters to ensure new items are visible
      if (!forceClearFilter) {
        if (statusFilter) params.status = statusFilter;
        if (typeFilter) params.type = typeFilter;
      }
      // Performance: debug logging disabled in production
      const data = await getOpportunities(params);
      // Performance: debug logging disabled in production
      setOpportunities(data || []);
    } catch (error: unknown) {
      // Performance: error logging kept but reduced verbosity
      setError('Failed to load research studies');
      setOpportunities([]);
    } finally {
      setLoadingOpportunities(false);
    }
  };

  const loadDashboardStats = async () => {
    try {
      setLoadingStats(true);
      const stats = await getDashboardStats();
      setDashboardStats(stats);
    } catch (error: unknown) {
      // Don't show error to user - dashboard stats are non-critical
    } finally {
      setLoadingStats(false);
    }
  };

  useEffect(() => {
    if (user?.role === 'researcher_admin' || user?.role === 'superadmin') {
      loadOpportunities();
      loadDashboardStats();
    }
  }, [user, statusFilter, typeFilter]);

  // Refresh opportunities when returning from editing or creating
  useEffect(() => {
    if (location.state?.refresh && user?.role === 'researcher_admin') {
      // Clear the refresh state first to prevent duplicate calls
      navigate(location.pathname, { replace: true, state: {} });
      // Force refresh without filters to ensure new items are visible
      // Use a small delay to ensure navigation is complete
      setTimeout(() => {
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
    } catch (error: unknown) {
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
    } catch (error: unknown) {
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
      case 'published': return 'badge status-published text-white';
      case 'draft': return 'badge status-draft'; // Draft uses black text, no text-white class
      case 'closed': return 'badge status-closed text-white';
      default: return 'badge status-closed text-white';
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

  if (user.role !== 'researcher_admin' && user.role !== 'superadmin') {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="admin-page-bg">
      {/* Theme-aware Background: Dark Mode gets neural particles */}
      {isDark && <SlowNeuralBackground />}
      
      <div className="container-fluid admin-page-container admin-page-fullheight admin-container-wide">
        <div className="row admin-dashboard">
        <div className="col-12 admin-content-wrapper">
          <div className="card admin-card admin-card-main">
            <div className="card-header card-header-transparent">
              <div className="admin-header-section">
                <div>
                  <h1 className="mb-1 cortex-brand-title">Cortex<span className="cortex-admin-separator">|</span><span className="cortex-admin-suffix">Admin</span></h1>
                  <p className="admin-subtitle">Manage research studies, bookings, and participant feedback</p>
                </div>
                <div className="admin-table-actions">
                  <button 
                    className="btn btn-outline-secondary admin-settings-btn btn-nowrap"
                    onClick={() => navigate('/admin/settings')}
                    aria-label="Settings"
                  >
                    <Settings size={16} className="me-2" />
                    <span>Settings</span>
                  </button>
                  <button 
                    className="btn btn-primary admin-create-btn btn-nowrap"
                    onClick={() => navigate('/admin/opportunities/new')}
                    aria-label="Create new research study"
                  >
                    <span className="d-none d-md-inline">Create Research Study →</span>
                    <span className="d-md-none">Create Study →</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Dashboard Statistics Cards */}
            {dashboardStats && (
              <div className="row mb-3 g-2">
                <div className="col-6 col-sm-3">
                  <div className="card border-0 shadow-sm h-100 stat-card admin-stat-card">
                    <div className="card-body stat-card-body">
                      <div className="stat-card-header">
                        <span className="text-uppercase stat-label">Studies</span>
                        <div className="stat-icon-wrapper">
                          <ClipboardList size={20} className="stat-icon" />
                        </div>
                      </div>
                      <h2 className="mb-0 stat-value">{dashboardStats.total_opportunities}</h2>
                      <small className="stat-subtitle">
                        {dashboardStats.published_opportunities} live · {dashboardStats.draft_opportunities} draft
                      </small>
                    </div>
                  </div>
                </div>
                <div className="col-6 col-sm-3">
                  <div className="card border-0 shadow-sm h-100 stat-card admin-stat-card">
                    <div className="card-body stat-card-body">
                      <div className="stat-card-header">
                        <span className="text-uppercase stat-label">Bookings</span>
                        <div className="stat-icon-wrapper">
                          <CalendarCheck size={20} className="stat-icon" />
                        </div>
                      </div>
                      <h2 className="mb-0 stat-value">{dashboardStats.total_bookings}</h2>
                      <small className="stat-subtitle">
                        {dashboardStats.upcoming_bookings} up · {dashboardStats.past_bookings} past
                      </small>
                    </div>
                  </div>
                </div>
                <div className="col-6 col-sm-3">
                  <div className="card border-0 shadow-sm h-100 stat-card admin-stat-card">
                    <div className="card-body stat-card-body">
                      <div className="stat-card-header">
                        <span className="text-uppercase stat-label">Users</span>
                        <div className="stat-icon-wrapper">
                          <Users size={20} className="stat-icon" />
                        </div>
                      </div>
                      <h2 className="mb-0 stat-value">{dashboardStats.total_participants}</h2>
                      <small className="stat-subtitle">
                        Unique participants
                      </small>
                    </div>
                  </div>
                </div>
                <div className="col-6 col-sm-3">
                  <div className="card border-0 shadow-sm h-100 stat-card admin-stat-card">
                    <div className="card-body stat-card-body">
                      <div className="stat-card-header">
                        <span className="text-uppercase stat-label">Slots</span>
                        <div className="stat-icon-wrapper">
                          <Clock size={20} className="stat-icon" />
                        </div>
                      </div>
                      <h2 className="mb-0 stat-value">{dashboardStats.available_slots}</h2>
                      <small className="stat-subtitle">
                        {dashboardStats.booked_slots}/{dashboardStats.total_slots} booked
                      </small>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* M7: Recent bookings list (with session times) */}
            {dashboardStats && dashboardStats.recent_bookings && dashboardStats.recent_bookings.length > 0 && (
              <div className="row mb-3">
                <div className="col-12">
                  <div className="card border-0 shadow-sm">
                    <div className="card-header bg-transparent border-bottom d-flex align-items-center">
                      <Calendar size={18} className="me-2" aria-hidden />
                      <h2 className="h6 mb-0">Recent bookings</h2>
                    </div>
                    <div className="card-body p-0">
                      <div className="table-responsive">
                        <table className="table table-hover mb-0">
                          <thead>
                            <tr>
                              <th scope="col">Study</th>
                              <th scope="col">Session</th>
                              <th scope="col">Participant</th>
                              <th scope="col">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dashboardStats.recent_bookings.map((b) => (
                              <tr key={b.id}>
                                <td>
                                  <button
                                    type="button"
                                    className="btn btn-link p-0 text-start text-decoration-none"
                                    onClick={() => navigate(`/opportunities/${b.opportunity_id}`)}
                                  >
                                    {b.opportunity_title}
                                  </button>
                                </td>
                                <td>{b.session_start ? new Date(b.session_start).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
                                <td>
                                  <span title={b.participant_email}>{b.participant_name || b.participant_email || '—'}</span>
                                </td>
                                <td>
                                  <span className={`badge ${b.status === 'booked' ? 'bg-success' : 'bg-secondary'}`}>
                                    {b.status === 'booked' ? 'Booked' : b.status}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Navigation Tabs */}
            <div className="admin-tabs-container tabs-container">
              <ul className="nav nav-tabs nav-fill" role="tablist" style={{ border: 'none', margin: 0 }}>
                <li className="nav-item">
                  <button
                    className={`custom-tab-button ${activeTab === 'opportunities' ? 'active' : ''}`}
                    onClick={() => setActiveTab('opportunities')}
                    role="tab"
                    aria-selected={activeTab === 'opportunities'}
                    aria-controls="research-studies-tab"
                    tabIndex={0}
                  >
                    <List size={16} className="me-2" />
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
                    <History size={16} className="me-2" />
                    <span>Completion Approvals</span>
                  </button>
                </li>
                {/* Feedback tab - all admins (researcher_admin and superadmin) */}
                <li className="nav-item">
                  <button
                    className={`custom-tab-button ${activeTab === 'feedback' ? 'active' : ''}`}
                    onClick={() => setActiveTab('feedback')}
                    role="tab"
                    aria-selected={activeTab === 'feedback'}
                    aria-controls="feedback-tab"
                    tabIndex={0}
                  >
                    <MessageSquare size={16} className="me-2" />
                    <span>Feedback</span>
                  </button>
                </li>
              </ul>
            </div>

            <div className="card-body card-body-transparent">
              {/* Tab Content */}
              <div className="tab-content tab-content-padded">
                {/* Research Studies Tab */}
                <div 
                  className={`tab-pane fade ${activeTab === 'opportunities' ? 'show active' : ''}`}
                  id="research-studies-tab"
                  role="tabpanel"
                  aria-labelledby="research-studies-tab-button"
                >
                  {/* Filters - using flexbox instead of Bootstrap grid for precise alignment */}
                  <div className="filters-row">
                    <div className="filter-field">
                      <label htmlFor="searchFilter" className="form-label mb-2">
                        Search Studies
                      </label>
                      <input
                        ref={searchInputRef}
                        type="text"
                        id="searchFilter"
                        className="form-control"
                        placeholder="Search by title or description..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>
                    <div className="filter-field-sm">
                      <label htmlFor="statusFilter" className="form-label mb-2">Status</label>
                      <select
                        id="statusFilter"
                        className="form-select"
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                      >
                        <option value="">All Statuses</option>
                        <option value="draft">Draft</option>
                        <option value="published">Published</option>
                        <option value="closed">Closed</option>
                      </select>
                    </div>
                    <div className="filter-field-sm">
                      <label htmlFor="typeFilter" className="form-label mb-2">Study Type</label>
                      <select
                        id="typeFilter"
                        className="form-select"
                        value={typeFilter}
                        onChange={(e) => setTypeFilter(e.target.value)}
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
                      icon="alert-triangle"
                    />
                  )}

                  {/* Loading State */}
                  {loadingOpportunities && (
                    <div className="text-center py-4">
                      <div className="spinner-border" role="status">
                        <span className="visually-hidden">Loading...</span>
                      </div>
                      <p className="mt-2 admin-loading-text">Loading research studies...</p>
                    </div>
                  )}

                  {/* Empty State */}
                  {!loadingOpportunities && !error && sortedOpportunities.length === 0 && (
                    <div className="text-center py-5">
                      <h4 className="admin-empty-title">No research studies found</h4>
                                  <p className="admin-empty-text">
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
                    <div className="table-responsive" style={{ 
                      minHeight: '400px', 
                      overflow: 'visible', 
                      width: '100%'
                    }}>
                      <table className="table table-hover admin-data-table">
                        <thead>
                          <tr>
                            <th className="admin-th col-title" onClick={() => handleSort('title')}>
                              Title {sortField === 'title' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th className="admin-th col-type" onClick={() => handleSort('type')}>
                              Type {sortField === 'type' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th className="admin-th col-status" onClick={() => handleSort('status')}>
                              Status {sortField === 'status' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th className="admin-th col-metric col-numeric">Clicks</th>
                            <th className="admin-th col-metric col-numeric">Capacity</th>
                            <th className="admin-th col-metric col-numeric">Booked</th>
                            <th className="admin-th col-date" onClick={() => handleSort('created_at')}>
                              Created {sortField === 'created_at' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th className="admin-th col-actions">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedOpportunities.map((opportunity) => (
                            <tr 
                              key={opportunity.id}
                              className="admin-row-clickable"
                              onClick={(e) => {
                                // Ignore keyboard events (detail is 0)
                                if (e.detail === 0) return;
                                
                                // Ignore text selection (if user selected text)
                                const selection = window.getSelection();
                                if (selection && selection.toString().length > 0) return;
                                
                                // Only navigate if the click target is not an interactive element
                                const target = e.target as HTMLElement;
                                const isInteractive = target.closest('button, a, input, select, textarea, [role="button"], .dropdown, .dropdown-menu, .dropdown-item');
                                if (!isInteractive) {
                                  navigate(`/admin/opportunities/${opportunity.id}/edit`);
                                }
                              }}
                              onMouseDown={(e) => {
                                // Ensure we don't trigger anything on mousedown
                              }}
                              onKeyDown={(e) => {
                                // Prevent keyboard navigation on row
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                }
                              }}
                              tabIndex={-1}
                              role="presentation"
                              aria-label={`Opportunity: ${opportunity.title}`}
                              onFocus={(e) => {
                                // Prevent focus on table rows
                                e.currentTarget.blur();
                              }}
                            >
                              <td className="col-title">
                                <div>
                                  <strong className="row-title">{opportunity.title}</strong>
                                  <small className="row-desc">{opportunity.purpose_one_liner}</small>
                                </div>
                              </td>
                              <td className="col-type">
                                <span className={`${getTypeBadgeClass(opportunity.type)} badge--${opportunity.type}`}>
                                  {formatOpportunityType(opportunity.type)}
                                </span>
                              </td>
                              <td className="col-status">
                                <span className={getStatusBadgeClass(opportunity.status)}>
                                  {opportunity.status === 'published' ? 'live' : opportunity.status}
                                </span>
                                {opportunity.status === 'closed' && (
                                  <span className="badge bg-dark ms-1">Auto-closed</span>
                                )}
                              </td>
                              <td className="col-metric col-numeric">
                                {(opportunity.type === 'poll' || opportunity.type === 'survey' || opportunity.type === 'unmoderated') ? (
                                  opportunity.clicks_total ?? 0
                                ) : (
                                  ''
                                )}
                              </td>
                              <td className="col-metric col-numeric">
                                {(opportunity.type === 'test' || opportunity.type === 'interview') ? (
                                  opportunity.sessions && opportunity.sessions.length > 0 ? (
                                    opportunity.sessions.reduce((sum, s) => sum + s.capacity, 0)
                                  ) : (
                                    ''
                                  )
                                ) : (
                                  ''
                                )}
                              </td>
                              <td className="col-metric col-numeric">
                                {(opportunity.type === 'test' || opportunity.type === 'interview') && opportunity.sessions && opportunity.sessions.length > 0 ? (
                                  (() => {
                                    const totalSlots = opportunity.sessions.reduce((sum, s) => sum + s.capacity, 0);
                                    const bookedSlots = opportunity.sessions.reduce((sum, s) => sum + (s.booked_count || 0), 0);
                                    const percentage = totalSlots > 0 ? (bookedSlots / totalSlots) * 100 : 0;
                                    return (
                                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                                        <span>{bookedSlots} / {totalSlots}</span>
                                        <div className="progress-mini">
                                          <div 
                                            className="progress-mini__fill" 
                                            style={{ width: `${percentage}%` }}
                                          />
                                        </div>
                                      </div>
                                    );
                                  })()
                                ) : (
                                  ''
                                )}
                              </td>
                              <td className="col-date">
                                <small className="admin-cell-metadata">
                                  {new Date(opportunity.created_at).toLocaleDateString()}
                                </small>
                              </td>
                              <td className="col-actions">
                                                <div className="dropdown">
                                                  <button
                                                    className="btn btn-outline-secondary btn-sm admin-action-btn admin-action-btn-kebab"
                                                    type="button"
                                                    onClick={(e) => {
                                                      e.preventDefault();
                                                      e.stopPropagation();
                                                      toggleDropdown(opportunity.id);
                                                    }}
                                                    onMouseDown={(e) => {
                                                      e.stopPropagation();
                                                    }}
                                                    onKeyDown={(e) => {
                                                      // Allow keyboard activation of the button
                                                      e.stopPropagation();
                                                    }}
                                                    aria-expanded={openDropdownId === opportunity.id}
                                                    title="Actions"
                                                  >
                                                    ⋮
                                                  </button>
                                  {openDropdownId === opportunity.id && (
                                    <div 
                                      className="dropdown-menu show admin-action-dropdown admin-action-dropdown-menu"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <button
                                        className="dropdown-item"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          navigate(`/opportunities/${opportunity.id}`);
                                          closeDropdown();
                                        }}
                                      >
                                        View
                                      </button>
                                      <button
                                        className="dropdown-item"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          navigate(`/admin/opportunities/${opportunity.id}/edit`);
                                          closeDropdown();
                                        }}
                                      >
                                        Edit
                                      </button>
                                      <button
                                        className="dropdown-item"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleDuplicate(opportunity.id);
                                          closeDropdown();
                                        }}
                                      >
                                        Copy
                                      </button>
                                      {/* Analytics - Only for polls, surveys, and unmoderated tests */}
                                      {(opportunity.type === 'poll' || opportunity.type === 'survey' || opportunity.type === 'unmoderated') && (
                                        <>
                                          <div className="dropdown-divider" />
                                          <button
                                            className="dropdown-item"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              navigate(`/admin/opportunities/${opportunity.id}/analytics`);
                                              closeDropdown();
                                            }}
                                          >
                                            Analytics
                                          </button>
                                        </>
                                      )}
                                      <div className="dropdown-divider" />
                                      <button
                                        className="dropdown-item text-danger"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleDelete(opportunity.id, opportunity.title);
                                          closeDropdown();
                                        }}
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

                {/* Feedback Tab - all admins (researcher_admin and superadmin) */}
                <div 
                  className={`tab-pane fade ${activeTab === 'feedback' ? 'show active' : ''}`}
                  id="feedback-tab"
                  role="tabpanel"
                  aria-labelledby="feedback-tab-button"
                >
                  <AdminFeedback />
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
    </div>
  );
};

export default Admin;
