import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getOpportunities, deleteOpportunity, duplicateOpportunity, getDashboardStats, DashboardStats, exportBookingsCsv, getPendingApprovals, getFeedback } from '../api/client';
import { Opportunity } from '../api/types';
import { getTypeBadgeClass, getTimeRemainingUntil } from '../utils/opportunityUtils';
import {
  getRecruitment,
  getSessionsThisWeek,
  getStudiesClosingSoon,
  getNextMilestone,
  getDisplayStatus,
  getAdminTypeLabel,
  matchesQuickFilter,
  relativeDayLabel,
  QuickFilter,
} from '../utils/adminDashboard';
import { logger } from '../utils/logger';
import PendingApprovals from '../components/PendingApprovals';
import AdminFeedback from '../components/AdminFeedback';
import ErrorState from '../components/ErrorState';
import ConfirmationModal from '../components/ConfirmationModal';
import { Dropdown, DropdownItem, DropdownDivider } from '../components/ui';
import { Settings, ClipboardList, Users, Clock, List, History, MessageSquare, Calendar, Download, Clapperboard, Flag, ArrowRight, CalendarClock, CheckCircle } from 'lucide-react';

import { formatStudyDate, formatClockTime, formatTimeZoneLabel } from '../utils/datetime';
const Admin: React.FC = () => {
  const { user, loading, initialAuthCheck } = useAuth();
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
  const [activeTab, setActiveTab] = useState<'opportunities' | 'approvals' | 'feedback' | 'bookings'>('opportunities');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [sortField, setSortField] = useState<'title' | 'created_at' | 'type' | 'status'>('created_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string>('');
  // Counts for the tab badges and the "Needs attention" panel. Fetched here so
  // the badge shows a number without opening the tab; the tab components still
  // own their own full fetch.
  const [pendingApprovalsCount, setPendingApprovalsCount] = useState<number | null>(null);
  const [feedbackCount, setFeedbackCount] = useState<{ count: number; hasMore: boolean } | null>(null);
  const [quickFilter, setQuickFilter] = useState<QuickFilter | null>(null);
  // One clock reading per mount, shared by every "now"-relative derivation on
  // the page so the snapshot and the table agree with each other.
  const now = useMemo(() => new Date(), []);


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

  // Quick-filter chips narrow the search results further, client-side over the
  // already-loaded list. Each predicate reads only real fields (status, session
  // capacity, closing time) - see adminDashboard.ts.
  const quickFilteredOpportunities = useMemo(() => {
    if (!quickFilter) return filteredOpportunities;
    return filteredOpportunities.filter((opp) => matchesQuickFilter(opp, quickFilter, now));
  }, [filteredOpportunities, quickFilter, now]);

  // Sort filtered opportunities (memoized for performance)
  const sortedOpportunities = useMemo(() => {
    return [...quickFilteredOpportunities].sort((a, b) => {
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
  }, [quickFilteredOpportunities, sortField, sortDirection]);

  // "Needs attention" and "Sessions this week" derive from the loaded studies.
  const studiesClosingSoon = useMemo(() => getStudiesClosingSoon(opportunities, now), [opportunities, now]);
  const sessionsThisWeek = useMemo(() => getSessionsThisWeek(opportunities, now), [opportunities, now]);
  // The panel is permanent: it shows action cards when there is something to do,
  // and a slim all-clear line otherwise.
  const attentionClear = (pendingApprovalsCount ?? 0) === 0 && studiesClosingSoon.length === 0;

  const handleSort = (field: 'title' | 'created_at' | 'type' | 'status') => {
    if (field === sortField) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // aria-sort tells a screen reader which column is sorted and which way - the
  // bare ↑/↓ glyph never did (row 13). Only the active column is asc/desc; the
  // rest are 'none' so the table reports one sorted column, not seven.
  const ariaSortFor = (field: 'title' | 'created_at' | 'type' | 'status'): 'ascending' | 'descending' | 'none' =>
    sortField === field ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none';

  const toggleQuickFilter = (filter: QuickFilter) => {
    setQuickFilter((current) => (current === filter ? null : filter));
  };

  // Whether any Research Studies filter is active - drives the "Clear filters"
  // affordance and the empty-state copy.
  const hasActiveFilters = Boolean(searchQuery || statusFilter || typeFilter || quickFilter);

  const clearAllFilters = () => {
    setSearchQuery('');
    setStatusFilter('');
    setTypeFilter('');
    setQuickFilter(null);
  };

  // Memoised on the filters it actually reads. Both effects below name it in
  // their dependency arrays, which is only safe because of this - as a plain
  // function it was rebuilt every render and would have looped.
  const loadOpportunities = useCallback(async (forceClearFilter = false) => {
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
      // The banner says the same thing whatever went wrong, so without this the
      // cause was gone. The API interceptor records a failed request, which is
      // most of them - but not a throw from anything else in the try, and not
      // which call the admin was actually making when it happened.
      logger.error('Failed to load research studies', {
        component: 'Admin',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      setError('Failed to load research studies');
      setOpportunities([]);
    } finally {
      setLoadingOpportunities(false);
    }
  }, [statusFilter, typeFilter]);

  const loadDashboardStats = useCallback(async () => {
    try {
      setLoadingStats(true);
      const stats = await getDashboardStats();
      setDashboardStats(stats);
    } catch (error: unknown) {
      // Deliberately not shown: the dashboard tiles are a summary, and an admin
      // can do everything on this page without them. Deliberately not silent
      // either - this was the only site here with no user surface AND no log,
      // so a permanently empty stats row looked identical to a genuinely empty
      // deployment.
      logger.warn('Failed to load dashboard stats', {
        component: 'Admin',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoadingStats(false);
    }
  }, []);

  // Counts for the tab badges and the approvals attention card. A failure here
  // must not blank the page - it just leaves the badge absent, so warn and move
  // on rather than surfacing an error banner over a working dashboard.
  const loadCounts = useCallback(async () => {
    try {
      const approvals = await getPendingApprovals();
      setPendingApprovalsCount(Array.isArray(approvals) ? approvals.length : 0);
    } catch (error: unknown) {
      logger.warn('Failed to load pending-approvals count', {
        component: 'Admin',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const feedback = await getFeedback();
      setFeedbackCount({ count: feedback.items.length, hasMore: feedback.has_more });
    } catch (error: unknown) {
      logger.warn('Failed to load feedback count', {
        component: 'Admin',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'researcher_admin' || user?.role === 'superadmin') {
      loadOpportunities();
      loadDashboardStats();
      loadCounts();
    }
    // statusFilter and typeFilter are not listed directly: loadOpportunities is
    // memoised on them, so its identity already changes when they do.
  }, [user, loadOpportunities, loadDashboardStats, loadCounts]);

  // Refresh opportunities when returning from editing or creating
  useEffect(() => {
    if (location.state?.refresh && (user?.role === 'researcher_admin' || user?.role === 'superadmin')) {
      // Show success message if provided
      if (location.state?.message) {
        setSuccessMessage(location.state.message);
        // Clear success message after delay (longer for draft warnings)
        const isDraftWarning = location.state.message.includes('DRAFT');
        setTimeout(() => setSuccessMessage(''), isDraftWarning ? 5000 : 3000);
      }
      // Clear the refresh state first to prevent duplicate calls
      navigate(location.pathname, { replace: true, state: {} });
      // Force refresh without filters to ensure new items are visible
      // Use a small delay to ensure navigation is complete
      setTimeout(() => {
        loadOpportunities(true); // true = force clear filters
      }, 150);
    }
  }, [location.state, user, navigate, location.pathname, loadOpportunities]);

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
      // A 403 from the owner gate and a 500 both read as this one sentence, so
      // record which it was - the two need completely different responses.
      logger.error('Failed to delete research study', {
        component: 'Admin',
        opportunityId: deleteConfirm.opportunity.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
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
      // Note this also catches a failure of the RELOAD, where the duplicate did
      // in fact get created - so the message can be wrong, and the cause is the
      // only way to tell.
      logger.error('Failed to duplicate research study', {
        component: 'Admin',
        opportunityId: id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      setError('Failed to duplicate research study');
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
                    onClick={() => navigate('/admin/studies')}
                    aria-label="Task lists"
                  >
                    <Clapperboard size={16} className="me-2" />
                    <span className="d-none d-md-inline">Task Lists</span>
                    <span className="d-md-none">Tasks</span>
                  </button>
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

            {/* Success/Warning Message */}
            {successMessage && (
              <div className={`alert ${successMessage.includes('DRAFT') ? 'alert-warning' : 'alert-success'} mx-4 mt-4 mb-3`} role="alert">
                {successMessage}
              </div>
            )}

            {/* Needs attention - a PERMANENT triage panel. It shows action cards
                when there are approvals waiting or studies closing soon, and a
                slim all-clear line otherwise, so it always has a presence. The
                "needs recruitment" card the wireframe showed is deliberately
                omitted: it needs a per-study participant target the backend
                does not expose. */}
            <section
              className={`admin-attention${attentionClear ? ' admin-attention--clear' : ''}`}
              aria-labelledby="admin-attention-heading"
            >
              <div className="admin-attention__head">
                <Flag size={16} aria-hidden />
                <h2 id="admin-attention-heading" className="admin-attention__title">Needs attention</h2>
                {attentionClear && (
                  <span className="admin-attention__allclear">
                    <CheckCircle size={16} aria-hidden />
                    All caught up — nothing needs action
                  </span>
                )}
              </div>
              {!attentionClear && (
                <div className="admin-attention__grid">
                  {(pendingApprovalsCount ?? 0) > 0 && (
                    <button
                      type="button"
                      className="admin-attention__card"
                      onClick={() => setActiveTab('approvals')}
                    >
                      <span className="admin-attention__icon"><Clock size={20} aria-hidden /></span>
                      <span className="admin-attention__body">
                        <span className="admin-attention__lead">
                          {pendingApprovalsCount} {pendingApprovalsCount === 1 ? 'approval' : 'approvals'} waiting
                        </span>
                        <span className="admin-attention__sub">Completion reports need review</span>
                        <span className="admin-attention__link">View approvals <ArrowRight size={14} aria-hidden /></span>
                      </span>
                    </button>
                  )}
                  {studiesClosingSoon.length > 0 && (
                    <button
                      type="button"
                      className="admin-attention__card"
                      onClick={() => {
                        if (studiesClosingSoon.length === 1) {
                          navigate(`/admin/opportunities/${studiesClosingSoon[0].id}/edit`);
                        } else {
                          setQuickFilter('closing-soon');
                          setActiveTab('opportunities');
                        }
                      }}
                    >
                      <span className="admin-attention__icon"><Calendar size={20} aria-hidden /></span>
                      <span className="admin-attention__body">
                        <span className="admin-attention__lead">
                          {studiesClosingSoon.length === 1
                            ? '1 study closes soon'
                            : `${studiesClosingSoon.length} studies close soon`}
                        </span>
                        <span className="admin-attention__sub">
                          {studiesClosingSoon.length === 1
                            ? studiesClosingSoon[0].title
                            : 'Recruitment windows ending in the next few days'}
                        </span>
                        <span className="admin-attention__link">
                          {studiesClosingSoon.length === 1 ? 'View study' : 'View studies'} <ArrowRight size={14} aria-hidden />
                        </span>
                      </span>
                    </button>
                  )}
                </div>
              )}
            </section>

            {/* Operational snapshot.
                These numbers are OWNER-SCOPED for a researcher admin - the
                backend filters every query on owner_user_id - and global for a
                superadmin. Same cards, different meaning, and the page used to
                say neither, so a count read as the platform total to the person
                who owned part of it. The scope note keeps that honest.
                "Overdue sessions" from the wireframe is omitted: the frontend
                has no per-session completion flag to compute it from. */}
            {dashboardStats && (
              <section className="admin-snapshot" aria-labelledby="admin-snapshot-heading">
                <div className="admin-section-head">
                  <h2 id="admin-snapshot-heading" className="admin-section-title">Operational snapshot</h2>
                  <span className="stat-scope-note">
                    {user?.role === 'superadmin'
                      ? 'Across every researcher on Cortex'
                      : 'Your studies only'}
                  </span>
                </div>
                <div className="admin-stat-grid mb-3">
                  <div className="stat-card-col">
                    <div className="card border-0 shadow-sm h-100 stat-card admin-stat-card">
                      <div className="card-body stat-card-body">
                        <div className="stat-card-header">
                          <span className="text-uppercase stat-label">Active studies</span>
                          <div className="stat-icon-wrapper">
                            <ClipboardList size={20} className="stat-icon" />
                          </div>
                        </div>
                        <h2 className="mb-0 stat-value">
                          {dashboardStats.published_opportunities + dashboardStats.draft_opportunities}
                        </h2>
                        <small className="stat-subtitle">
                          {dashboardStats.published_opportunities} published · {dashboardStats.draft_opportunities} draft
                        </small>
                      </div>
                    </div>
                  </div>
                  <div className="stat-card-col">
                    <div className="card border-0 shadow-sm h-100 stat-card admin-stat-card">
                      <div className="card-body stat-card-body">
                        <div className="stat-card-header">
                          <span className="text-uppercase stat-label">Participants</span>
                          <div className="stat-icon-wrapper">
                            <Users size={20} className="stat-icon" />
                          </div>
                        </div>
                        <h2 className="mb-0 stat-value">{dashboardStats.total_participants}</h2>
                        <small className="stat-subtitle">People who booked</small>
                      </div>
                    </div>
                  </div>
                  <div className="stat-card-col">
                    <div className="card border-0 shadow-sm h-100 stat-card admin-stat-card">
                      <div className="card-body stat-card-body">
                        <div className="stat-card-header">
                          <span className="text-uppercase stat-label">Sessions this week</span>
                          <div className="stat-icon-wrapper">
                            <CalendarClock size={20} className="stat-icon" />
                          </div>
                        </div>
                        <h2 className="mb-0 stat-value">{sessionsThisWeek.total}</h2>
                        <small className="stat-subtitle">
                          {sessionsThisWeek.upcoming} upcoming · {sessionsThisWeek.completed} completed
                        </small>
                      </div>
                    </div>
                  </div>
                  <div className="stat-card-col">
                    <div className="card border-0 shadow-sm h-100 stat-card admin-stat-card">
                      <div className="card-body stat-card-body">
                        <div className="stat-card-header">
                          <span className="text-uppercase stat-label">Open slots</span>
                          <div className="stat-icon-wrapper">
                            <Clock size={20} className="stat-icon" />
                          </div>
                        </div>
                        <h2 className="mb-0 stat-value">{dashboardStats.available_slots}</h2>
                        <small className="stat-subtitle">Across all published studies</small>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* Recent bookings moved into the Bookings tab below - it was
                over-prominent above the work area for often-empty data. */}

            {/* Research Studies / Approvals / Feedback / Bookings in one rounded card,
                matching the Recent bookings treatment - tabs at the top edge,
                padded content below, spanning the same width. */}
            <div className="row mb-3">
              <div className="col-12">
                <div className="card border-0 shadow-sm admin-tabs-card">
            <div className="admin-tabs-container tabs-container">
              <ul className="nav nav-tabs nav-fill" role="tablist" style={{ border: 'none', margin: 0 }}>
                <li className="nav-item" role="presentation">
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
                    {opportunities.length > 0 && (
                      <span className="admin-tab-count">{opportunities.length}</span>
                    )}
                  </button>
                </li>
                <li className="nav-item" role="presentation">
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
                    {(pendingApprovalsCount ?? 0) > 0 && (
                      <span className="admin-tab-count admin-tab-count--alert">{pendingApprovalsCount}</span>
                    )}
                  </button>
                </li>
                {/* Feedback tab - all admins (researcher_admin and superadmin) */}
                <li className="nav-item" role="presentation">
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
                    {feedbackCount && feedbackCount.count > 0 && (
                      <span className="admin-tab-count">
                        {feedbackCount.count}{feedbackCount.hasMore ? '+' : ''}
                      </span>
                    )}
                  </button>
                </li>
                {/* Bookings tab - was the prominent "Recent bookings" card */}
                <li className="nav-item" role="presentation">
                  <button
                    className={`custom-tab-button ${activeTab === 'bookings' ? 'active' : ''}`}
                    onClick={() => setActiveTab('bookings')}
                    role="tab"
                    aria-selected={activeTab === 'bookings'}
                    aria-controls="bookings-tab"
                    tabIndex={0}
                  >
                    <Calendar size={16} className="me-2" />
                    <span>Bookings</span>
                    {dashboardStats && dashboardStats.total_bookings > 0 && (
                      <span className="admin-tab-count">{dashboardStats.total_bookings}</span>
                    )}
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
                        {/* Every type a researcher can create, named the way
                            every other surface names them. `unmoderated` was
                            missing outright, so recorded studies - the whole
                            reason the type exists - could not be filtered for. */}
                        <option value="">All Types</option>
                        <option value="test">Live session</option>
                        <option value="interview">Interview</option>
                        <option value="unmoderated">Recorded session</option>
                        <option value="poll">Quick poll</option>
                        <option value="survey">Survey</option>
                        <option value="question">One question</option>
                      </select>
                    </div>
                  </div>

                  {/* Quick filters - client-side chips over the loaded list. Each
                      reads only real fields; "Needs recruitment" is open-slot
                      capacity, NOT a participant target (which does not exist). */}
                  <div className="admin-quick-filters">
                    <span className="admin-quick-filters__label">Quick filters</span>
                    {([
                      { key: 'needs-recruitment', label: 'Needs recruitment' },
                      { key: 'draft', label: 'Draft' },
                      { key: 'closing-soon', label: 'Closing soon' },
                      { key: 'fully-booked', label: 'Fully booked' },
                    ] as { key: QuickFilter; label: string }[]).map((chip) => (
                      <button
                        key={chip.key}
                        type="button"
                        className={`admin-chip ${quickFilter === chip.key ? 'admin-chip--active' : ''}`}
                        aria-pressed={quickFilter === chip.key}
                        onClick={() => toggleQuickFilter(chip.key)}
                      >
                        {chip.label}
                      </button>
                    ))}
                    {hasActiveFilters && (
                      <button
                        type="button"
                        className="admin-clear-filters"
                        onClick={clearAllFilters}
                      >
                        Clear filters
                      </button>
                    )}
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
                        {hasActiveFilters ? 'No research studies match your search or filters.' : 'Create your first research study to get started.'}
                      </p>
                      {hasActiveFilters ? (
                        <button className="btn btn-outline-secondary" onClick={clearAllFilters}>
                          Clear filters
                        </button>
                      ) : (
                        <button
                          className="btn btn-primary"
                          onClick={() => navigate('/admin/opportunities/new')}
                        >
                          Create Research Study
                        </button>
                      )}
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
                            <th className="admin-th col-title" scope="col" aria-sort={ariaSortFor('title')}>
                              <button type="button" className="admin-th-sort" onClick={() => handleSort('title')}>
                                Study
                                <span className="admin-th-sort-caret" aria-hidden="true">{sortField === 'title' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</span>
                              </button>
                            </th>
                            <th className="admin-th col-type" scope="col" aria-sort={ariaSortFor('type')}>
                              <button type="button" className="admin-th-sort" onClick={() => handleSort('type')}>
                                Type
                                <span className="admin-th-sort-caret" aria-hidden="true">{sortField === 'type' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</span>
                              </button>
                            </th>
                            <th className="admin-th col-status" scope="col" aria-sort={ariaSortFor('status')}>
                              <button type="button" className="admin-th-sort" onClick={() => handleSort('status')}>
                                Status
                                <span className="admin-th-sort-caret" aria-hidden="true">{sortField === 'status' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</span>
                              </button>
                            </th>
                            {/* Recruitment replaces the old "Booked" column - same booked/capacity
                                figure the "Booked" cell showed, now with the percentage the
                                progress bar was already drawing. There is deliberately no
                                Capacity column beside it: that duplicated the denominator. */}
                            <th className="admin-th col-recruitment" scope="col">Recruitment</th>
                            <th className="admin-th col-metric col-numeric" scope="col">Clicks</th>
                            <th className="admin-th col-next" scope="col">Next session / deadline</th>
                            <th className="admin-th col-date" scope="col" aria-sort={ariaSortFor('created_at')}>
                              <button type="button" className="admin-th-sort" onClick={() => handleSort('created_at')}>
                                Created
                                <span className="admin-th-sort-caret" aria-hidden="true">{sortField === 'created_at' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</span>
                              </button>
                            </th>
                            <th className="admin-th col-actions" scope="col">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedOpportunities.map((opportunity) => {
                            const recruitment = getRecruitment(opportunity);
                            const milestone = getNextMilestone(opportunity, now);
                            return (
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
                              /* No role="presentation" here: the row is focusable and
                                 carries an aria-label, and axe reports the combination as
                                 presentation-role-conflict. It is a real row, so it keeps
                                 the implicit row role. */
                              aria-label={`Study: ${opportunity.title}`}
                              onFocus={(e) => {
                                // Prevent focus on table rows
                                e.currentTarget.blur();
                              }}
                            >
                              <td className="col-title" data-label="Study">
                                <div>
                                  <strong className="row-title">{opportunity.title}</strong>
                                  <small className="row-desc">{opportunity.purpose_one_liner}</small>
                                </div>
                              </td>
                              <td className="col-type" data-label="Type">
                                <span className={`${getTypeBadgeClass(opportunity.type)} badge--${opportunity.type}`}>
                                  {getAdminTypeLabel(opportunity.type)}
                                </span>
                              </td>
                              <td className="col-status" data-label="Status">
                                <span className={`admin-study-status admin-study-status--${opportunity.status}`}>
                                  {getDisplayStatus(opportunity.status)}
                                </span>
                                {opportunity.status === 'closed' && (
                                  <span className="badge bg-dark ms-1">Auto-closed</span>
                                )}
                              </td>
                              {/* Recruitment: booked / capacity across the study's sessions, with
                                  the same progress bar the old Booked cell drew plus the percentage.
                                  A study with no sessions (poll, survey, one-question) has no slots
                                  to recruit into, so it shows a dash rather than "0 / 0". */}
                              <td className="col-recruitment" data-label="Recruitment">
                                {recruitment ? (
                                  <div className="admin-recruitment">
                                    <div className="admin-recruitment__top">
                                      <span className="admin-recruitment__ratio">{recruitment.booked} / {recruitment.capacity}</span>
                                      <span className="admin-recruitment__pct">{recruitment.pct}%</span>
                                    </div>
                                    <div className="progress-mini progress-mini--block">
                                      <div className="progress-mini__fill" style={{ width: `${recruitment.pct}%` }} />
                                    </div>
                                  </div>
                                ) : (
                                  <span className="admin-cell-empty">–</span>
                                )}
                              </td>
                              <td className="col-metric col-numeric" data-label="Clicks">
                                {opportunity.clicks_total ?? 0}
                              </td>
                              {/* Next session / deadline: the soonest upcoming slot, else a future
                                  closing time, else "Completed" once every slot has passed. All
                                  from real fields - no invented session ordinal. */}
                              <td className="col-next" data-label="Next / deadline">
                                {milestone ? (
                                  <div className="admin-next">
                                    <span className="admin-next__date">
                                      {formatStudyDate(milestone.date.toISOString())}
                                      {milestone.kind === 'session' && (
                                        <span className="admin-next__time">{formatClockTime(milestone.date.toISOString())}</span>
                                      )}
                                    </span>
                                    <span className={`admin-next__note admin-next__note--${milestone.kind}`}>
                                      {milestone.kind === 'completed'
                                        ? 'Completed'
                                        : milestone.kind === 'deadline'
                                          ? `Closes · ${getTimeRemainingUntil(milestone.date).text ?? 'soon'}`
                                          : relativeDayLabel(milestone.date, now) ?? ''}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="admin-cell-empty">–</span>
                                )}
                              </td>
                              <td className="col-date" data-label="Created">
                                <small className="admin-cell-metadata">
                                  {formatStudyDate(opportunity.created_at)}
                                </small>
                              </td>
                              <td className="col-actions" data-label="Actions">
                                <div className="admin-action-group">
                                  <button
                                    type="button"
                                    className="btn btn-outline-secondary btn-sm admin-action-primary"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (opportunity.status === 'draft') {
                                        navigate(`/admin/opportunities/${opportunity.id}/edit`);
                                      } else {
                                        navigate(`/opportunities/${opportunity.id}`);
                                      }
                                    }}
                                    onMouseDown={(e) => e.stopPropagation()}
                                  >
                                    {opportunity.status === 'draft' ? 'Edit' : 'View'}
                                  </button>
                                <Dropdown
                                  menu
                                  align="end"
                                  menuClassName="admin-action-dropdown admin-action-dropdown-menu"
                                  trigger={
                                    <button
                                      className="btn btn-outline-secondary btn-sm admin-action-btn admin-action-btn-kebab"
                                      type="button"
                                      // The row is clickable; stop the kebab's own
                                      // click reaching it (belt-and-braces beside the
                                      // row's interactive-target guard).
                                      onClick={(e) => e.stopPropagation()}
                                      onMouseDown={(e) => e.stopPropagation()}
                                      aria-label={`Actions for ${opportunity.title}`}
                                    >
                                      <span aria-hidden="true">⋮</span>
                                    </button>
                                  }
                                >
                                  <DropdownItem onClick={() => navigate(`/opportunities/${opportunity.id}`)}>
                                    View
                                  </DropdownItem>
                                  <DropdownItem onClick={() => navigate(`/admin/opportunities/${opportunity.id}/edit`)}>
                                    Edit
                                  </DropdownItem>
                                  <DropdownItem onClick={() => handleDuplicate(opportunity.id)}>
                                    Copy
                                  </DropdownItem>
                                  <DropdownDivider />
                                  {/* Analytics for EVERY study type. The page always renders
                                      an Overview (views/clicks), and the moderated types (test,
                                      interview) reach their booked-participant roster only
                                      through here - gating this to poll/survey/unmoderated left
                                      that roster unreachable. Audit rows a04-row-actions-menu,
                                      a64-analytics-live-session-participants. */}
                                  <DropdownItem onClick={() => navigate(`/admin/opportunities/${opportunity.id}/analytics`)}>
                                    Analytics
                                  </DropdownItem>
                                  <DropdownDivider />
                                  <DropdownItem className="text-danger" onClick={() => handleDelete(opportunity.id, opportunity.title)}>
                                    Delete
                                  </DropdownItem>
                                </Dropdown>
                                </div>
                              </td>
                            </tr>
                            );
                          })}
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

                {/* Bookings Tab - the recent bookings list, with session times */}
                <div
                  className={`tab-pane fade ${activeTab === 'bookings' ? 'show active' : ''}`}
                  id="bookings-tab"
                  role="tabpanel"
                  aria-labelledby="bookings-tab-button"
                >
                  <div className="admin-bookings-head">
                    <h2 className="admin-bookings-title">Recent bookings</h2>
                    <button
                      type="button"
                      className="btn btn-outline-secondary btn-sm"
                      onClick={() => exportBookingsCsv()}
                      aria-label="Export all bookings as CSV"
                    >
                      <Download size={16} className="me-1" />
                      Export CSV
                    </button>
                  </div>
                  <div className="table-responsive">
                    <table className="table table-hover mb-0 admin-cards-phone">
                      {/*
                        State the truncation (register #16), as a <caption> so a
                        screen reader meets it ON ENTERING the table rather than
                        after leaving it - a <p> below is read too late to stop
                        the 15 rows being taken as the whole list. caption-side
                        keeps it visually below. Shown only when rows are
                        actually withheld: the row count is measured (the rows
                        rendered, not a literal 15, so it stays honest if the
                        server cap moves) and guarded > 0, so a stale response
                        with no array cannot render "the  most recent".
                      */}
                      {(dashboardStats?.recent_bookings?.length ?? 0) > 0 &&
                        (dashboardStats?.total_bookings ?? 0) > (dashboardStats?.recent_bookings?.length ?? 0) && (
                        <caption
                          className="admin-bookings-truncation text-muted"
                          style={{ captionSide: 'bottom', paddingTop: '0.75rem' }}
                        >
                          Showing the {dashboardStats?.recent_bookings?.length} most recent of{' '}
                          {dashboardStats?.total_bookings} bookings. Export CSV for the full list.
                        </caption>
                      )}
                      <thead>
                        {/* Named columns. This table shares `.admin-dashboard` with the
                            Research Studies table, so anything addressed by POSITION
                            lands on whichever table has a cell there - which is how this
                            one inherited the other's Type-column geometry. */}
                        <tr>
                          <th scope="col" className="col-recent-session">Date &amp; time</th>
                          <th scope="col" className="col-recent-study">Study</th>
                          <th scope="col" className="col-recent-participant">Participant</th>
                          <th scope="col" className="col-recent-status">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(dashboardStats?.recent_bookings || []).length === 0 ? (
                          <tr>
                            <td colSpan={4} className="text-muted text-center py-4">No recent bookings</td>
                          </tr>
                        ) : (dashboardStats?.recent_bookings || []).map((b) => (
                          <tr key={b.id}>
                            {/* The zone is per ROW, not a column header. A header computed once at page
                                load states the offset NOW, while each row is formatted at its own
                                instant - so a December session listed in August rendered under a
                                GMT+1 header while actually being GMT+0. Recent bookings are ordered
                                by created_at, so rows routinely straddle a DST boundary. */}
                            {/* Two units, not one string. Above 992px this table is
                                `table-layout: fixed` with `overflow-x: hidden`, so a cell that
                                cannot wrap does not widen its column - it draws over the next one.
                                The date and its time stay together, and the zone drops to a second
                                line when tight. A time and its zone never split. */}
                            <td className="admin-recent-session col-recent-session" data-label="Date & time">
                              {b.session_start ? (
                                <>
                                  <span className="admin-recent-session-date">
                                    {formatStudyDate(b.session_start)} ·
                                  </span>{' '}
                                  <span className="admin-recent-session-time">
                                    {formatClockTime(b.session_start)}{' '}
                                    <span className="admin-recent-session-zone">
                                      {formatTimeZoneLabel(b.session_start)}
                                    </span>
                                  </span>
                                </>
                              ) : '—'}
                            </td>
                            <td className="col-recent-study" data-label="Study">
                              <button
                                type="button"
                                className="btn btn-link p-0 text-start text-decoration-none admin-recent-study-link"
                                onClick={() => navigate(`/opportunities/${b.opportunity_id}`)}
                              >
                                {b.opportunity_title}
                              </button>
                            </td>
                            <td className="col-recent-participant" data-label="Participant">
                              <span title={b.participant_email}>{b.participant_name || b.participant_email || '—'}</span>
                            </td>
                            <td className="col-recent-status" data-label="Status">
                              <span className={`admin-status-pill ${b.status === 'booked' ? 'admin-status-pill--confirmed' : 'admin-status-pill--pending'}`}>
                                {b.status === 'booked' ? 'Confirmed' : b.status === 'pending' ? 'Pending' : b.status}
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
        // DA-24: the "cannot be undone" line above never said what else it
        // takes with it. The backend hard-deletes the opportunity row and the
        // database's ON DELETE CASCADE chain (backend/src/db/migrate.ts)
        // takes its sessions, its bookings on those sessions, and the
        // recordings/transcripts attached to those bookings, plus its click
        // and lifecycle analytics rows. Only that chain is named here -
        // FirstHand's native poll/survey answers live in a separate database
        // with no enforced FK to this row, so they are NOT destroyed by this
        // delete and must not be listed as if they were.
        renderCustomContent={() => (
          <p className="mb-0 mt-3 confirmation-modal-collateral" style={{ fontSize: '0.9rem' }}>
            This will also permanently delete its scheduled sessions and any
            bookings against them, the recordings and transcripts attached to
            those bookings, and the analytics data recorded for this study.
          </p>
        )}
      />
      </div>
    </div>
  );
};

export default Admin;
