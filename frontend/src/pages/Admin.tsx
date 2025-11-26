import React, { useState, useEffect, useRef } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getOpportunities, deleteOpportunity, duplicateOpportunity, getDashboardStats, DashboardStats } from '../api/client';
import { Opportunity } from '../api/types';
import { formatOpportunityType, getTypeBadgeClass } from '../utils/opportunityUtils';
import PendingApprovals from '../components/PendingApprovals';
import AdminFeedback from '../components/AdminFeedback';
import ErrorState from '../components/ErrorState';
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
  const [activeTab, setActiveTab] = useState<'opportunities' | 'approvals' | 'feedback'>('opportunities');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [sortField, setSortField] = useState<'title' | 'created_at' | 'type' | 'status'>('created_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  
  
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
    if (user?.role === 'researcher_admin' || user?.role === 'superadmin') {
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

  if (user.role !== 'researcher_admin' && user.role !== 'superadmin') {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="container-fluid" style={{ minHeight: '100vh', padding: '0.5rem 0.75rem', backgroundColor: '#0A091A', maxWidth: '100%', width: '100%' }}>
      <style>
        {`
          /* Make dashboard full width */
          .admin-dashboard {
            max-width: 100% !important;
            width: 100% !important;
          }
          
          /* On large screens, allow dashboard to use more width by reducing padding */
          @media (min-width: 1400px) {
            .admin-dashboard {
              max-width: 100% !important;
            }
            .admin-dashboard .card {
              max-width: 100% !important;
            }
            .admin-dashboard .card-body {
              padding-left: 1.5rem !important;
              padding-right: 1.5rem !important;
            }
          }
          
          @media (min-width: 1920px) {
            .admin-dashboard .card-body {
              padding-left: 2rem !important;
              padding-right: 2rem !important;
            }
          }
          
          @media (min-width: 2560px) {
            .admin-dashboard .card-body {
              padding-left: 2.5rem !important;
              padding-right: 2.5rem !important;
            }
          }
          
          /* Prevent text breaking in dashboard */
          .admin-dashboard h1,
          .admin-dashboard h2,
          .admin-dashboard h3 {
            word-break: normal !important;
            overflow-wrap: normal !important;
          }
          
          /* Table headers - allow wrapping and scale font */
          .admin-dashboard table thead th {
            white-space: normal !important;
            word-break: break-word !important;
            line-height: 1.3 !important;
            font-size: 0.8rem !important;
            padding: 10px 6px !important;
            text-align: center !important;
            hyphens: auto !important;
          }
          
          /* Status and Clicks columns - prevent breaking */
          .admin-dashboard table thead th:nth-child(3),
          .admin-dashboard table thead th:nth-child(4) {
            white-space: nowrap !important;
            word-break: normal !important;
          }
          
          /* Title column - left aligned, slightly larger */
          .admin-dashboard table thead th:nth-child(1) {
            text-align: left !important;
            font-size: 0.85rem !important;
            padding: 10px 12px !important;
          }
          
          /* Longer headers - smaller font to fit better */
          /* Longer headers - smaller font to fit better */
          .admin-dashboard table thead th:nth-child(5),
          .admin-dashboard table thead th:nth-child(7) {
            font-size: 0.75rem !important;
          }
          
          /* On larger screens, slightly increase font */
          @media (min-width: 1200px) {
            .admin-dashboard table thead th {
              font-size: 0.85rem !important;
            }
            .admin-dashboard table thead th:nth-child(1) {
              font-size: 0.9rem !important;
            }
            .admin-dashboard table thead th:nth-child(5),
            .admin-dashboard table thead th:nth-child(7) {
              font-size: 0.8rem !important;
            }
          }
          
          /* On very large screens, allow more space */
          @media (min-width: 1400px) {
            .admin-dashboard table thead th {
              font-size: 0.9rem !important;
              padding: 12px 8px !important;
            }
            .admin-dashboard table thead th:nth-child(1) {
              font-size: 0.95rem !important;
            }
          }
          
          /* Prevent table cell content from overlapping */
          .admin-dashboard table tbody td {
            overflow: visible !important;
            max-width: 100% !important;
            word-wrap: break-word !important;
          }
          
          /* Ensure all interactive elements in table rows stop event propagation */
          .admin-dashboard table tbody tr button,
          .admin-dashboard table tbody tr a,
          .admin-dashboard table tbody tr input,
          .admin-dashboard table tbody tr select,
          .admin-dashboard table tbody tr textarea,
          .admin-dashboard table tbody tr [role="button"],
          .admin-dashboard table tbody tr .dropdown,
          .admin-dashboard table tbody tr .dropdown-menu,
          .admin-dashboard table tbody tr .dropdown-item {
            pointer-events: auto !important;
          }
          
          /* Prevent table rows from being keyboard focusable */
          .admin-dashboard table tbody tr {
            outline: none !important;
            user-select: none !important;
          }
          
          .admin-dashboard table tbody tr:focus {
            outline: none !important;
          }
          
          .admin-dashboard table tbody tr:focus-visible {
            outline: none !important;
          }
          
          /* Completely disable keyboard interaction on table rows */
          .admin-dashboard table tbody tr {
            pointer-events: auto !important;
          }
          
          .admin-dashboard table tbody tr * {
            pointer-events: auto !important;
          }
          
          /* Ensure badges don't get cut off and don't overlap */
          .admin-dashboard table tbody td .badge {
            white-space: nowrap !important;
            overflow: visible !important;
            display: inline-block !important;
            max-width: 100% !important;
            margin: 0 !important;
            vertical-align: middle !important;
          }
          
          /* Prevent status and clicks columns from overlapping */
          .admin-dashboard table tbody td:nth-child(3),
          .admin-dashboard table tbody td:nth-child(4) {
            white-space: nowrap !important;
            overflow: visible !important;
            padding-left: 8px !important;
            padding-right: 8px !important;
          }
          
          /* Ensure type badges show full text without truncation */
          .admin-dashboard table tbody td:nth-child(2) {
            overflow: visible !important;
          }
          
          .admin-dashboard table tbody td:nth-child(2) .badge {
            white-space: nowrap !important;
            overflow: visible !important;
            text-overflow: clip !important;
            max-width: none !important;
          }
          
          /* Ensure status column only shows status, no extra numbers */
          .admin-dashboard table tbody td:nth-child(3) {
            isolation: isolate !important;
          }
          
          .admin-dashboard table tbody td:nth-child(3) > * {
            display: inline-block !important;
            margin-right: 0.25rem !important;
          }
          
          /* Responsive container padding - reduced on larger screens for more table space */
          @media (max-width: 575px) {
            .admin-dashboard .container-fluid {
              padding: 0.5rem 0.5rem !important;
            }
            .admin-dashboard .col-12 {
              padding-left: 0.25rem !important;
              padding-right: 0.25rem !important;
            }
          }
          @media (min-width: 576px) {
            .admin-dashboard .container-fluid {
              padding: 0.75rem 1rem !important;
            }
          }
          @media (min-width: 768px) {
            .admin-dashboard .container-fluid {
              padding: 0.75rem 1rem !important;
            }
          }
          @media (min-width: 1200px) {
            .admin-dashboard .container-fluid {
              padding: 0.5rem 1rem !important;
            }
          }
          @media (min-width: 1400px) {
            .admin-dashboard .container-fluid {
              padding: 0.5rem 1rem !important;
            }
          }
          @media (min-width: 1600px) {
            .admin-dashboard .container-fluid {
              padding: 0.5rem 0.75rem !important;
            }
          }
          @media (min-width: 1920px) {
            .admin-dashboard .container-fluid {
              padding: 0.5rem 0.5rem !important;
            }
          }
          @media (min-width: 2560px) {
            .admin-dashboard .container-fluid {
              padding: 0.5rem 1rem !important;
            }
          }
          
          /* Header section responsiveness */
          .admin-dashboard .card-header {
            overflow: visible !important;
            min-width: 0 !important;
          }
          
          .admin-dashboard .card-header > .d-flex {
            overflow: visible !important;
            min-width: 0 !important;
            flex-wrap: wrap !important;
          }
          
          .admin-dashboard .card-header .btn {
            overflow: visible !important;
            text-overflow: clip !important;
          }
          
          @media (max-width: 575px) {
            .admin-dashboard .card-header {
              padding: 1rem 0.75rem !important;
              margin-bottom: 1rem !important;
              overflow: visible !important;
            }
            .admin-dashboard .card-header h1 {
              font-size: 1.25rem !important;
              white-space: normal !important;
              word-break: break-word !important;
              margin-right: 0 !important;
              margin-bottom: 0.75rem !important;
              overflow: visible !important;
            }
            .admin-dashboard .card-header .d-flex.flex-column {
              gap: 0.75rem !important;
              overflow: visible !important;
            }
            .admin-dashboard .card-header .btn {
              font-size: 0.75rem !important;
              padding: 0.4rem 0.6rem !important;
              overflow: visible !important;
            }
            /* Keep buttons right-aligned on mobile */
            .admin-dashboard .card-header > div > div:last-child {
              align-self: flex-end !important;
              flex-direction: row !important;
              gap: 0.5rem !important;
            }
          }
          
          @media (min-width: 576px) and (max-width: 991px) {
            .admin-dashboard .card-header h1 {
              font-size: clamp(1.25rem, 3vw, 1.5rem) !important;
            }
            .admin-dashboard .card-header .btn {
              font-size: 0.9rem !important;
              padding: 0.5rem 0.875rem !important;
            }
            /* Keep buttons right-aligned on tablet */
            .admin-dashboard .card-header > div > div:last-child {
              align-self: flex-end !important;
            }
          }
          
          /* Filter section responsiveness */
          @media (max-width: 575px) {
            .admin-dashboard .row.mb-4.g-3 {
              margin-bottom: 1rem !important;
            }
            .admin-dashboard .row.mb-4.g-3 > div {
              margin-bottom: 0.75rem !important;
            }
            .admin-dashboard .form-label {
              font-size: 0.85rem !important;
              margin-bottom: 0.5rem !important;
            }
            .admin-dashboard .form-control,
            .admin-dashboard .form-select {
              font-size: 1rem !important;
              padding: 0.625rem 0.875rem !important;
              min-height: 2.5rem !important;
            }
          }
          
          @media (min-width: 576px) and (max-width: 767px) {
            .admin-dashboard .form-control,
            .admin-dashboard .form-select {
              font-size: 1rem !important;
            }
          }
          
          /* Tab buttons responsiveness */
          @media (max-width: 575px) {
            .admin-dashboard .nav-tabs {
              flex-direction: column !important;
              gap: 0.5rem !important;
            }
            .admin-dashboard .nav-item {
              width: 100% !important;
            }
            .admin-dashboard .custom-tab-button {
              width: 100% !important;
              padding: 0.625rem 0.875rem !important;
              font-size: 0.875rem !important;
            }
          }
          
          /* Table dropdown menu responsiveness */
          @media (max-width: 575px) {
            .admin-dashboard .dropdown-menu {
              position: fixed !important;
              top: auto !important;
              left: 50% !important;
              transform: translateX(-50%) !important;
              right: auto !important;
              min-width: 200px !important;
              max-width: 90vw !important;
              margin-top: 0.5rem !important;
            }
          }
          
          /* Ensure no horizontal overflow */
          .admin-dashboard {
            overflow-x: hidden !important;
            max-width: 100vw !important;
          }
          
          .admin-dashboard .card {
            max-width: 100% !important;
            overflow-x: hidden !important;
          }
          
          /* Force center alignment for all columns except Title (column 1) */
          .admin-dashboard table thead th:not(:first-child) {
            text-align: center !important;
          }
          
          .admin-dashboard table tbody td:not(:first-child) {
            text-align: center !important;
          }
          
          .admin-dashboard table thead th:first-child,
          .admin-dashboard table tbody td:first-child {
            text-align: left !important;
          }
          
          /* Ensure badge/lozenge content displays inline and centered within cells */
          .admin-dashboard table tbody td:not(:first-child) {
            vertical-align: middle !important;
          }
          
          .admin-dashboard table tbody td:not(:first-child) > span,
          .admin-dashboard table tbody td:not(:first-child) > small,
          .admin-dashboard table tbody td:not(:first-child) > div:not(.dropdown) {
            display: inline-block !important;
            text-align: center !important;
          }
          
          /* Ensure lozenges and badges are centered */
          .admin-dashboard table tbody td .lozenge,
          .admin-dashboard table tbody td .badge {
            margin: 0 auto !important;
          }
          
          /* Prevent text overflow in title column */
          @media (max-width: 991px) {
            .admin-dashboard table tbody td:nth-child(1) {
              max-width: 100% !important;
              word-break: break-word !important;
              overflow-wrap: break-word !important;
            }
            .admin-dashboard table tbody td:nth-child(1) strong {
              display: block !important;
              word-break: break-word !important;
            }
            .admin-dashboard table tbody td:nth-child(1) small {
              display: block !important;
              word-break: break-word !important;
              margin-top: 0.25rem !important;
            }
          }
          
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
          
          /* Mobile tab button adjustments */
          @media (max-width: 576px) {
            .custom-tab-button {
              padding: 0.5rem 0.75rem !important;
              font-size: 0.9rem !important;
            }
            .custom-tab-button i {
              display: none !important;
            }
          }
          
          /* Scale down stat-card content on smaller screens */
          @media (max-width: 991px) {
            .stat-card .card-body {
              padding: 0.2rem 0.5rem 0.2rem !important;
            }
            .stat-card .card-body > div:first-child > span {
              font-size: 0.65rem !important;
            }
            .stat-card .card-body > div:first-child > i {
              font-size: 1.5rem !important;
            }
            .stat-card .card-body h2 {
              font-size: 2rem !important;
            }
            .stat-card .card-body small {
              font-size: 0.6rem !important;
            }
          }
          
          @media (max-width: 767px) {
            .stat-card .card-body {
              padding: 0.15rem 0.35rem 0.15rem !important;
            }
            .stat-card .card-body > div:first-child > span {
              font-size: 0.55rem !important;
              letter-spacing: 0 !important;
            }
            .stat-card .card-body > div:first-child > i {
              font-size: 1.2rem !important;
            }
            .stat-card .card-body h2 {
              font-size: 1.5rem !important;
            }
            .stat-card .card-body small {
              font-size: 0.5rem !important;
            }
          }
          
          /* Mobile: 2x2 grid for stat cards */
          @media (max-width: 575px) {
            .admin-dashboard .row.mb-3.g-2 {
              display: flex !important;
              flex-wrap: wrap !important;
            }
            .admin-dashboard .row.mb-3.g-2 > div {
              flex: 0 0 50% !important;
              max-width: 50% !important;
              width: 50% !important;
            }
            .stat-card {
              border-radius: 6px !important;
            }
            .stat-card .card-body {
              padding: 0.2rem 0.35rem 0.15rem !important;
            }
            .stat-card .card-body > div:first-child > span {
              font-size: 0.5rem !important;
            }
            .stat-card .card-body > div:first-child > i {
              font-size: 1rem !important;
            }
            .stat-card .card-body h2 {
              font-size: 1.25rem !important;
            }
            .stat-card .card-body small {
              font-size: 0.45rem !important;
            }
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
            position: relative !important;
            overflow: visible !important;
          }
          
          /* Ensure proper spacing between table cells */
          .admin-dashboard table.table-hover tbody td {
            padding-left: 8px !important;
            padding-right: 8px !important;
          }
          
          /* Prevent content from spilling into adjacent cells */
          .admin-dashboard table.table-hover tbody td > * {
            max-width: 100% !important;
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
          
          /* Status badges - Momentum Design System with proper padding */
          .admin-dashboard .badge.status-published,
          .admin-dashboard .badge.status-draft,
          .admin-dashboard .badge.status-closed {
            border-radius: var(--tag-radius) !important;
            padding: 0.4rem 0.75rem !important;
            font-size: 0.75rem !important;
            font-weight: 600 !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            transition: filter var(--transition-card);
            white-space: nowrap !important;
            line-height: 1.2 !important;
            min-width: fit-content !important;
            box-sizing: border-box !important;
          }
          
          /* Type badges (lozenge) - ensure proper fit with adequate padding */
          .admin-dashboard table tbody td .lozenge,
          .admin-dashboard table tbody td span.lozenge {
            padding: 0.5rem 0.9rem !important;
            font-size: 0.75rem !important;
            font-weight: 600 !important;
            border-radius: var(--tag-radius) !important;
            white-space: nowrap !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            line-height: 1.2 !important;
            min-width: fit-content !important;
            box-sizing: border-box !important;
            width: auto !important;
            height: auto !important;
            margin: 0 !important;
          }
          
          /* Ensure all lozenge variants have proper padding and background */
          .admin-dashboard table tbody td .lozenge-survey,
          .admin-dashboard table tbody td span.lozenge-survey,
          .admin-dashboard table tbody td .lozenge-poll,
          .admin-dashboard table tbody td span.lozenge-poll,
          .admin-dashboard table tbody td .lozenge-interview,
          .admin-dashboard table tbody td span.lozenge-interview,
          .admin-dashboard table tbody td .lozenge-usertest,
          .admin-dashboard table tbody td span.lozenge-usertest,
          .admin-dashboard table tbody td .lozenge-question,
          .admin-dashboard table tbody td span.lozenge-question,
          .admin-dashboard table tbody td .lozenge-unmoderated,
          .admin-dashboard table tbody td span.lozenge-unmoderated {
            padding: 0.5rem 0.9rem !important;
            font-size: 0.75rem !important;
            font-weight: 600 !important;
            line-height: 1.2 !important;
            box-sizing: border-box !important;
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
          
          /* Tab content area styling - no horizontal padding, children handle their own */
          .admin-dashboard .tab-content {
            background-color: transparent !important;
            padding-top: clamp(1rem, 2vw, 1.5rem) !important;
            padding-bottom: clamp(1rem, 2vw, 1.5rem) !important;
            padding-left: 0 !important;
            padding-right: 0 !important;
          }
          
          /* Table alignment - children use same padding as tabs */
          .admin-dashboard .table-responsive {
            width: 100% !important;
          }
          
          @media (max-width: 575px) {
            .admin-dashboard .tab-content {
              padding-top: 0.75rem !important;
              padding-bottom: 0.75rem !important;
              padding-left: 0 !important;
              padding-right: 0 !important;
            }
          }
          
          /* Ensure table uses full width and handles overflow properly */
          .admin-dashboard .table-responsive {
            width: 100% !important;
            max-width: 100% !important;
            overflow-y: visible;
            -webkit-overflow-scrolling: touch;
            box-sizing: border-box !important;
          }
          
          /* Table alignment - ensure it matches tabs outer edges */
          .admin-dashboard .table-responsive table {
            width: 100% !important;
            margin: 0 !important;
          }
          
          /* Prevent horizontal scroll on desktop when table fits */
          @media (min-width: 992px) {
            .admin-dashboard .table-responsive {
              overflow-x: hidden;
            }
          }
          
          /* Allow horizontal scroll on smaller screens */
          @media (max-width: 991px) {
            .admin-dashboard .table-responsive {
              overflow-x: auto;
              overflow-y: visible;
            }
          }
          
          /* Ensure table doesn't exceed container width */
          .admin-dashboard .table-responsive table {
            max-width: 100% !important;
            table-layout: auto !important;
          }
          
          @media (min-width: 992px) {
            .admin-dashboard .table-responsive table {
              table-layout: fixed !important;
            }
          }
          
          .admin-dashboard table.table-hover {
            width: 100% !important;
            max-width: 100% !important;
            margin-bottom: 0;
          }
          
          /* On larger screens, use fixed layout for better control */
          @media (min-width: 992px) {
            .admin-dashboard table.table-hover {
              table-layout: fixed;
            }
          }
          
          /* Prevent table from breaking layout */
          .admin-dashboard .table-responsive table {
            border-collapse: separate;
            border-spacing: 0;
          }
          
          /* Responsive card adjustments */
          @media (max-width: 576px) {
            .admin-dashboard .card {
              border-radius: 12px !important;
              margin: 0 !important;
              padding: 0.75rem !important;
            }
            .admin-dashboard .card-header h1 {
              font-size: 1.5rem !important;
            }
          }
          
          /* Ensure card doesn't exceed viewport */
          .admin-dashboard .card {
            box-sizing: border-box !important;
            width: 100% !important;
            max-width: 100% !important;
            overflow-x: hidden !important;
          }
          
          /* Very large screens - prevent content from being too wide */
          @media (min-width: 2560px) {
            .admin-dashboard {
              max-width: 2560px !important;
              margin: 0 auto !important;
            }
          }
          
          /* Summary Cards - Consistent styling and alignment */
          .admin-dashboard .row.mb-4 .card {
            min-height: 120px;
            display: flex;
            flex-direction: column;
          }
          
          .admin-dashboard .row.mb-4 .card-body {
            flex: 1;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
          }
          
          .admin-dashboard .row.mb-4 .card-body > .d-flex {
            flex: 1;
            align-items: flex-start;
          }
          
          .admin-dashboard .row.mb-4 .card-body h6 {
            line-height: 1.2;
            margin-bottom: 0.5rem;
            min-height: 2.4em;
            display: flex;
            align-items: center;
          }
          
          .admin-dashboard .row.mb-4 .card-body h3 {
            line-height: 1.2;
            margin-bottom: 0.25rem;
            min-height: 1.5em;
          }
          
          .admin-dashboard .row.mb-4 .card-body small {
            line-height: 1.4;
            display: block;
            min-height: 2.8em;
            word-wrap: break-word;
            overflow-wrap: break-word;
          }
          
          .admin-dashboard .row.mb-4 .card-body i {
            flex-shrink: 0;
            margin-top: 0.25rem;
          }
          
          /* Responsive summary cards */
          @media (max-width: 768px) {
            .admin-dashboard .row.mb-4 {
              margin-left: 0 !important;
              margin-right: 0 !important;
            }
            .admin-dashboard .row.mb-4 > div {
              padding-left: 0.5rem !important;
              padding-right: 0.5rem !important;
              margin-bottom: 0.75rem !important;
            }
            .admin-dashboard .row.mb-4 .card {
              min-height: 100px;
              width: 100% !important;
              max-width: 100% !important;
            }
            .admin-dashboard .row.mb-4 .card-body h6 {
              min-height: 2em;
              font-size: 0.7rem;
              word-break: break-word !important;
            }
            .admin-dashboard .row.mb-4 .card-body h3 {
              font-size: 1.5rem;
            }
            .admin-dashboard .row.mb-4 .card-body small {
              font-size: 0.75rem;
              min-height: 2.4em;
              word-break: break-word !important;
              overflow-wrap: break-word !important;
            }
            .admin-dashboard .row.mb-4 .card-body i {
              font-size: 2rem;
            }
          }
          
          @media (max-width: 576px) {
            .admin-dashboard .row.mb-4 > div {
              padding-left: 0.25rem !important;
              padding-right: 0.25rem !important;
              margin-bottom: 0.5rem !important;
            }
            .admin-dashboard .row.mb-4 .card {
              min-height: 90px;
              width: 100% !important;
              max-width: 100% !important;
            }
            .admin-dashboard .row.mb-4 .card-body {
              padding: 0.75rem !important;
            }
            .admin-dashboard .row.mb-4 .card-body h3 {
              font-size: 1.25rem !important;
            }
            .admin-dashboard .row.mb-4 .card-body h6 {
              font-size: 0.65rem !important;
              min-height: 1.8em;
              word-break: break-word !important;
            }
            .admin-dashboard .row.mb-4 .card-body small {
              font-size: 0.7rem !important;
              min-height: 2em;
              word-break: break-word !important;
              overflow-wrap: break-word !important;
            }
            .admin-dashboard .row.mb-4 .card-body i {
              font-size: 1.75rem !important;
            }
          }
          
          /* Ensure summary cards don't overflow on any screen */
          .admin-dashboard .row.mb-4 .card-body {
            overflow-wrap: break-word !important;
            word-break: break-word !important;
            max-width: 100% !important;
          }
          
          /* Responsive table wrapper */
          @media (max-width: 768px) {
            .admin-dashboard .table-responsive {
              border-radius: 8px;
              overflow-x: auto;
              -webkit-overflow-scrolling: touch;
            }
          }
          
          /* Optimize column widths for opportunities table - Desktop */
          @media (min-width: 992px) {
            .admin-dashboard table.table-hover {
              table-layout: fixed;
              width: 100%;
            }
            .admin-dashboard table.table-hover thead th:nth-child(1),
            .admin-dashboard table.table-hover tbody td:nth-child(1) {
              width: 26%;
              min-width: 180px;
              max-width: 26%;
            }
            .admin-dashboard table.table-hover thead th:nth-child(2),
            .admin-dashboard table.table-hover tbody td:nth-child(2) {
              width: 10%;
              min-width: 100px;
              max-width: 10%;
              white-space: nowrap;
              text-align: center;
            }
            .admin-dashboard table.table-hover thead th:nth-child(3),
            .admin-dashboard table.table-hover tbody td:nth-child(3) {
              width: 8%;
              min-width: 80px;
              max-width: 8%;
              white-space: nowrap !important;
              text-align: center;
            }
            .admin-dashboard table.table-hover thead th:nth-child(4),
            .admin-dashboard table.table-hover tbody td:nth-child(4) {
              width: 8%;
              min-width: 70px;
              max-width: 8%;
              text-align: center;
              white-space: nowrap !important;
            }
            .admin-dashboard table.table-hover thead th:nth-child(5),
            .admin-dashboard table.table-hover tbody td:nth-child(5) {
              width: 8%;
              min-width: 75px;
              max-width: 8%;
              text-align: center;
              white-space: nowrap;
            }
            .admin-dashboard table.table-hover thead th:nth-child(6),
            .admin-dashboard table.table-hover tbody td:nth-child(6) {
              width: 8%;
              min-width: 75px;
              max-width: 8%;
              text-align: center;
              white-space: normal;
            }
            .admin-dashboard table.table-hover thead th:nth-child(7),
            .admin-dashboard table.table-hover tbody td:nth-child(7) {
              width: 11%;
              min-width: 110px;
              max-width: 11%;
              white-space: nowrap;
              text-align: center;
            }
            .admin-dashboard table.table-hover thead th:nth-child(8),
            .admin-dashboard table.table-hover tbody td:nth-child(8) {
              width: 11%;
              min-width: 120px;
              max-width: 11%;
              white-space: nowrap;
              text-align: center;
            }
          }
          
          /* Tablet adjustments */
          @media (max-width: 991px) and (min-width: 769px) {
            .admin-dashboard table.table-hover {
              table-layout: auto;
            }
            .admin-dashboard table.table-hover thead th,
            .admin-dashboard table.table-hover tbody td {
              padding: 12px 8px !important;
              font-size: 0.9rem;
            }
            .admin-dashboard table.table-hover thead th:nth-child(1),
            .admin-dashboard table.table-hover tbody td:nth-child(1) {
              min-width: 180px;
              max-width: 35%;
            }
            .admin-dashboard table.table-hover thead th:nth-child(n+4),
            .admin-dashboard table.table-hover tbody td:nth-child(n+4) {
              font-size: 0.85rem;
            }
          }
          
          /* Mobile table adjustments */
          @media (max-width: 768px) {
            .admin-dashboard table.table-hover {
              table-layout: auto;
            }
            .admin-dashboard table.table-hover thead th,
            .admin-dashboard table.table-hover tbody td {
              padding: 10px 6px !important;
              font-size: 0.85rem;
            }
            .admin-dashboard table.table-hover thead th:nth-child(1),
            .admin-dashboard table.table-hover tbody td:nth-child(1) {
              min-width: 150px;
              max-width: 40%;
            }
          }
          
          /* Very small screens - hide less critical columns */
          @media (max-width: 768px) {
            .admin-dashboard table.table-hover thead th:nth-child(4),
            .admin-dashboard table.table-hover tbody td:nth-child(4),
            .admin-dashboard table.table-hover thead th:nth-child(5),
            .admin-dashboard table.table-hover tbody td:nth-child(5),
            .admin-dashboard table.table-hover thead th:nth-child(6),
            .admin-dashboard table.table-hover tbody td:nth-child(6),
            .admin-dashboard table.table-hover thead th:nth-child(7),
            .admin-dashboard table.table-hover tbody td:nth-child(7) {
              display: none;
            }
            .admin-dashboard .table-responsive {
              overflow-x: auto;
              -webkit-overflow-scrolling: touch;
            }
          }
          
          /* Extra small screens - show only essential columns */
          @media (max-width: 576px) {
            .admin-dashboard table.table-hover thead th:nth-child(8),
            .admin-dashboard table.table-hover tbody td:nth-child(8) {
              display: none;
            }
            .admin-dashboard table.table-hover thead th,
            .admin-dashboard table.table-hover tbody td {
              padding: 10px 6px !important;
              font-size: 0.85rem;
            }
            .admin-dashboard table.table-hover thead th:nth-child(1),
            .admin-dashboard table.table-hover tbody td:nth-child(1) {
              min-width: 150px;
            }
          }
        `}
      </style>
      <div className="row admin-dashboard">
        <div className="col-12" style={{ paddingLeft: '0.5rem', paddingRight: '0.5rem' }}>
          <div className="card" style={{ 
            minHeight: 'calc(100vh - 4rem)',
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px',
            margin: '0',
            maxWidth: '100%',
            width: '100%',
            paddingLeft: 'clamp(0.75rem, 2vw, 1.5rem)',
            paddingRight: 'clamp(0.75rem, 2vw, 1.5rem)'
          }}>
            <div className="card-header border-0 bg-transparent" style={{ marginBottom: '2rem', paddingBottom: '1rem', paddingLeft: 0, paddingRight: 0, overflow: 'visible' }}>
              <div className="d-flex flex-column flex-lg-row justify-content-between align-items-start align-items-lg-center gap-3" style={{ flexWrap: 'wrap', minWidth: 0 }}>
                <h1 className="h3 mb-0" style={{ 
                  color: '#E0E0E0', 
                  fontSize: 'clamp(1.25rem, 4vw, 1.75rem)',
                  lineHeight: '1.2',
                  wordBreak: 'break-word',
                  overflowWrap: 'break-word',
                  flex: '1 1 auto',
                  minWidth: 0,
                  maxWidth: '100%',
                  overflow: 'visible'
                }}>{user?.role === 'superadmin' ? 'Superadmin Dashboard' : 'Admin Dashboard'}</h1>
                <div className="d-flex flex-row gap-2" style={{ flexShrink: 0, minWidth: 0, flexWrap: 'nowrap' }}>
                  <button 
                    className="btn btn-outline-secondary"
                    onClick={() => navigate('/admin/settings')}
                    aria-label="Settings"
                    style={{
                      backgroundColor: 'transparent',
                      borderColor: 'rgba(255, 255, 255, 0.2)',
                      color: '#E0E0E0',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                      minWidth: 'fit-content'
                    }}
                  >
                    <i className="bi bi-gear me-2"></i>
                    <span>Settings</span>
                  </button>
                  <button 
                    className="btn btn-primary"
                    onClick={() => navigate('/admin/opportunities/new')}
                    aria-label="Create new research study"
                    style={{
                      backgroundColor: '#FF4E50',
                      borderColor: '#FF4E50',
                      color: '#FFFFFF',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                      minWidth: 'fit-content'
                    }}
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
                  <div className="card border-0 shadow-sm h-100 stat-card" style={{ 
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '10px',
                    padding: 0
                  }}>
                    <div className="card-body" style={{ padding: '0.25rem 0.75rem 0.25rem' }}>
                      <div className="d-flex align-items-center justify-content-between" style={{ marginBottom: '-0.25rem' }}>
                        <span className="text-uppercase" style={{ fontSize: '0.85rem', color: '#E0E0E0', opacity: 0.7, letterSpacing: '0.05em', fontWeight: 600, whiteSpace: 'nowrap' }}>Studies</span>
                        <i className="bi bi-clipboard-data" style={{ fontSize: '2.7rem', color: '#FF4E50' }}></i>
                      </div>
                      <h2 className="mb-0" style={{ color: '#E0E0E0', fontWeight: '700', fontSize: '3.375rem', lineHeight: 1, whiteSpace: 'nowrap' }}>{dashboardStats.total_opportunities}</h2>
                      <small style={{ color: '#E0E0E0', opacity: 0.6, fontSize: '0.8rem', lineHeight: 1, whiteSpace: 'nowrap' }}>
                        {dashboardStats.published_opportunities} live · {dashboardStats.draft_opportunities} draft
                      </small>
                    </div>
                  </div>
                </div>
                <div className="col-6 col-sm-3">
                  <div className="card border-0 shadow-sm h-100 stat-card" style={{ 
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '10px',
                    padding: 0
                  }}>
                    <div className="card-body" style={{ padding: '0.25rem 0.75rem 0.25rem' }}>
                      <div className="d-flex align-items-center justify-content-between" style={{ marginBottom: '-0.25rem' }}>
                        <span className="text-uppercase" style={{ fontSize: '0.85rem', color: '#E0E0E0', opacity: 0.7, letterSpacing: '0.05em', fontWeight: 600, whiteSpace: 'nowrap' }}>Bookings</span>
                        <i className="bi bi-calendar-check" style={{ fontSize: '2.7rem', color: '#FF4E50' }}></i>
                      </div>
                      <h2 className="mb-0" style={{ color: '#E0E0E0', fontWeight: '700', fontSize: '3.375rem', lineHeight: 1, whiteSpace: 'nowrap' }}>{dashboardStats.total_bookings}</h2>
                      <small style={{ color: '#E0E0E0', opacity: 0.6, fontSize: '0.8rem', lineHeight: 1, whiteSpace: 'nowrap' }}>
                        {dashboardStats.upcoming_bookings} up · {dashboardStats.past_bookings} past
                      </small>
                    </div>
                  </div>
                </div>
                <div className="col-6 col-sm-3">
                  <div className="card border-0 shadow-sm h-100 stat-card" style={{ 
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '10px',
                    padding: 0
                  }}>
                    <div className="card-body" style={{ padding: '0.25rem 0.75rem 0.25rem' }}>
                      <div className="d-flex align-items-center justify-content-between" style={{ marginBottom: '-0.25rem' }}>
                        <span className="text-uppercase" style={{ fontSize: '0.85rem', color: '#E0E0E0', opacity: 0.7, letterSpacing: '0.05em', fontWeight: 600, whiteSpace: 'nowrap' }}>Users</span>
                        <i className="bi bi-people" style={{ fontSize: '2.7rem', color: '#FF4E50' }}></i>
                      </div>
                      <h2 className="mb-0" style={{ color: '#E0E0E0', fontWeight: '700', fontSize: '3.375rem', lineHeight: 1, whiteSpace: 'nowrap' }}>{dashboardStats.total_participants}</h2>
                      <small style={{ color: '#E0E0E0', opacity: 0.6, fontSize: '0.8rem', lineHeight: 1, whiteSpace: 'nowrap' }}>
                        Unique participants
                      </small>
                    </div>
                  </div>
                </div>
                <div className="col-6 col-sm-3">
                  <div className="card border-0 shadow-sm h-100 stat-card" style={{ 
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '10px',
                    padding: 0
                  }}>
                    <div className="card-body" style={{ padding: '0.25rem 0.75rem 0.25rem' }}>
                      <div className="d-flex align-items-center justify-content-between" style={{ marginBottom: '-0.25rem' }}>
                        <span className="text-uppercase" style={{ fontSize: '0.85rem', color: '#E0E0E0', opacity: 0.7, letterSpacing: '0.05em', fontWeight: 600, whiteSpace: 'nowrap' }}>Slots</span>
                        <i className="bi bi-clock" style={{ fontSize: '2.7rem', color: '#FF4E50' }}></i>
                      </div>
                      <h2 className="mb-0" style={{ color: '#E0E0E0', fontWeight: '700', fontSize: '3.375rem', lineHeight: 1, whiteSpace: 'nowrap' }}>{dashboardStats.available_slots}</h2>
                      <small style={{ color: '#E0E0E0', opacity: 0.6, fontSize: '0.8rem', lineHeight: 1, whiteSpace: 'nowrap' }}>
                        {dashboardStats.booked_slots}/{dashboardStats.total_slots} booked
                      </small>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Navigation Tabs */}
            <div className="card-header border-0 bg-transparent" style={{ paddingBottom: '0.5rem', paddingLeft: 0, paddingRight: 0 }}>
              <ul className="nav nav-tabs nav-fill" role="tablist" style={{ borderBottom: 'none', margin: 0 }}>
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
                    <i className="bi bi-chat-left-text me-2"></i>
                    <span>Feedback</span>
                  </button>
                </li>
              </ul>
            </div>
            
            <div className="card-body" style={{ backgroundColor: 'transparent', padding: '0' }}>
              {/* Tab Content */}
              <div className="tab-content" style={{ padding: 'clamp(1rem, 2vw, 1.5rem)', paddingLeft: 0, paddingRight: 0 }}>
                {/* Research Studies Tab */}
                <div 
                  className={`tab-pane fade ${activeTab === 'opportunities' ? 'show active' : ''}`}
                  id="research-studies-tab"
                  role="tabpanel"
                  aria-labelledby="research-studies-tab-button"
                >
                  {/* Filters - using flexbox instead of Bootstrap grid for precise alignment */}
                  <div className="filters-row" style={{ 
                    display: 'flex', 
                    flexWrap: 'wrap',
                    gap: '1rem',
                    marginBottom: '1.5rem'
                  }}>
                    <div style={{ flex: '1 1 200px', minWidth: '200px' }}>
                      <label htmlFor="searchFilter" className="form-label mb-2">
                        <i className="bi bi-search me-1"></i>Search Studies
                      </label>
                      <input
                        ref={searchInputRef}
                        type="text"
                        id="searchFilter"
                        className="form-control"
                        placeholder="Search by title or description..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        style={{ 
                          fontSize: 'clamp(1rem, 1.1em, 1.1em)', 
                          padding: '0.75rem 1rem',
                          height: 'auto',
                          minHeight: '2.5rem',
                          width: '100%',
                          boxSizing: 'border-box'
                        }}
                      />
                    </div>
                    <div style={{ flex: '1 1 150px', minWidth: '150px' }}>
                      <label htmlFor="statusFilter" className="form-label mb-2">Status</label>
                      <select
                        id="statusFilter"
                        className="form-select"
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                        style={{ 
                          fontSize: 'clamp(1rem, 1.1em, 1.1em)', 
                          padding: '0.75rem 1rem',
                          height: 'auto',
                          minHeight: '2.5rem',
                          width: '100%',
                          boxSizing: 'border-box'
                        }}
                      >
                        <option value="">All Statuses</option>
                        <option value="draft">Draft</option>
                        <option value="published">Published</option>
                        <option value="closed">Closed</option>
                      </select>
                    </div>
                    <div style={{ flex: '1 1 150px', minWidth: '150px' }}>
                      <label htmlFor="typeFilter" className="form-label mb-2">Study Type</label>
                      <select
                        id="typeFilter"
                        className="form-select"
                        value={typeFilter}
                        onChange={(e) => setTypeFilter(e.target.value)}
                        style={{ 
                          fontSize: 'clamp(1rem, 1.1em, 1.1em)', 
                          padding: '0.75rem 1rem',
                          height: 'auto',
                          minHeight: '2.5rem',
                          width: '100%',
                          boxSizing: 'border-box'
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
                    <div className="table-responsive" style={{ 
                      minHeight: '400px', 
                      overflowX: 'auto', 
                      width: '100%'
                    }}>
                      <table className="table table-hover" style={{ width: '100%', margin: 0 }}>
                        <thead>
                          <tr>
                            <th 
                              style={{ cursor: 'pointer', userSelect: 'none', fontWeight: '600', padding: '12px 16px', whiteSpace: 'normal', lineHeight: '1.3', textAlign: 'left' }}
                              onClick={() => handleSort('title')}
                            >
                              Title {sortField === 'title' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th 
                              style={{ cursor: 'pointer', userSelect: 'none', fontWeight: '600', padding: '12px 8px', whiteSpace: 'normal', lineHeight: '1.3', textAlign: 'center' }}
                              onClick={() => handleSort('type')}
                            >
                              Type {sortField === 'type' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th 
                              style={{ cursor: 'pointer', userSelect: 'none', fontWeight: '600', padding: '12px 8px', whiteSpace: 'nowrap', lineHeight: '1.3', textAlign: 'center' }}
                              onClick={() => handleSort('status')}
                            >
                              Status {sortField === 'status' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th style={{ fontWeight: '600', padding: '12px 8px', textAlign: 'center', whiteSpace: 'nowrap', lineHeight: '1.3' }}>Clicks</th>
                            <th style={{ fontWeight: '600', padding: '12px 8px', textAlign: 'center', whiteSpace: 'normal', lineHeight: '1.3' }}>Total Slots</th>
                            <th style={{ fontWeight: '600', padding: '12px 8px', textAlign: 'center', whiteSpace: 'normal', lineHeight: '1.3' }}>
                              Slots<br />to Fill
                            </th>
                            <th 
                              style={{ cursor: 'pointer', userSelect: 'none', fontWeight: '600', padding: '12px 8px', whiteSpace: 'normal', lineHeight: '1.3', textAlign: 'center' }}
                              onClick={() => handleSort('created_at')}
                            >
                              Created {sortField === 'created_at' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </th>
                            <th style={{ fontWeight: '600', padding: '12px 8px', whiteSpace: 'normal', lineHeight: '1.3', textAlign: 'center' }}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedOpportunities.map((opportunity) => (
                            <tr 
                              key={opportunity.id}
                              style={{ cursor: 'pointer' }}
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
                              <td style={{ padding: '16px 16px', verticalAlign: 'middle' }}>
                                <div>
                                  <strong style={{ fontSize: 'var(--font-size-body)', fontWeight: 'var(--font-weight-card-title)' }}>{opportunity.title}</strong>
                                  <br />
                                  <small style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)', lineHeight: '1.25' }}>{opportunity.purpose_one_liner}</small>
                                </div>
                              </td>
                              <td style={{ padding: '16px 8px', verticalAlign: 'middle', textAlign: 'center' }}>
                                <span className={getTypeBadgeClass(opportunity.type)}>
                                  {formatOpportunityType(opportunity.type)}
                                </span>
                              </td>
                              <td style={{ padding: '16px 8px', verticalAlign: 'middle', textAlign: 'center' }}>
                                <span className={getStatusBadgeClass(opportunity.status)}>
                                  {opportunity.status === 'published' ? 'live' : opportunity.status}
                                </span>
                                {opportunity.status === 'closed' && (
                                  <span className="badge bg-dark ms-1">Auto-closed</span>
                                )}
                              </td>
                              <td style={{ color: 'var(--text-muted)', padding: '16px 8px', verticalAlign: 'middle', textAlign: 'center' }}>
                                {(opportunity.type === 'poll' || opportunity.type === 'survey' || opportunity.type === 'unmoderated') ? (
                                  opportunity.clicks_total ?? 0
                                ) : (
                                  ''
                                )}
                              </td>
                              <td style={{ padding: '16px 8px', verticalAlign: 'middle', textAlign: 'center' }}>
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
                              <td style={{ padding: '16px 8px', verticalAlign: 'middle', textAlign: 'center' }}>
                                {(opportunity.type === 'test' || opportunity.type === 'interview') ? (
                                  ''
                                ) : (
                                  ''
                                )}
                              </td>
                              <td style={{ padding: '16px 8px', verticalAlign: 'middle', textAlign: 'center' }}>
                                <small style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-metadata)' }}>
                                  {new Date(opportunity.created_at).toLocaleDateString()}
                                </small>
                              </td>
                              <td style={{ padding: '16px 8px', verticalAlign: 'middle', textAlign: 'center' }}>
                                <div className="dropdown" style={{ position: 'relative' }}>
                                  <button
                                    className="btn btn-outline-secondary btn-sm"
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
                                          <div className="dropdown-divider"></div>
                                          <button
                                            className="dropdown-item"
                                            onClick={(e) => {
                                              e.stopPropagation();
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
  );
};

export default Admin;
