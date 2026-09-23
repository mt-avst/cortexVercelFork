import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { Link, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getOpportunities, deleteOpportunity, duplicateOpportunity, getDashboardStats, DashboardStats, exportBookingsCsv, getPendingApprovals, getFeedback } from '../api/client';
import { Opportunity } from '../api/types';
import { getTypeBadgeClass, getTimeRemainingUntil } from '../utils/opportunityUtils';
import {
  getStudyProgress,
  getSessionsThisWeek,
  getStudiesClosingSoon,
  getBrokenStudies,
  getNextMilestone,
  getDisplayStatus,
  getAdminTypeLabel,
  getQuickFilterCounts,
  getPrimaryStudyAction,
  canManageStudy,
  CLOSING_SOON_DAYS,
  isAutoClosed,
  isNextNoteWarned,
  isStudyBroken,
  matchesQuickFilter,
  matchesStatusFilter,
  matchesTypeFilter,
  relativeDayLabel,
  sortStudies,
  studyAnalyticsPath,
  studyEditPath,
  studyPreviewPath,
  studyRowPath,
  QUICK_FILTERS,
  QuickFilter,
  SortDirection,
  StatusFilter,
  StudySortField,
} from '../utils/adminDashboard';
import {
  PUBLISHED_NOT_WORKING_LABEL,
  PUBLISHED_NOT_WORKING_PREFIX,
  PUBLISHED_NOT_WORKING_DESCRIPTION
} from '../lib/opportunity-authoring/step-status';
import { logger } from '../utils/logger';
import PendingApprovals from '../components/PendingApprovals';
import AdminFeedback from '../components/AdminFeedback';
import ErrorState from '../components/ErrorState';
import ConfirmationModal from '../components/ConfirmationModal';
import { Dropdown, DropdownItem, DropdownDivider, Icon, SortCaret } from '../components/ui';
import { Settings, ClipboardList, Users, Clock, List, History, MessageSquare, Calendar, Download, Clapperboard, Flag, ArrowRight, MoreVertical, CheckCircle, AlertTriangle } from 'lucide-react';
import { getStudyTypeGlyph } from '../utils/studyTypeIcons';
import { useCloseStudyUndo, failureMessage, isInViewport, CLOSE_UNDO_MS } from '../hooks/useCloseStudyUndo';
import { ClosedStudyNoticeRow, CopyNoticeRow, StudyActionErrorRow } from '../components/StudyRowNotices';

import { formatStudyDate, formatStudyDateCompact, formatClockTime, formatTimeZoneLabel } from '../utils/datetime';

/** The Research Studies table's sortable columns - one union (`StudySortField`,
 * adminDashboard.ts) shared by the Sort-by control (#131), the header buttons,
 * handleSort, ariaSortFor and the comparator, so they cannot drift apart. `type`
 * is not one: the type is filterable (Study Type select) and rides in the Study
 * cell's meta line, but no header sorts on it, and the Sort-by control offers
 * exactly what the headers do. */
type SortField = StudySortField;


const Admin: React.FC = () => {
  const { user, loading, initialAuthCheck } = useAuth();
  // Each page names itself in the browser tab; the "· Cortex" lock-up lives here
  // (the tab has no persistent header) rather than repeating in the on-page title.
  useDocumentTitle('Admin · Cortex');
  const navigate = useNavigate();
  const location = useLocation();

  // Add admin-page class to body for wider header alignment. The second class
  // is this page's own: it widens the page and header column to 1440px
  // (_components.css, search "admin-dashboard-page"), which Settings - the
  // other `admin-page` - does not want.
  useEffect(() => {
    document.body.classList.add('admin-page', 'admin-dashboard-page');
    return () => {
      document.body.classList.remove('admin-page', 'admin-dashboard-page');
    };
  }, []);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loadingOpportunities, setLoadingOpportunities] = useState(true);
  const [error, setError] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
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
  // Status ascending by default (Petra 3.2): broken studies first, then
  // drafts, then live studies by their next milestone, then closed ones.
  const [sortField, setSortField] = useState<SortField>('status');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [_loadingStats, setLoadingStats] = useState(false);
  // Decision 2: "Show all researchers" toggle. Off by default, so an admin lands
  // on their own studies and their own snapshot; on widens both the studies
  // table and the snapshot counts to every researcher, together.
  const [showAllResearchers, setShowAllResearchers] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string>('');
  // Decoupled from successMessage's own text: the banner used to infer
  // "warning" purely from the message containing the word 'DRAFT', which
  // handleDuplicate's copy-failed message has no reason to contain.
  const [successMessageVariant, setSuccessMessageVariant] = useState<'success' | 'warning'>('success');
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Counts for the tab badges and the "Needs attention" panel. Fetched here so
  // the badge shows a number without opening the tab; the tab components still
  // own their own full fetch.
  const [pendingApprovalsCount, setPendingApprovalsCount] = useState<number | null>(null);
  const [feedbackCount, setFeedbackCount] = useState<{ count: number; hasMore: boolean } | null>(null);
  const [quickFilter, setQuickFilter] = useState<QuickFilter | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const quickFiltersRef = useRef<HTMLDivElement>(null);
  const resultCountRef = useRef<HTMLSpanElement>(null);
  // Set by a Needs attention card that applies its chip: once the filtered
  // list has rendered, bring the chip row and the first rows into view.
  const [revealTable, setRevealTable] = useState(false);
  // Copy's outcome, shown in place under the study that was copied.
  const [copyNotice, setCopyNotice] = useState<
    { id: string; title: string; tone: 'status' | 'error'; message: string } | null
  >(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyRetryRef = useRef<HTMLButtonElement>(null);
  // One clock reading per mount, shared by every "now"-relative derivation on
  // the page so the snapshot and the table agree with each other.
  const now = useMemo(() => new Date(), []);



  const handleSort = (field: SortField) => {
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
  const ariaSortFor = (field: SortField): 'ascending' | 'descending' | 'none' =>
    sortField === field ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none';

  const toggleQuickFilter = (filter: QuickFilter) => {
    setQuickFilter((current) => (current === filter ? null : filter));
  };

  /**
   * A Needs attention card's "View studies": show exactly that chip's studies
   * - so the other filters are cleared, or the card's own count could be
   * narrowed to nothing - and bring the result into view, since the panel
   * sits well above the table.
   */
  const applyChipFromAttention = (filter: QuickFilter) => {
    setSearchQuery('');
    setDebouncedSearchQuery('');
    setStatusFilter('');
    setTypeFilter('');
    setQuickFilter(filter);
    setActiveTab('opportunities');
    setRevealTable(true);
  };

  // After the chip has filtered the list: scroll the chip row (and so the
  // first rows under it) into view, and put focus on the result count, which
  // says what the table now shows.
  useEffect(() => {
    if (!revealTable) return;
    setRevealTable(false);
    quickFiltersRef.current?.scrollIntoView?.({ block: 'start' });
    resultCountRef.current?.focus({ preventScroll: true });
  }, [revealTable]);

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
      // Status and Study Type filter client-side (see statusFilteredOpportunities),
      // so the whole in-scope list is always loaded. A forced refresh - returning
      // from creating or editing a study - clears those two selects, so the new
      // or changed study is visible, as the old server-side forced clear made it.
      if (forceClearFilter) {
        setStatusFilter('');
        setTypeFilter('');
      }
      // Decision 2: the owner scope is the one thing that goes to the server -
      // it is not a filter chip, it is which researchers' studies the table is
      // showing, and it must match the snapshot's scope below.
      const params: { scope: 'mine' | 'all' } = { scope: showAllResearchers ? 'all' : 'mine' };
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
  }, [showAllResearchers]);

  /**
   * Re-read the list WITHOUT the load states: no spinner, no error banner, and
   * the list on screen stays if the request fails. For a refresh after a row
   * action (Copy), where blanking the table - or replacing it with the
   * load-failure state - would lose the reader's place and hide what they just
   * did. Resolves whether it worked; the caller says so in place.
   */
  const refreshOpportunities = useCallback(async (): Promise<boolean> => {
    try {
      const data = await getOpportunities({ scope: showAllResearchers ? 'all' : 'mine' });
      setOpportunities(data || []);
      return true;
    } catch (error: unknown) {
      logger.warn('Failed to refresh research studies', {
        component: 'Admin',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }, [showAllResearchers]);

  const loadDashboardStats = useCallback(async () => {
    try {
      setLoadingStats(true);
      const stats = await getDashboardStats(showAllResearchers ? 'all' : 'mine');
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
  }, [showAllResearchers]);

  // --- Close study, with Undo (Petra 3.4; hooks/useCloseStudyUndo.ts) -------

  /** Update one row in place from a status change the server accepted. */
  const applyStatus = useCallback((id: string, status: 'published' | 'closed') => {
    // `auto_closed: false` because this table only ever makes MANUAL status
    // changes - the server records the same (MR A), so the row need not wait
    // for a reload to lose its "Auto-closed" caption.
    setOpportunities((current) =>
      current.map((opp) => (opp.id === id ? { ...opp, status, auto_closed: false } : opp))
    );
    // The snapshot's published/draft counts and open slots moved with it.
    void loadDashboardStats();
  }, [loadDashboardStats]);

  /**
   * Focus a study's title link: where focus goes when its notice ends or its
   * error is dismissed. If that link is no longer on screen - the row
   * re-sorted away, or left the filtered table - focus goes to what now sits
   * at the notice's old slot instead (`near`: the next row's link, then the
   * previous row's), else the result count, else the study's own link. Never
   * scrolls, and never lands off screen, so the next Tab does not jump the
   * page either.
   */
  const focusStudy = useCallback((id: string, near: string[] = []) => {
    const table = tableRef.current;
    const link = (studyId: string) =>
      table?.querySelector<HTMLAnchorElement>(`a.row-title[data-study-id="${studyId}"]`) ?? null;
    const own = link(id);
    let target: HTMLElement | null = own && isInViewport(own) ? own : null;
    if (!target) {
      target =
        near.map(link).find((el): el is HTMLAnchorElement => el !== null) ??
        resultCountRef.current ??
        own;
      // No "first study" fallback: the result count renders whenever a filter
      // is on, and with no filter the study's own row is always in the table,
      // so `own` is the last resort that can actually be reached.
    }
    target?.focus({ preventScroll: true });
  }, []);

  /** The studies around study `id`'s notice or error slot, before a re-sort:
   * the next row's, then the previous row's (its own row excepted). */
  const captureNeighbours = useCallback((id: string): string[] => {
    const slot = tableRef.current?.querySelector(`tr[data-notice-for="${id}"]`);
    if (!slot) return [];
    const studyOf = (tr: Element | null) =>
      tr?.querySelector<HTMLAnchorElement>('a.row-title')?.dataset.studyId;
    let next = slot.nextElementSibling;
    while (next && !studyOf(next)) next = next.nextElementSibling;
    let prev = slot.previousElementSibling;
    while (prev && (!studyOf(prev) || studyOf(prev) === id)) prev = prev.previousElementSibling;
    return [studyOf(next), studyOf(prev)].filter((studyId): studyId is string => Boolean(studyId));
  }, []);

  const closeUndo = useCloseStudyUndo({ onStatusChanged: applyStatus, focusStudy, captureNeighbours });

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

  // The Status and Study Type selects, applied here rather than on the server:
  // `opportunities` is then the whole in-scope set, so "N of M" is true under
  // every filter and Needs attention never narrows with a table filter.
  const statusFilteredOpportunities = useMemo(
    () =>
      filteredOpportunities.filter(
        (opp) => matchesStatusFilter(opp, statusFilter) && matchesTypeFilter(opp, typeFilter)
      ),
    [filteredOpportunities, statusFilter, typeFilter]
  );

  // What each chip would show, over everything but the chips themselves - the
  // count on the chip is the number of rows pressing it gives.
  const quickFilterCounts = useMemo(
    () => getQuickFilterCounts(statusFilteredOpportunities, now),
    [statusFilteredOpportunities, now]
  );

  // Quick-filter chips narrow the search results further, client-side over the
  // already-loaded list. Each predicate reads only real fields (status, session
  // capacity, closing time) - see adminDashboard.ts.
  const quickFilteredOpportunities = useMemo(() => {
    if (!quickFilter) return statusFilteredOpportunities;
    return statusFilteredOpportunities.filter((opp) => matchesQuickFilter(opp, quickFilter, now));
  }, [statusFilteredOpportunities, quickFilter, now]);

  // One stable comparator for header and Sort-by alike (adminDashboard.ts).
  // Every filter, the "N of M" count, the chip counts and Needs attention read
  // LIVE status; this list is what the count and the empty state measure.
  const sortedOpportunities = useMemo(
    () => sortStudies(quickFilteredOpportunities, sortField, sortDirection, now),
    [quickFilteredOpportunities, sortField, sortDirection, now]
  );

  // What the table draws. The same rows, with two in-place exceptions, both
  // sorted on the study as it was BEFORE its close so they hold the place
  // the reader was looking at:
  //  - while a study's Close notice is up, its row sorts on that snapshot and
  //    stays under the pointer with Undo beneath it. If the live filters no
  //    longer match it (a closed study under the Broken chip), its notice
  //    stays alone in that place ('noticeOnly'), so Undo is still there.
  //  - after a refused Undo, the error takes the notice's slot on its own
  //    ('errorSlot'), while the row itself moves to its live place.
  // Neither extra entry is counted: counts and filters read live status.
  type TableRow = { study: Opportunity; kind: 'row' | 'noticeOnly' | 'errorSlot' };
  const tableRows = useMemo((): TableRow[] => {
    const frozen = closeUndo.frozenSnapshot;
    const errorAnchor = closeUndo.actionError?.anchor ?? null;
    if (!frozen && !errorAnchor) return sortedOpportunities.map((study) => ({ study, kind: 'row' }));
    const query = debouncedSearchQuery.toLowerCase();
    // Whether a pre-close snapshot would be on screen under the current filters.
    const wasShown = (snapshot: Opportunity) =>
      (!query ||
        snapshot.title.toLowerCase().includes(query) ||
        snapshot.purpose_one_liner.toLowerCase().includes(query) ||
        Boolean(snapshot.description_optional?.toLowerCase().includes(query))) &&
      matchesStatusFilter(snapshot, statusFilter) &&
      matchesTypeFilter(snapshot, typeFilter) &&
      (!quickFilter || matchesQuickFilter(snapshot, quickFilter, now));
    const frozenLive = frozen !== null && quickFilteredOpportunities.some((opp) => opp.id === frozen.id);
    let input: Opportunity[] = frozenLive
      ? quickFilteredOpportunities.map((opp) => (opp.id === frozen.id ? frozen : opp))
      : quickFilteredOpportunities;
    if (frozen && !frozenLive && wasShown(frozen)) input = [...input, frozen];
    if (errorAnchor && wasShown(errorAnchor)) input = [...input, errorAnchor];
    const liveById = new Map(opportunities.map((opp) => [opp.id, opp]));
    // sortStudies returns the same objects it was given, so the snapshots are
    // told apart from live rows by identity.
    return sortStudies(input, sortField, sortDirection, now).map((viewed): TableRow => {
      if (viewed === errorAnchor) return { study: viewed, kind: 'errorSlot' };
      if (viewed === frozen) return { study: liveById.get(viewed.id) ?? viewed, kind: frozenLive ? 'row' : 'noticeOnly' };
      return { study: viewed, kind: 'row' };
    });
  }, [
    closeUndo.frozenSnapshot, closeUndo.actionError, sortedOpportunities, quickFilteredOpportunities, opportunities,
    debouncedSearchQuery, statusFilter, typeFilter, quickFilter, sortField, sortDirection, now,
  ]);

  // "Needs attention" and "Sessions this week" derive from every loaded study
  // in scope, unfiltered: the panel is triage for the whole list, not a view
  // of the table.
  const brokenStudies = useMemo(() => getBrokenStudies(opportunities), [opportunities]);
  const studiesClosingSoon = useMemo(() => getStudiesClosingSoon(opportunities, now), [opportunities, now]);
  const sessionsThisWeek = useMemo(() => getSessionsThisWeek(opportunities, now), [opportunities, now]);
  // The panel is permanent: it shows action cards when there is something to do,
  // and a slim all-clear line otherwise.
  const attentionClear =
    (pendingApprovalsCount ?? 0) === 0 && studiesClosingSoon.length === 0 && brokenStudies.length === 0;

  // The Sort-by control is only offered when there are rows to sort.
  const showSortControl = !loadingOpportunities && !error && tableRows.length > 0;

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
    // The filters are client-side, so only the scope (through
    // loadOpportunities' identity) reloads the list.
  }, [user, loadOpportunities, loadDashboardStats, loadCounts]);

  // Refresh opportunities when returning from editing or creating
  useEffect(() => {
    if (location.state?.refresh && (user?.role === 'researcher_admin' || user?.role === 'superadmin')) {
      // Show success message if provided
      if (location.state?.message) {
        setSuccessMessage(location.state.message);
        // Clear success message after delay (longer for draft warnings)
        const isDraftWarning = location.state.message.includes('DRAFT');
        setSuccessMessageVariant(isDraftWarning ? 'warning' : 'success');
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        successTimerRef.current = setTimeout(() => setSuccessMessage(''), isDraftWarning ? 5000 : 3000);
      }
      // Clear the refresh state first to prevent duplicate calls
      navigate(location.pathname, { replace: true, state: {} });
      // Force refresh without filters to ensure new items are visible
      // Use a small delay to ensure navigation is complete
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        loadOpportunities(true); // true = force clear filters
      }, 150);
    }
  }, [location.state, user, navigate, location.pathname, loadOpportunities]);

  // Clear the banner and refresh timers on unmount only. They cannot be
  // cleared from the effect above: its own navigate() changes location.state
  // and re-runs it, so an effect-scoped cleanup would cancel both at once.
  useEffect(() => () => {
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

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

  const clearCopyTimer = () => {
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  };

  const dismissCopyNotice = (id: string) => {
    clearCopyTimer();
    setCopyNotice((current) => (current?.id === id ? null : current));
    focusStudy(id);
  };

  /** The in-place "Copied" status, which lapses on the undo notice's clock. */
  const showCopiedNotice = (study: Opportunity) => {
    clearCopyTimer();
    setCopyNotice({ id: study.id, title: study.title, tone: 'status', message: `Copied “${study.title}”` });
    copyTimerRef.current = setTimeout(() => {
      copyTimerRef.current = null;
      setCopyNotice((current) => (current?.id === study.id && current.tone === 'status' ? null : current));
    }, CLOSE_UNDO_MS);
  };

  /**
   * Refresh after a copy; on failure the notice says so, with a Retry. A Retry
   * that succeeds re-arms the lapse and hands focus back to the study, because
   * the Retry button it was on has just gone.
   */
  const refreshAfterCopy = async (study: Opportunity, isRetry = false) => {
    const refreshed = await refreshOpportunities();
    if (refreshed) {
      if (isRetry) {
        showCopiedNotice(study);
        focusStudy(study.id);
      }
      return;
    }
    clearCopyTimer();
    setCopyNotice({
      id: study.id,
      title: study.title,
      tone: 'error',
      message: `Copied “${study.title}”, but the list could not be refreshed to show the copy.`,
    });
    window.setTimeout(() => copyRetryRef.current?.focus({ preventScroll: true }), 0);
  };

  const handleDuplicate = async (study: Opportunity) => {
    let duplicated: Awaited<ReturnType<typeof duplicateOpportunity>>;
    try {
      duplicated = await duplicateOpportunity(study.id);
    } catch (error: unknown) {
      // A refused Copy (a 403 for someone else's study, a 500) shows under
      // the study's row, like a refused Close - never through `setError`,
      // which replaces the whole table with the load-failure state.
      logger.error('Failed to duplicate research study', {
        component: 'Admin',
        opportunityId: study.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      closeUndo.showRowError(study, failureMessage('copy', study.title, error));
      return;
    }
    // The copy exists from here on: say so first, in place, then refresh the
    // list quietly. Focus goes back to the study the menu belonged to (the
    // menu item it was on has gone), without scrolling.
    showCopiedNotice(study);
    focusStudy(study.id);
    await refreshAfterCopy(study);
    // cto/AdaptaLabs#161: the backend falls back to a plain, questionless
    // copy when the linked FirstHand study is gone or fails to clone,
    // rather than refusing the whole request - previously with no signal
    // here at all, so the researcher only found out by opening the copy.
    if (duplicated.study_copy_failed) {
      setSuccessMessageVariant('warning');
      setSuccessMessage('Study duplicated, but its questions could not be copied - the copy is empty and needs its own content before it can run.');
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setSuccessMessage(''), 5000);
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
                  <h1 className="mb-1 cortex-page-title">Admin</h1>
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
                    <span className="d-none d-md-inline">Create Research Study</span>
                    <span className="d-md-none">Create Study</span>
                    <Icon icon={ArrowRight} size={16} className="ms-2" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>

            {/* Success/Warning Message */}
            {successMessage && (
              <div className={`alert ${successMessageVariant === 'warning' ? 'alert-warning' : 'alert-success'} mx-4 mt-4 mb-3`} role="alert">
                {successMessage}
              </div>
            )}

            {/* Needs attention - a PERMANENT triage panel. It shows action cards
                when studies are broken, approvals are waiting or studies close
                soon, and a slim all-clear line otherwise, so it always has a
                presence. Those three cards are the ceiling (Petra 3.3). The
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
                  {/* Broken first: the most urgent state there is - live, and
                      failing its own publish readiness. The link applies the
                      Broken chip, as the closing-soon card applies its own; a
                      single broken study opens straight onto its edit page. */}
                  {brokenStudies.length > 0 && (
                    <button
                      type="button"
                      className="admin-attention__card admin-attention__card--broken"
                      onClick={() => {
                        if (brokenStudies.length === 1) {
                          navigate(studyEditPath(brokenStudies[0].id));
                        } else {
                          applyChipFromAttention('broken');
                        }
                      }}
                    >
                      <span className="admin-attention__icon admin-attention__icon--broken"><AlertTriangle size={20} aria-hidden /></span>
                      <span className="admin-attention__body">
                        <span className="admin-attention__lead">
                          {brokenStudies.length === 1
                            ? '1 study broken'
                            : `${brokenStudies.length} studies broken`}
                        </span>
                        <span className="admin-attention__sub">
                          {brokenStudies.length === 1
                            ? brokenStudies[0].title
                            : 'Published, but participants cannot take part'}
                        </span>
                        <span className="admin-attention__link">
                          {brokenStudies.length === 1 ? 'View study' : 'View studies'} <ArrowRight size={14} aria-hidden />
                        </span>
                      </span>
                    </button>
                  )}
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
                          navigate(studyEditPath(studiesClosingSoon[0].id));
                        } else {
                          applyChipFromAttention('closing-soon');
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
                            : `Recruitment windows ending in the next ${CLOSING_SOON_DAYS} days`}
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
                  <div className="d-flex align-items-center gap-2">
                    {/* The scope note now reads the toggle, not the role: it is
                        the caller's own studies until they widen it, whoever they
                        are. */}
                    <span className="stat-scope-note">
                      {showAllResearchers
                        ? 'Across every researcher on Cortex'
                        : 'Your studies only'}
                    </span>
                    {/* Decision 2: one toggle for both the snapshot and the
                        studies table. A pressed toggle button (stable label,
                        aria-pressed carries the state) rather than a relabelling
                        button, so a screen reader hears one control change state. */}
                    <button
                      type="button"
                      className="admin-chip"
                      aria-pressed={showAllResearchers}
                      onClick={() => setShowAllResearchers((previous) => !previous)}
                    >
                      Show all researchers
                    </button>
                  </div>
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
                            <Calendar size={20} className="stat-icon" />
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
                    id="research-studies-tab-button"
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
                    id="completion-approvals-tab-button"
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
                    id="feedback-tab-button"
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
                    id="bookings-tab-button"
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
                        onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                      >
                        {/* Broken is published-and-failing-readiness, not a
                            stored status (matchesStatusFilter). */}
                        <option value="">All Statuses</option>
                        <option value="broken">Broken</option>
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
                        <option value="poll">Poll</option>
                        <option value="survey">Survey</option>
                        <option value="question">One question</option>
                      </select>
                    </div>
                  </div>

                  {/* Quick filters - client-side chips over the loaded list. Each
                      reads only real fields; "Needs recruitment" is open-slot
                      capacity, NOT a participant target (which does not exist).
                      Every chip carries its count; a chip with nothing to show
                      is disabled rather than hidden, so the row never reflows
                      (an active one stays pressable, so it can be released). */}
                  <div className="admin-quick-filters" ref={quickFiltersRef}>
                    <span className="admin-quick-filters__label">Quick filters</span>
                    {QUICK_FILTERS.map((chip) => {
                      const active = quickFilter === chip.key;
                      const count = quickFilterCounts[chip.key];
                      return (
                        <button
                          key={chip.key}
                          type="button"
                          className={`admin-chip ${active ? 'admin-chip--active' : ''}`}
                          aria-pressed={active}
                          disabled={count === 0 && !active}
                          onClick={() => toggleQuickFilter(chip.key)}
                        >
                          {/* The space gives the accessible name "Broken 3";
                              the flex gap draws the visual one. */}
                          {chip.label}{' '}
                          <span className="admin-chip__count">{count}</span>
                        </button>
                      );
                    })}
                    {/* The result count, Clear filters and Sort by are one
                        right-aligned group, so when the row runs out of room
                        they wrap together to the right edge - not Sort by
                        alone, packed left, on a line of its own. The group is
                        only rendered when it holds something. */}
                    {(hasActiveFilters || showSortControl) && (
                    <div className="admin-quick-filters__end">
                      {hasActiveFilters && !loadingOpportunities && !error && (
                        <span className="admin-result-count" role="status" ref={resultCountRef} tabIndex={-1}>
                          {sortedOpportunities.length} of {opportunities.length}{' '}
                          {opportunities.length === 1 ? 'study' : 'studies'}
                        </span>
                      )}
                      {hasActiveFilters && (
                        <button
                          type="button"
                          className="admin-clear-filters"
                          onClick={clearAllFilters}
                        >
                          Clear filters
                        </button>
                      )}
                      {/* #131: wherever a sortable header is out of view, the Sort-by
                          control is the way to reach its sort - below 1280px, where
                          the Created column is hidden, and below 1024px, where the
                          card view hides <thead> altogether (see the ROW 14 comment
                          in _components.css). It offers exactly the fields the
                          headers do. This is not a second sort mechanism: it reads
                          and writes the SAME sortField/sortDirection state through
                          the SAME handleSort the header buttons use, so the two
                          surfaces can never disagree. Hidden from 1280px up by
                          .admin-card-sort's own default rule in _components.css.
                          It sits at the right end of the quick-filters row, not on
                          a row of its own above the table, where at 1024-1279px it
                          stranded ~48px of height with nothing beside it. Rendered
                          only when there are rows to sort. */}
                      {showSortControl && (
                        <div className="admin-card-sort" role="group" aria-label="Sort studies">
                          <label htmlFor="cardSortField" className="form-label mb-0">Sort by</label>
                          <select
                            id="cardSortField"
                            className="form-select"
                            value={sortField}
                            // Choosing a field is never a direction toggle: that
                            // is the button beside it. Only a different field
                            // goes through handleSort (which starts it ascending).
                            onChange={(e) => {
                              const field = e.target.value as SortField;
                              if (field !== sortField) handleSort(field);
                            }}
                          >
                            <option value="title">Study</option>
                            <option value="status">Status</option>
                            <option value="next">Next / deadline</option>
                            <option value="created_at">Created</option>
                          </select>
                          <button type="button" className="admin-card-sort-dir" onClick={() => handleSort(sortField)}>
                            <span className="visually-hidden">Sort direction: </span>
                            {sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                            <SortCaret active direction={sortDirection} />
                          </button>
                        </div>
                      )}
                    </div>
                    )}
                  </div>


                  {/* Error State */}
                  {error && (
                    <ErrorState
                      title="Failed to load studies"
                      message={error}
                      actionLabel="Retry"
                      onAction={() => loadOpportunities()}
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
                  {!loadingOpportunities && !error && tableRows.length === 0 && (
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

                  {/* Research Studies Table. No min-height: a 400px floor once
                      kept room under a short filtered list for the last row's
                      kebab menu, and left ~200px of empty card under two rows.
                      A menu that would hang into the feedback footer or past
                      the viewport opens upward instead (ui/Dropdown.tsx,
                      "Collision flip-up"). */}
                  {!loadingOpportunities && !error && tableRows.length > 0 && (
                    <div className="table-responsive" style={{
                      overflow: 'visible', 
                      width: '100%'
                    }}>
                      <table
                        ref={tableRef}
                        className={`table table-hover admin-data-table${closeUndo.holdScroll ? ' admin-data-table--hold-scroll' : ''}`}
                      >
                        {/* Fixed pixel widths on every column but Study, which
                            takes the remainder: under `table-layout: fixed` the
                            <col> widths are the whole story. The numbers live in
                            _components.css (search "COLUMN WIDTHS"); the classes
                            here only name the columns, so the Created column can
                            be dropped below 1280px as one unit (col, th, td). */}
                        <colgroup>
                          <col className="col-title" />
                          <col className="col-status" />
                          <col className="col-progress" />
                          <col className="col-next" />
                          <col className="col-date" />
                          <col className="col-actions" />
                        </colgroup>
                        <thead>
                          <tr>
                            <th className="admin-th col-title" scope="col" aria-sort={ariaSortFor('title')}>
                              <button type="button" className="admin-th-sort" onClick={() => handleSort('title')}>
                                Study
                                <SortCaret active={sortField === 'title'} direction={sortDirection} />
                              </button>
                            </th>
                            <th className="admin-th col-status" scope="col" aria-sort={ariaSortFor('status')}>
                              <button type="button" className="admin-th-sort" onClick={() => handleSort('status')}>
                                Status
                                <SortCaret active={sortField === 'status'} direction={sortDirection} />
                              </button>
                            </th>
                            {/* Progress folds the old Recruitment and Clicks columns into
                                one: booked/capacity for a study with sessions, clicks for a
                                type that has none. There is deliberately no Capacity column
                                beside it: that duplicated the ratio's denominator. */}
                            <th className="admin-th col-progress" scope="col">Progress</th>
                            <th className="admin-th col-next" scope="col" aria-sort={ariaSortFor('next')}>
                              <button type="button" className="admin-th-sort" onClick={() => handleSort('next')}>
                                Next / deadline
                                <SortCaret active={sortField === 'next'} direction={sortDirection} />
                              </button>
                            </th>
                            <th className="admin-th col-date" scope="col" aria-sort={ariaSortFor('created_at')}>
                              <button type="button" className="admin-th-sort" onClick={() => handleSort('created_at')}>
                                Created
                                <SortCaret active={sortField === 'created_at'} direction={sortDirection} />
                              </button>
                            </th>
                            <th className="admin-th col-actions" scope="col">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tableRows.map(({ study: opportunity, kind }) => {
                            const notice = closeUndo.notice?.id === opportunity.id ? closeUndo.notice : null;
                            const rowError =
                              closeUndo.actionError?.id === opportunity.id ? closeUndo.actionError : null;
                            // A refused Undo's error has its own slot (kind
                            // 'errorSlot'); every other error sits under its row.
                            const actionError = rowError && !rowError.anchor ? rowError : null;
                            if (kind === 'errorSlot') {
                              return rowError ? (
                                <StudyActionErrorRow
                                  key={`${opportunity.id}-error-slot`}
                                  studyId={opportunity.id}
                                  message={rowError.message}
                                  onDismiss={closeUndo.dismissError}
                                  errorRef={closeUndo.errorRef}
                                />
                              ) : null;
                            }
                            // Undo is disabled on every notice while any Undo is in
                            // flight, so two reopen requests never race.
                            const noticeRow = notice && (
                              <ClosedStudyNoticeRow
                                studyId={notice.id}
                                title={notice.title}
                                undoing={closeUndo.undoingId !== null}
                                onUndo={() => void closeUndo.undo()}
                                undoButtonRef={closeUndo.undoButtonRef}
                              />
                            );
                            // The closed study no longer matches the filters: its
                            // notice alone holds its place (see tableRows).
                            if (kind === 'noticeOnly') {
                              return <React.Fragment key={opportunity.id}>{noticeRow}</React.Fragment>;
                            }
                            const recruitment = getStudyProgress(opportunity);
                            // Progress: booked / capacity when the study has sessions
                            // (below); otherwise its click count - but only when the
                            // server actually sent one. The list endpoint withholds
                            // `clicks_total` (undefined, not 0) for every type it does
                            // not count clicks for - today everything but poll, survey
                            // and unmoderated - so a missing count is "nothing to
                            // show", never "0 clicks". Drafts show nothing either.
                            const clicks = opportunity.status !== 'draft' ? opportunity.clicks_total : undefined;
                            const milestone = getNextMilestone(opportunity, now);
                            const sessionDayLabel =
                              milestone?.kind === 'session' ? relativeDayLabel(milestone.date, now) : null;
                            const TypeGlyph = getStudyTypeGlyph(opportunity.type);
                            // One call per row: the status cell renders this and
                            // also carries it as the label's `title`, and the
                            // readiness check reads six fields.
                            const notWorking = isStudyBroken(opportunity);
                            const statusLabel = notWorking
                              ? PUBLISHED_NOT_WORKING_LABEL
                              : getDisplayStatus(opportunity.status);
                            const editPath = studyEditPath(opportunity.id);
                            // One URL for the row: the title link and a row click
                            // both go here - the edit page for someone who can
                            // edit, the participant page for anyone else.
                            const rowPath = studyRowPath(opportunity, user);
                            const canManage = canManageStudy(opportunity, user);
                            const primaryAction = getPrimaryStudyAction(opportunity, user);
                            const owner = opportunity.owner_name || opportunity.owner_email;
                            return (
                            <React.Fragment key={opportunity.id}>
                            <tr
                              className="admin-row-clickable"
                              /* The mouse's shortcut to the title link's own URL.
                                 The keyboard has the link itself (Tab, Enter), so
                                 the row is not a Tab stop and carries no key
                                 handling of its own. */
                              onClick={(e) => {
                                // A plain single click only: not a keyboard-synthesised
                                // one (detail 0), not the second click of a double-click
                                // (which lands here after a menu item's first click
                                // closed the menu over this row), and not a modifier
                                // click - the title link is the way to open a new tab.
                                if (e.detail !== 1) return;
                                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                                // Nor while a Close is in flight: the menu it came from
                                // has gone, and the pointer is over some other row.
                                if (closeUndo.isCloseInFlight()) return;

                                // Ignore text selection (if user selected text)
                                const selection = window.getSelection();
                                if (selection && selection.toString().length > 0) return;

                                // Only navigate if the click target is not an interactive element
                                const target = e.target as HTMLElement;
                                const isInteractive = target.closest('button, a, input, select, textarea, [role="button"], .dropdown, .dropdown-menu, .dropdown-item');
                                if (!isInteractive) {
                                  navigate(rowPath);
                                }
                              }}
                            >
                              {/* The Study cell names the row: the title (two lines at
                                  most, and the link to the study) and one meta line -
                                  the type pill, the owner when every researcher's
                                  studies are showing, then the purpose one-liner,
                                  truncated. Clamped strings carry their full text in
                                  `title`, so nothing is lost. */}
                              <td className="col-title" data-label="Study">
                                <Link
                                  to={rowPath}
                                  className="row-title"
                                  title={opportunity.title}
                                  data-study-id={opportunity.id}
                                >
                                  {opportunity.title}
                                </Link>
                                <div className="admin-study-meta">
                                  <span className={`admin-pill ${getTypeBadgeClass(opportunity.type)} badge--${opportunity.type}`}>
                                    {TypeGlyph && (
                                      <Icon icon={TypeGlyph} size={14} aria-hidden="true" className="lozenge__glyph" />
                                    )}
                                    {getAdminTypeLabel(opportunity.type)}
                                  </span>
                                  {showAllResearchers && owner && (
                                    <span className="admin-study-owner" title={`Owner: ${owner}`}>
                                      <span className="visually-hidden">Owner: </span>
                                      {owner}
                                    </span>
                                  )}
                                  <small className="row-desc" title={opportunity.purpose_one_liner}>
                                    {opportunity.purpose_one_liner}
                                  </small>
                                </div>
                              </td>
                              <td className="col-status" data-label="Status">
                                {/*
                                  Row 6: four seeded PUBLISHED studies fail their
                                  own publish readiness (no questions, no
                                  external link, no venue) while this cell read
                                  the same as any working study. One word,
                                  shared with the Review identity card
                                  (`ReviewStep.tsx`), for "published but not
                                  working" - computed here from what the
                                  dashboard's own list response already carries.
                                  See `isPublishedButNotWorking`'s own comment
                                  for the one class of breakage this cannot see
                                  from these fields alone (a native survey or
                                  unmoderated study with no content).
                                */}
                                <span
                                  className={`admin-pill admin-study-status admin-study-status--${opportunity.status}${
                                    notWorking ? ' admin-study-status--not-working' : ''
                                  }`}
                                >
                                  {/*
                                    A broken published study is marked OUTSIDE
                                    its label too (cto/AdaptaLabs#149): an amber
                                    fill and a warning glyph that does not
                                    shrink, so it is never the word alone. The
                                    label is "Broken" since #157 and fits the
                                    pill, but the fill and glyph are the Draft
                                    pill's and do not say "published" - so a
                                    visually hidden prefix gives a screen reader
                                    "Published, Broken", and the `title` gives
                                    hover the full meaning. The glyph is
                                    decorative beside them.
                                  */}
                                  {notWorking && (
                                    <Icon
                                      icon={AlertTriangle}
                                      size={14}
                                      aria-hidden="true"
                                      className="admin-study-status__glyph"
                                    />
                                  )}
                                  {notWorking && (
                                    <span className="visually-hidden">{PUBLISHED_NOT_WORKING_PREFIX}</span>
                                  )}
                                  <span
                                    className="admin-study-status__label"
                                    title={notWorking ? PUBLISHED_NOT_WORKING_DESCRIPTION : statusLabel}
                                  >
                                    {statusLabel}
                                  </span>
                                </span>
                                {isAutoClosed(opportunity) && (
                                  <span className="admin-pill admin-pill--auto-closed">Auto-closed</span>
                                )}
                              </td>
                              {/* Progress: booked / capacity across the study's sessions, with
                                  the same progress bar and percentage the Recruitment cell drew.
                                  A published or closed study the server counts clicks for shows
                                  them instead (the old Clicks column). Anything else - a draft,
                                  a study with no sessions and no click count - shows the muted
                                  dash. */}
                              <td className="col-progress" data-label="Progress">
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
                                ) : clicks !== undefined ? (
                                  <span className="admin-progress-clicks">
                                    {clicks} {clicks === 1 ? 'click' : 'clicks'}
                                  </span>
                                ) : (
                                  <span className="admin-cell-empty">–</span>
                                )}
                              </td>
                              {/* Next session / deadline: the soonest upcoming slot, else a future
                                  closing time, else "Completed" once every slot has passed. All
                                  from real fields - no invented session ordinal. */}
                              {/* The date on its own line ("Thu 24 Sept", the year only
                                  when it is not this one); a session's clock time leads
                                  the second line, before its relative day. The note
                                  turns warning colour inside CLOSING_SOON_DAYS - the
                                  same horizon as the Closing soon chip and card. */}
                              <td className="col-next" data-label="Next / deadline">
                                {milestone ? (
                                  <div className="admin-next">
                                    <span className="admin-next__date">
                                      {formatStudyDateCompact(milestone.date, now)}
                                    </span>
                                    <span
                                      className={`admin-next__note admin-next__note--${milestone.kind}${
                                        isNextNoteWarned(opportunity, now) ? ' admin-next__note--soon' : ''
                                      }`}
                                    >
                                      {milestone.kind === 'session' ? (
                                        <>
                                          <span className="admin-next__time">{formatClockTime(milestone.date.toISOString())}</span>
                                          {sessionDayLabel && ` · ${sessionDayLabel}`}
                                        </>
                                      ) : milestone.kind === 'completed' ? (
                                        'Completed'
                                      ) : milestone.kind === 'closed' ? (
                                        // Closed by hand before this date: nothing is
                                        // ahead of it, so no countdown and no colour.
                                        'Closed early'
                                      ) : (
                                        `Closes · ${getTimeRemainingUntil(milestone.date).text ?? 'soon'}`
                                      )}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="admin-cell-empty">–</span>
                                )}
                              </td>
                              <td className="col-date" data-label="Created">
                                <small className="admin-cell-metadata">
                                  {formatStudyDateCompact(opportunity.created_at, now)}
                                </small>
                              </td>
                              <td className="col-actions" data-label="Actions">
                                <div className="admin-action-group">
                                  {/* The next thing to do to the study (Petra 3.4), for
                                      someone who can act on it: Fix a broken one, Edit a
                                      draft, Analytics for a live or closed one. Anyone
                                      else gets Preview as a participant. A link, because
                                      every one of these is a page: a modifier-click
                                      opens a new tab. Named with the study, so a list
                                      of links reads "Fix: <title>", not "Fix, Fix". */}
                                  <Link
                                    to={primaryAction.to}
                                    className={`btn btn-outline-secondary btn-sm admin-action-primary${
                                      primaryAction.label === 'Fix' ? ' admin-action-primary--fix' : ''
                                    }`}
                                    aria-label={`${primaryAction.label}: ${opportunity.title}`}
                                    onClick={(e) => {
                                      // Not the second click of a double-click, nor
                                      // while a Close is in flight (see the row's
                                      // own guard). Modifier clicks pass through.
                                      if (e.detail > 1 || closeUndo.isCloseInFlight()) e.preventDefault();
                                    }}
                                  >
                                    {primaryAction.label === 'Fix' && (
                                      <Icon icon={AlertTriangle} size={14} aria-hidden="true" />
                                    )}
                                    {primaryAction.label}
                                  </Link>
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
                                      <Icon icon={MoreVertical} size={16} aria-hidden="true" />
                                    </button>
                                  }
                                >
                                  {/* Everything, in one order (Petra 3.4): Edit, Preview
                                      as participant, Analytics, Copy | Close study |
                                      Delete. Items that go to a page are links (`to`).
                                      The participant page renders a draft for an admin
                                      (with a Draft badge), so Preview is live for drafts
                                      too. Edit is the owner's (or a superadmin's): the
                                      server refuses anyone else's save. */}
                                  {canManage ? (
                                    <DropdownItem to={editPath}>Edit</DropdownItem>
                                  ) : (
                                    <DropdownItem disabled title="Only the owner can edit this study">
                                      Edit
                                    </DropdownItem>
                                  )}
                                  <DropdownItem to={studyPreviewPath(opportunity.id)}>
                                    Preview as participant
                                  </DropdownItem>
                                  {/* Analytics for EVERY study type. The page always renders
                                      an Overview (views/clicks), and the moderated types (test,
                                      interview) reach their booked-participant roster only
                                      through here - gating this to poll/survey/unmoderated left
                                      that roster unreachable. Audit rows a04-row-actions-menu,
                                      a64-analytics-live-session-participants.

                                      Analytics is owner-scoped on the server (a non-owner gets a
                                      403), so the menu tells the truth up front: only the owner or
                                      a superadmin gets a live item, everyone else gets a disabled
                                      one naming who owns it (row 8). Under the beta all-admin
                                      switch that disables it on most rows for most viewers, by
                                      design. */}
                                  {canManage ? (
                                    <DropdownItem to={studyAnalyticsPath(opportunity.id)}>
                                      Analytics
                                    </DropdownItem>
                                  ) : (
                                    <DropdownItem
                                      disabled
                                      title={`Only ${opportunity.owner_name ?? 'the study owner'} can view analytics for this study`}
                                    >
                                      Analytics
                                    </DropdownItem>
                                  )}
                                  {/* Copy is the owner's too: the server refuses
                                      anyone else's with a 403. */}
                                  {canManage ? (
                                    <DropdownItem onClick={() => void handleDuplicate(opportunity)}>
                                      Copy
                                    </DropdownItem>
                                  ) : (
                                    <DropdownItem disabled title="Only the owner can copy this study">
                                      Copy
                                    </DropdownItem>
                                  )}
                                  {/* Close study: published studies only, and only for the
                                      owner or a superadmin - the server's own gate on a
                                      status change, the same one Analytics reads. Reversible,
                                      so an Undo notice rather than a confirm. */}
                                  {opportunity.status === 'published' && canManage && <DropdownDivider />}
                                  {opportunity.status === 'published' && canManage && (
                                    <DropdownItem onClick={() => void closeUndo.closeStudy(opportunity)}>
                                      Close study
                                    </DropdownItem>
                                  )}
                                  <DropdownDivider />
                                  {/* Delete: the server refuses anyone but the owner or a
                                      superadmin ("Only the owner can delete this study"), so
                                      offering it to anyone else only ends in an error after
                                      the confirm. Disabled with the reason, like Edit. */}
                                  {canManage ? (
                                    <DropdownItem className="text-danger" onClick={() => handleDelete(opportunity.id, opportunity.title)}>
                                      Delete
                                    </DropdownItem>
                                  ) : (
                                    <DropdownItem className="text-danger" disabled title="Only the owner can delete this study">
                                      Delete
                                    </DropdownItem>
                                  )}
                                </Dropdown>
                                </div>
                              </td>
                            </tr>
                            {/* Close study's notices, in place under the row they
                                are about (components/StudyRowNotices.tsx). */}
                            {noticeRow}
                            {copyNotice?.id === opportunity.id && (
                              <CopyNoticeRow
                                message={copyNotice.message}
                                tone={copyNotice.tone}
                                onRetry={() => {
                                  setCopyNotice({ ...copyNotice, tone: 'status', message: `Copied “${copyNotice.title}”` });
                                  void refreshAfterCopy(opportunity, true);
                                }}
                                onDismiss={() => dismissCopyNotice(opportunity.id)}
                                actionRef={copyRetryRef}
                              />
                            )}
                            {actionError && (
                              <StudyActionErrorRow
                                studyId={opportunity.id}
                                message={actionError.message}
                                onDismiss={closeUndo.dismissError}
                                errorRef={closeUndo.errorRef}
                              />
                            )}
                            </React.Fragment>
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
