import React, { useState, useEffect, useRef } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getOpportunities, deleteOpportunity, duplicateOpportunity, getDashboardStats, DashboardStats } from '../api/client';
import { Opportunity } from '../api/types';
import { formatOpportunityType, getTypeBadgeClass } from '../utils/opportunityUtils';
import PendingApprovals from '../components/PendingApprovals';
import ErrorState from '../components/ErrorState';
import useKeyboardShortcuts from '../hooks/useKeyboardShortcuts';
import ConfirmationModal from '../components/ConfirmationModal';
import '../components/Header.css';

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
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  
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

  const loadDashboardStats = async () => {
    try {
      setLoadingStats(true);
      const stats = await getDashboardStats();
      setDashboardStats(stats);
    } catch (err) {
      console.error('Error loading dashboard stats:', err);
      // Don't show error to user, just log it
    } finally {
      setLoadingStats(false);
    }
  };

  useEffect(() => {
    if (user?.role === 'researcher_admin') {
      loadOpportunities();
      loadDashboardStats();
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

  if (user.role !== 'researcher_admin') {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="container-fluid" style={{ minHeight: '100vh', padding: '2rem', backgroundColor: '#0A091A' }}>
      <style>
        {`
          .custom-tab-button {
            color: #E0E0E0 !important;
            background-color: rgba(255, 255, 255, 0.05) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            padding: 0.5rem 1rem !important;
            cursor: pointer !important;
            width: 100% !important;
            text-align: center !important;
            font-weight: 500 !important;
            transition: all 0.2s ease-in-out !important;
          }
          .custom-tab-button.active {
            background-color: #FF4E50 !important;
            border-color: #FF4E50 !important;
          }
          .custom-tab-button:hover {
            background-color: rgba(255, 255, 255, 0.1) !important;
            border-color: #FF4E50 !important;
          }
          .custom-tab-button.active:hover {
            background-color: #FF4E50 !important;
            border-color: #FF4E50 !important;
          }
          .custom-tab-button.active {
            color: #FFFFFF !important;
          }
          .custom-tab-button.active i,
          .custom-tab-button.active span {
            color: #FFFFFF !important;
          }
          .custom-tab-button i,
          .custom-tab-button span {
            color: #E0E0E0 !important;
          }
          
          /* Admin dashboard dark theme form controls */
          .admin-dashboard .form-control,
          .admin-dashboard .form-select {
            background-color: rgba(255, 255, 255, 0.05) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            color: #E0E0E0 !important;
          }
          .admin-dashboard .form-control:focus,
          .admin-dashboard .form-select:focus {
            background-color: rgba(255, 255, 255, 0.08) !important;
            border-color: #FF4E50 !important;
            color: #E0E0E0 !important;
            box-shadow: 0 0 0 0.2rem rgba(255, 78, 80, 0.25) !important;
          }
          .admin-dashboard .form-control::placeholder {
            color: rgba(224, 224, 224, 0.5) !important;
          }
          .admin-dashboard .form-label {
            color: #E0E0E0 !important;
          }
          .admin-dashboard .form-select option {
            background-color: #0A091A !important;
            color: #E0E0E0 !important;
          }
          
          /* Admin dashboard table styling - Dark theme with glassmorphism */
          /* OVERRIDE ALL BOOTSTRAP TABLE STYLES - FORCE DARK THEME */
          .admin-dashboard table,
          .admin-dashboard .table,
          .admin-dashboard table.table,
          .admin-dashboard table.table-hover,
          .admin-dashboard table.table-striped {
            background-color: transparent !important;
            background: transparent !important;
            color: var(--text-primary) !important;
          }
          .admin-dashboard .table-responsive {
            background-color: transparent !important;
            background: transparent !important;
            border-radius: var(--card-radius);
          }
          /* Table header - glassmorphism */
          .admin-dashboard table.table-hover thead,
          .admin-dashboard table thead,
          .admin-dashboard table.table-striped thead {
            background-color: rgba(255, 255, 255, 0.05) !important;
            background: rgba(255, 255, 255, 0.05) !important;
          }
          .admin-dashboard table.table-hover thead th,
          .admin-dashboard table thead th,
          .admin-dashboard table.table-striped thead th {
            color: var(--text-primary) !important;
            background-color: rgba(255, 255, 255, 0.05) !important;
            background: rgba(255, 255, 255, 0.05) !important;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-top: none !important;
            border-left: none !important;
            border-right: none !important;
          }
          /* Table body - transparent */
          .admin-dashboard table.table-hover tbody,
          .admin-dashboard table tbody,
          .admin-dashboard table.table-striped tbody {
            background-color: transparent !important;
            background: transparent !important;
          }
          /* Table rows - transparent by default */
          .admin-dashboard table.table-hover tbody tr,
          .admin-dashboard table tbody tr,
          .admin-dashboard table.table-striped tbody tr,
          .admin-dashboard table.table-striped tbody tr:nth-of-type(odd),
          .admin-dashboard table.table-striped tbody tr:nth-of-type(even) {
            background-color: transparent !important;
            background: transparent !important;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05) !important;
          }
          /* Table rows - glassmorphism on hover */
          .admin-dashboard table.table-hover tbody tr:hover,
          .admin-dashboard table tbody tr:hover,
          .admin-dashboard table.table-striped tbody tr:hover {
            background-color: rgba(255, 255, 255, 0.05) !important;
            background: rgba(255, 255, 255, 0.05) !important;
          }
          /* Table cells - transparent */
          .admin-dashboard table.table-hover tbody td,
          .admin-dashboard table tbody td,
          .admin-dashboard table.table-striped tbody td,
          .admin-dashboard table.table-hover thead th,
          .admin-dashboard table thead th {
            color: var(--text-primary) !important;
            background-color: transparent !important;
            background: transparent !important;
            border: none !important;
            border-bottom: none !important;
          }
          /* Override any Bootstrap table cell backgrounds */
          .admin-dashboard table td,
          .admin-dashboard table th {
            background-color: transparent !important;
            background: transparent !important;
          }
          /* Ensure header cells maintain glassmorphism */
          .admin-dashboard table thead th {
            background-color: rgba(255, 255, 255, 0.05) !important;
            background: rgba(255, 255, 255, 0.05) !important;
          }
          
          /* Status badges - Momentum Design System */
          .admin-dashboard .badge.status-published,
          .admin-dashboard .badge.status-draft,
          .admin-dashboard .badge.status-closed {
            border-radius: var(--tag-radius);
            padding: var(--tag-padding);
            font-size: var(--tag-font-size);
            font-weight: var(--tag-font-weight);
            display: inline-flex;
            align-items: center;
            transition: filter var(--transition-card);
          }
          .admin-dashboard .badge.status-published {
            background-color: #28a745 !important;
          }
          .admin-dashboard .badge.status-draft {
            background-color: #ffc107 !important;
            color: #000000 !important;
          }
          .admin-dashboard .badge.status-closed {
            background-color: #6c757d !important;
          }
          .admin-dashboard .badge.status-published:hover,
          .admin-dashboard .badge.status-draft:hover,
          .admin-dashboard .badge.status-closed:hover {
            filter: brightness(103%);
          }
          
          /* Admin dashboard card body - transparent to match design system */
          .admin-dashboard .card-body {
            background-color: transparent !important;
          }
          
          /* Tab content area styling */
          .admin-dashboard .tab-content {
            background-color: transparent !important;
          }
        `}
      </style>
      <div className="row admin-dashboard">
        <div className="col-12">
          <div className="card" style={{ 
            minHeight: 'calc(100vh - 4rem)',
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px'
          }}>
            <div className="card-header d-flex justify-content-between align-items-center border-0 bg-transparent" style={{ marginBottom: '2rem' }}>
              <h1 className="h3 mb-0" style={{ color: '#E0E0E0' }}>Admin Dashboard</h1>
              <div className="d-flex gap-2">
                <button 
                  className="btn btn-outline-secondary"
                  onClick={() => navigate('/admin/settings')}
                  aria-label="Settings"
                  style={{
                    backgroundColor: 'transparent',
                    borderColor: 'rgba(255, 255, 255, 0.2)',
                    color: '#E0E0E0'
                  }}
                >
                  <i className="bi bi-gear me-2"></i>
                  Settings
                </button>
                <button 
                  className="btn btn-primary"
                  onClick={() => navigate('/admin/opportunities/new')}
                  aria-label="Create new research study"
                  style={{
                    backgroundColor: '#FF4E50',
                    borderColor: '#FF4E50',
                    color: '#FFFFFF'
                  }}
                >
                  Create Research Study →
                </button>
              </div>
            </div>

            {/* Dashboard Statistics Cards */}
            {dashboardStats && (
              <div className="row mb-4">
                <div className="col-md-3 col-sm-6 mb-3">
                  <div className="card border-0 shadow-sm h-100" style={{ 
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '16px'
                  }}>
                    <div className="card-body d-flex flex-column" style={{ padding: '1rem' }}>
                      <div className="d-flex">
                        <div className="me-3" style={{ fontSize: '2.5rem', lineHeight: '1', alignSelf: 'flex-start', color: '#FF4E50' }}>
                          <i className="bi bi-clipboard-data"></i>
                        </div>
                        <div style={{ flex: 1 }}>
                          <h6 className="text-uppercase mb-1" style={{ fontSize: '0.75rem', color: '#E0E0E0', opacity: 0.7 }}>Total Opportunities</h6>
                          <h3 className="mb-0" style={{ color: '#E0E0E0', fontWeight: '600' }}>{dashboardStats.total_opportunities}</h3>
                          <small style={{ color: '#E0E0E0', opacity: 0.7, fontSize: '14px' }}>
                            {dashboardStats.published_opportunities} published, {dashboardStats.draft_opportunities} draft
                          </small>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="col-md-3 col-sm-6 mb-3">
                  <div className="card border-0 shadow-sm h-100" style={{ 
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '16px'
                  }}>
                    <div className="card-body d-flex flex-column" style={{ padding: '1rem' }}>
                      <div className="d-flex">
                        <div className="me-3" style={{ fontSize: '2.5rem', lineHeight: '1', alignSelf: 'flex-start', color: '#FF4E50' }}>
                          <i className="bi bi-calendar-check"></i>
                        </div>
                        <div style={{ flex: 1 }}>
                          <h6 className="text-uppercase mb-1" style={{ fontSize: '0.75rem', color: '#E0E0E0', opacity: 0.7 }}>Total Bookings</h6>
                          <h3 className="mb-0" style={{ color: '#E0E0E0', fontWeight: '600' }}>{dashboardStats.total_bookings}</h3>
                          <small style={{ color: '#E0E0E0', opacity: 0.7, fontSize: '14px' }}>
                            {dashboardStats.upcoming_bookings} upcoming, {dashboardStats.past_bookings} past
                          </small>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="col-md-3 col-sm-6 mb-3">
                  <div className="card border-0 shadow-sm h-100" style={{ 
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '16px'
                  }}>
                    <div className="card-body d-flex flex-column" style={{ padding: '1rem' }}>
                      <div className="d-flex">
                        <div className="me-3" style={{ fontSize: '2.5rem', lineHeight: '1', alignSelf: 'flex-start', color: '#FF4E50' }}>
                          <i className="bi bi-people"></i>
                        </div>
                        <div style={{ flex: 1 }}>
                          <h6 className="text-uppercase mb-1" style={{ fontSize: '0.75rem', color: '#E0E0E0', opacity: 0.7 }}>Participants</h6>
                          <h3 className="mb-0" style={{ color: '#E0E0E0', fontWeight: '600' }}>{dashboardStats.total_participants}</h3>
                          <small style={{ color: '#E0E0E0', opacity: 0.7, fontSize: '14px' }}>Unique participants</small>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="col-md-3 col-sm-6 mb-3">
                  <div className="card border-0 shadow-sm h-100" style={{ 
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '16px'
                  }}>
                    <div className="card-body d-flex flex-column" style={{ padding: '1rem' }}>
                      <div className="d-flex">
                        <div className="me-3" style={{ fontSize: '2.5rem', lineHeight: '1', alignSelf: 'flex-start', color: '#FF4E50' }}>
                          <i className="bi bi-clock"></i>
                        </div>
                        <div style={{ flex: 1 }}>
                          <h6 className="text-uppercase mb-1" style={{ fontSize: '0.75rem', color: '#E0E0E0', opacity: 0.7 }}>Available Slots</h6>
                          <h3 className="mb-0" style={{ color: '#E0E0E0', fontWeight: '600' }}>{dashboardStats.available_slots}</h3>
                          <small style={{ color: '#E0E0E0', opacity: 0.7, fontSize: '14px' }}>
                            {dashboardStats.booked_slots} of {dashboardStats.total_slots} booked
                          </small>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

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
            
            <div className="card-body" style={{ backgroundColor: 'transparent', padding: '0' }}>
              {/* Tab Content */}
              <div className="tab-content" style={{ padding: '1.5rem' }}>
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
                      <p className="mt-2" style={{ color: '#E0E0E0' }}>Loading research studies...</p>
                    </div>
                  )}

                  {/* Empty State */}
                  {!loadingOpportunities && !error && sortedOpportunities.length === 0 && (
                    <div className="text-center py-5">
                      <h4 style={{ color: '#E0E0E0' }}>No research studies found</h4>
                                  <p style={{ color: '#E0E0E0', opacity: 0.7 }}>
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
                      <table className="table table-hover">
                        <thead>
                          <tr>
                            <th 
                              style={{ cursor: 'pointer', userSelect: 'none', fontWeight: '600', padding: '16px 12px' }}
                              onClick={() => handleSort('title')}
                            >
                              Title {sortField === 'title' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th 
                              style={{ cursor: 'pointer', userSelect: 'none', fontWeight: '600', padding: '16px 12px' }}
                              onClick={() => handleSort('type')}
                            >
                              Type {sortField === 'type' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th style={{ fontWeight: '600', padding: '16px 12px' }}>Participants</th>
                            <th 
                              style={{ cursor: 'pointer', userSelect: 'none', fontWeight: '600', padding: '16px 12px' }}
                              onClick={() => handleSort('status')}
                            >
                              Status {sortField === 'status' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th style={{ fontWeight: '600', padding: '16px 12px' }}>Clicks</th>
                            <th style={{ fontWeight: '600', padding: '16px 12px' }}>Sessions</th>
                            <th style={{ fontWeight: '600', padding: '16px 12px' }}>Total Slots</th>
                            <th style={{ fontWeight: '600', padding: '16px 12px' }}>Remaining</th>
                            <th style={{ fontWeight: '600', padding: '16px 12px' }}>Duration</th>
                            <th 
                              style={{ cursor: 'pointer', userSelect: 'none', fontWeight: '600', padding: '16px 12px' }}
                              onClick={() => handleSort('created_at')}
                            >
                              Created {sortField === 'created_at' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th style={{ fontWeight: '600', padding: '16px 12px' }}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedOpportunities.map((opportunity) => (
                            <tr 
                              key={opportunity.id}
                              style={{ cursor: 'pointer' }}
                              onClick={() => navigate(`/admin/opportunities/${opportunity.id}/edit`)}
                            >
                              <td style={{ padding: '16px 12px', verticalAlign: 'middle' }}>
                                <div>
                                  <strong style={{ fontSize: 'var(--font-size-body)', fontWeight: 'var(--font-weight-card-title)' }}>{opportunity.title}</strong>
                                  <br />
                                  <small style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)', lineHeight: '1.25' }}>{opportunity.purpose_one_liner}</small>
                                </div>
                              </td>
                              <td style={{ padding: '16px 12px', verticalAlign: 'middle' }}>
                                <span className={getTypeBadgeClass(opportunity.type)}>
                                  {formatOpportunityType(opportunity.type)}
                                </span>
                              </td>
                              <td style={{ padding: '16px 12px', verticalAlign: 'middle' }}>
                                <span className="badge" style={{ 
                                  backgroundColor: 'var(--tag-test)', 
                                  color: 'var(--tag-text)',
                                  borderRadius: 'var(--tag-radius)', 
                                  padding: 'var(--tag-padding)', 
                                  fontSize: 'var(--tag-font-size)', 
                                  fontWeight: 'var(--tag-font-weight)',
                                  display: 'inline-flex',
                                  alignItems: 'center'
                                }}>
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
                              <td style={{ padding: '16px 12px', verticalAlign: 'middle' }}>
                                <span className={getStatusBadgeClass(opportunity.status)}>
                                  {opportunity.status}
                                </span>
                                {opportunity.status === 'closed' && (
                                  <span className="badge bg-dark ms-1">Auto-closed</span>
                                )}
                              </td>
                              <td style={{ color: 'var(--text-muted)', padding: '16px 12px', verticalAlign: 'middle' }}>
                                {(opportunity.type === 'poll' || opportunity.type === 'survey') ? (
                                  opportunity.clicks_total ?? 0
                                ) : (
                                  ''
                                )}
                              </td>
                              <td style={{ color: 'var(--text-muted)', padding: '16px 12px', verticalAlign: 'middle' }}>
                                {(opportunity.type === 'test' || opportunity.type === 'interview') ? (
                                  opportunity.sessions?.length || 0
                                ) : (
                                  ''
                                )}
                              </td>
                              <td style={{ padding: '16px 12px', verticalAlign: 'middle' }}>
                                {(opportunity.type === 'test' || opportunity.type === 'interview') ? (
                                  opportunity.sessions && opportunity.sessions.length > 0 ? (
                                    <span className="badge bg-success text-white" style={{ 
                                      borderRadius: 'var(--tag-radius)', 
                                      padding: 'var(--tag-padding)', 
                                      fontSize: 'var(--tag-font-size)', 
                                      fontWeight: 'var(--tag-font-weight)',
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      transition: 'filter var(--transition-card)'
                                    }}>
                                      {opportunity.sessions.reduce((sum, s) => sum + s.capacity, 0)}
                                    </span>
                                  ) : (
                                    ''
                                  )
                                ) : (
                                  ''
                                )}
                              </td>
                              <td style={{ padding: '16px 12px', verticalAlign: 'middle' }}>
                                {(opportunity.type === 'test' || opportunity.type === 'interview') ? (
                                  ''
                                ) : (
                                  ''
                                )}
                              </td>
                              <td style={{ color: 'var(--text-muted)', padding: '16px 12px', verticalAlign: 'middle' }}>{opportunity.default_duration_minutes} min</td>
                              <td style={{ padding: '16px 12px', verticalAlign: 'middle' }}>
                                <small style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>
                                  {new Date(opportunity.created_at).toLocaleDateString()}
                                </small>
                              </td>
                              <td style={{ padding: '16px 12px', verticalAlign: 'middle' }}>
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
                                    style={{ fontSize: '16px', fontWeight: 'bold', padding: '4px 8px', color: 'var(--text-muted)' }}
                                  >
                                    ⋮
                                  </button>
                                  {openDropdownId === opportunity.id && (
                                    <div 
                                      className="dropdown-menu show" 
                                      style={{ 
                                        position: 'absolute', 
                                        zIndex: 1000,
                                        minWidth: '140px',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        width: 'auto',
                                        top: '100%',
                                        left: '0',
                                        marginTop: '4px'
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <button
                                        className="dropdown-item"
                                        onClick={() => {
                                          navigate(`/opportunities/${opportunity.id}`);
                                          closeDropdown();
                                        }}
                                      >
                                        View
                                      </button>
                                      <button
                                        className="dropdown-item"
                                        onClick={() => {
                                          navigate(`/admin/opportunities/${opportunity.id}/edit`);
                                          closeDropdown();
                                        }}
                                      >
                                        Edit
                                      </button>
                                      <button
                                        className="dropdown-item"
                                        onClick={() => {
                                          handleDuplicate(opportunity.id);
                                          closeDropdown();
                                        }}
                                      >
                                        Copy
                                      </button>
                                      {/* Analytics - Only for polls and surveys */}
                                      {(opportunity.type === 'poll' || opportunity.type === 'survey') && (
                                        <>
                                          <div className="dropdown-divider"></div>
                                          <button
                                            className="dropdown-item"
                                            onClick={() => {
                                              navigate(`/admin/opportunities/${opportunity.id}/analytics`);
                                              closeDropdown();
                                            }}
                                          >
                                            <i className="bi bi-graph-up me-2"></i>
                                            Analytics
                                          </button>
                                        </>
                                      )}
                                      <div className="dropdown-divider"></div>
                                      <button
                                        className="dropdown-item text-danger"
                                        onClick={() => {
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
