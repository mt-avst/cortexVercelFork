import React, { useState, useEffect, useCallback } from 'react';
import {
  Eye, MousePointerClick, TrendingUp, Users,
  BarChart3, CalendarDays, History, Activity,
  Clock, Calendar, LineChart, Zap
} from 'lucide-react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { getOpportunityAnalytics, getOpportunity, getOpportunitySessionEvents, getOpportunitySurveyResults, getOpportunityBookings, updateBookingResearcherNotes, opportunitySurveyResultsCsvUrl, type OpportunityAnalytics, type AnalyticsPeriod } from '../api/client';
import { SurveyResults, type SurveyResultsData } from '../components/survey/SurveyResults';
import { getActionMeaning } from '../utils/opportunityUtils';
import { buildAnalyticsChartData } from '../utils/analyticsChart';
import { computeBarChartAxis } from '../utils/barChartAxis';
import { QUESTION_CARRYING_TYPES } from '@shared/firsthand/delivery';
import { Opportunity, SessionEvent, OpportunityBookingRow } from '../api/types';
import ErrorState from '../components/ErrorState';
import SlowNeuralBackground from '../components/SlowNeuralBackground';
import SessionsTab from '../components/opportunity-analytics/SessionsTab';
import ParticipantsTab from '../components/opportunity-analytics/ParticipantsTab';
import { useBookingArtifacts } from '../components/opportunity-analytics/useBookingArtifacts';
import { ArrowLeft, Info } from 'lucide-react';

// Width reserved for the y-axis value labels, left of the plot area.
const BAR_CHART_Y_AXIS_WIDTH = 30;

// Cortex Bar Chart component - pure CSS, no dependencies
// Supports CSS variables for theming
const BarChart: React.FC<{
  data: Array<{ label: string; value: number }>;
  maxValue?: number;
  height?: number;
  barColor?: string;
  showValues?: boolean;
}> = ({ data, maxValue, height = 200, barColor = 'var(--color-analytics-orange)', showValues = true }) => {
  const rawMax = maxValue || Math.max(...data.map(d => d.value), 1);
  // Bars and gridlines share ONE scale: a rounded ceiling with a few even
  // ticks, so a bar sits at a readable fraction of a stated axis rather than
  // only relative to its tallest neighbour.
  const { niceMax, ticks } = computeBarChartAxis(rawMax);
  // Reserve space for value labels at top
  const topPadding = showValues ? 24 : 8;
  const bottomPadding = data.length > 14 ? 55 : 25;
  const availableHeight = height - topPadding - bottomPadding;

  // Distance from the top of the plot area to where a value sits on the scale.
  // A value-v bar's top and the tick for v resolve to the same y, so bars meet
  // their gridlines exactly.
  const yForValue = (value: number) => topPadding + (1 - value / niceMax) * availableHeight;

  return (
    <div style={{ display: 'flex', height: `${height}px`, width: '100%' }}>
      {/* Y axis - tick values aligned to the gridlines. Decorative: the bars
          carry the same numbers as labels and hover titles. */}
      <div aria-hidden="true" style={{ position: 'relative', width: `${BAR_CHART_Y_AXIS_WIDTH}px`, flexShrink: 0 }}>
        {ticks.map((tick) => (
          <span
            key={tick}
            style={{
              position: 'absolute',
              right: '6px',
              top: `${yForValue(tick)}px`,
              transform: 'translateY(-50%)',
              fontSize: '0.6rem',
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--text-muted)',
              lineHeight: 1
            }}
          >
            {tick}
          </span>
        ))}
      </div>

      {/* Plot area - gridlines sit behind the bars, the baseline (tick 0) reads
          a touch stronger than the gridlines above it. */}
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        {ticks.map((tick) => (
          <div
            key={tick}
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${yForValue(tick)}px`,
              borderTop: tick === 0
                ? '1px solid var(--border-strong-current, var(--border-subtle-current))'
                : '1px dashed var(--border-subtle-current)',
              opacity: tick === 0 ? 0.9 : 0.55
            }}
          />
        ))}

        <div style={{
          height: `${height}px`,
          display: 'flex',
          alignItems: 'flex-end',
          gap: '2px',
          padding: `${topPadding}px 4px ${bottomPadding}px`,
          position: 'relative'
        }}>
          {data.map((item, index) => {
            const barHeight = niceMax > 0 ? (item.value / niceMax) * availableHeight : 0;
            return (
              <div
                key={index}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  minWidth: 0,
                  position: 'relative'
                }}
              >
                {showValues && item.value > 0 && (
                  <span style={{
                    fontSize: '0.65rem',
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--text-muted)',
                    marginBottom: '4px',
                    whiteSpace: 'nowrap',
                    position: 'absolute',
                    top: `-${topPadding - 4}px`
                  }}>
                    {item.value}
                  </span>
                )}
                <div
                  style={{
                    width: '100%',
                    maxWidth: '40px',
                    height: `${barHeight}px`,
                    backgroundColor: barColor,
                    borderRadius: '3px 3px 0 0',
                    transition: 'height 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                    minHeight: item.value > 0 ? '4px' : '0',
                    opacity: item.value > 0 ? 1 : 0.3
                  }}
                  title={`${item.label}: ${item.value} clicks`}
                />
                <span style={{
                  fontSize: '0.6rem',
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--text-muted)',
                  marginTop: '4px',
                  writingMode: data.length > 14 ? 'vertical-rl' : 'horizontal-tb',
                  textOrientation: 'mixed',
                  transform: data.length > 14 ? 'rotate(180deg)' : 'none',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: '100%',
                  height: data.length > 14 ? '50px' : 'auto',
                  position: 'absolute',
                  bottom: `-${bottomPadding - 4}px`
                }}>
                  {item.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/**
 * Cortex StatCard Component
 * 
 * COLOR DISCIPLINE:
 * - All stat values are NEUTRAL by default (white in dark, slate-900 in light)
 * - Use accent=true ONLY for actionable metrics (e.g., Conversion Rate)
 */
const StatCard: React.FC<{
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: React.ReactNode;
  accent?: boolean;
  trend?: number;
}> = ({ title, value, subtitle, icon, accent = false, trend }) => (
  <div className="cortex-analytics-card">
    <div className="cortex-analytics-card-header">
      <h6 className="cortex-analytics-card-title">{title}</h6>
      {icon && <span className="cortex-analytics-card-icon">{icon}</span>}
    </div>
    <div className="cortex-analytics-card-content">
      <div className="d-flex align-items-baseline gap-2">
        {/* ENFORCED: Only accent class adds color, otherwise neutral */}
        <h2 className={`cortex-stat-value cortex-stat-value--sm ${accent ? 'cortex-stat-value--accent' : ''}`}>
          {value}
        </h2>
        {trend !== undefined && trend !== 0 && (
          <span className={`cortex-stat-trend ${trend > 0 ? 'cortex-stat-trend--positive' : 'cortex-stat-trend--negative'}`}>
            {trend > 0 ? '↑' : '↓'} {Math.abs(trend)}%
          </span>
        )}
      </div>
      {subtitle && <p className="cortex-stat-subtitle">{subtitle}</p>}
    </div>
  </div>
);

const OpportunityAnalyticsPage: React.FC = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useAuth();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  
  const [opportunity, setOpportunity] = useState<Opportunity | null>(null);
  const [analytics, setAnalytics] = useState<OpportunityAnalytics | null>(null);
  const [loadingOpportunity, setLoadingOpportunity] = useState(true);
  const [loadingAnalytics, setLoadingAnalytics] = useState(true);
  const [error, setError] = useState<string>('');
  const [selectedPeriod, setSelectedPeriod] = useState<AnalyticsPeriod>(30);
  const [activeTab, setActiveTab] = useState<'overview' | 'sessions' | 'results' | 'participants'>('overview');
  const [sessionEvents, setSessionEvents] = useState<SessionEvent[]>([]);
  const [loadingSessionEvents, setLoadingSessionEvents] = useState(false);
  const [bookings, setBookings] = useState<OpportunityBookingRow[]>([]);
  const [loadingBookings, setLoadingBookings] = useState(false);
  const [bookingsError, setBookingsError] = useState('');
  // Unsaved researcher notes, held HERE rather than inside ParticipantsTab.
  // This component survives its own loading states; everything it renders
  // does not, because the opportunity refetch below early-returns a spinner.
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  // Booking artefact state (#79 step 3), held here for the same reason as the
  // note drafts: an upload in flight and a half-typed attestation must
  // survive the refetch spinner unmounting the tab.
  const bookingArtifacts = useBookingArtifacts();
  const [surveyResults, setSurveyResults] = useState<{ title: string; results: SurveyResultsData } | null>(null);
  const [loadingSurveyResults, setLoadingSurveyResults] = useState(false);
  const [surveyResultsError, setSurveyResultsError] = useState('');

  const loadAnalytics = useCallback(async (period: AnalyticsPeriod) => {
    if (!id) return;
    setLoadingAnalytics(true);
    try {
      const data = await getOpportunityAnalytics(id, period);
      setAnalytics(data);
    } catch (err: unknown) {
      const axiosError = err as { response?: { status?: number } };
      if (axiosError.response?.status === 403) {
        setError('You do not have permission to view analytics for this study');
      }
    } finally {
      setLoadingAnalytics(false);
    }
  }, [id]);

  const loadSessionEvents = useCallback(async () => {
    if (!id) return;
    setLoadingSessionEvents(true);
    try {
      const events = await getOpportunitySessionEvents(id);
      setSessionEvents(events);
    } catch {
      // Non-fatal: session events tab will show empty state
    } finally {
      setLoadingSessionEvents(false);
    }
  }, [id]);

  const loadSurveyResults = useCallback(async () => {
    if (!id) return;
    setLoadingSurveyResults(true);
    setSurveyResultsError('');
    try {
      setSurveyResults(await getOpportunitySurveyResults(id));
    } catch (err: unknown) {
      // Said out loud rather than swallowed into an empty state. "No answers
      // yet" and "you are not allowed to see the answers" are different
      // findings, and rendering the first for the second is a lie a researcher
      // would act on.
      const response = (
        err as { response?: { status?: number; data?: { code?: string } } }
      ).response;

      /**
       * BRANCHED ON THE CODE, NOT THE STATUS, and that is a correction.
       *
       * The first version matched `status === 503` and told the reader to wait
       * a few seconds. This route answers 503 for at least three different
       * things, and only two of them clear:
       *
       *  - RESULTS_READ_QUEUE_FULL and RUNTIME_POOL_ADMISSION_TIMEOUT are
       *    congestion, and clear in seconds
       *  - `surveyResultsAreReadable()` false is a deployment with no runtime
       *    persistence configured, which will still be false tomorrow
       *  - DB_CONNECTION_FAILED is somewhere in between and not ours to
       *    promise about
       *
       * So a researcher on a misconfigured backend was told to retry, forever.
       * The two transient ones carry a code precisely so they can be told
       * apart; the durable one carries none.
       */
      const busy =
        response?.data?.code === 'RESULTS_READ_QUEUE_FULL' ||
        response?.data?.code === 'RUNTIME_POOL_ADMISSION_TIMEOUT';

      /**
       * THE READER'S OWN OTHER READS, which is a different sentence.
       *
       * `RESULTS_READ_USER_BUSY` (429) means this reader is already at their own
       * in-flight limit - two results reads, so a CSV download still draining
       * plus one more. Folding it into `busy` above would tell them the server
       * is congested, which is false and sends them to look at the wrong thing;
       * folding it into the fallback would say "could not load the responses",
       * which says nothing at all. Naming the cause is the only version they can
       * act on.
       *
       * Deliberately not naming the NUMBER. The limit is two today and the
       * measurement that chose it could choose differently; a message quoting
       * it would go stale silently, and this is the file least likely to be
       * updated when it does.
       */
      const yourOwnReadsAreRunning =
        response?.data?.code === 'RESULTS_READ_USER_BUSY';

      setSurveyResultsError(
        response?.status === 403
          ? 'Only the study owner can view these responses'
          : yourOwnReadsAreRunning
            ? 'You already have responses loading. Wait for those to finish, then try again.'
            : busy
              ? 'The responses are busy being read right now. Wait a few seconds and try again.'
              : 'Could not load the responses'
      );
      setSurveyResults(null);
    } finally {
      setLoadingSurveyResults(false);
    }
  }, [id]);

  const loadBookings = useCallback(async () => {
    if (!id) return;
    setLoadingBookings(true);
    setBookingsError('');
    try {
      setBookings(await getOpportunityBookings(id));
    } catch (err: unknown) {
      // Same honesty rule as loadSurveyResults above: "nobody booked" and
      // "you may not see who booked" are different findings, and rendering
      // the empty state for a 403 is the lie a researcher would act on.
      const response = (err as { response?: { status?: number } }).response;
      setBookingsError(
        response?.status === 403
          ? 'Only the study owner can view its participants'
          : 'Could not load the participants'
      );
      setBookings([]);
    } finally {
      setLoadingBookings(false);
    }
  }, [id]);

  const saveResearcherNotes = useCallback(
    (bookingId: string, notes: string) => updateBookingResearcherNotes(bookingId, notes),
    []
  );

  const loadData = useCallback(async () => {
    if (!id) return;

    try {
      setLoadingOpportunity(true);
      const opp = await getOpportunity(id);
      setOpportunity(opp);

      // Analytics now available for all opportunity types
      // Views = users who clicked to see details
      // Actions = users who clicked action button (open link for polls/surveys, booked session for tests/interviews)
      await loadAnalytics(selectedPeriod);

      if (opp.type === 'unmoderated' && opp.firsthand_study_id) {
        void loadSessionEvents();
      }
    } catch (err: unknown) {
      const axiosError = err as { response?: { status?: number } };
      if (axiosError.response?.status === 404) {
        setError('Study not found');
      } else if (axiosError.response?.status === 403) {
        setError('You do not have permission to view analytics for this study');
      } else {
        setError('Failed to load analytics');
      }
    } finally {
      setLoadingOpportunity(false);
    }
  }, [id, loadAnalytics, loadSessionEvents, selectedPeriod]);

  useEffect(() => {
    if (!loading && !user) {
      return;
    }
    if (id) {
      loadData();
    }
  }, [id, user, loading, loadData]);

  const handlePeriodChange = (period: AnalyticsPeriod) => {
    setSelectedPeriod(period);
    loadAnalytics(period);
  };

  // Format date for display
  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Every day in the period, zero-filled, keyed and labelled in the analytics
  // zone so each entry lines up with the backend's clicks_by_day dates. See
  // utils/analyticsChart.ts for why the axis must not be cut in UTC here.
  //
  // The chart headers below sum THIS series rather than the backend's
  // period_*_total (#124). The backend counts a rolling period*24h window that
  // spans period+1 in-zone dates, so a click on the oldest boundary day landed
  // in the header total with no bar to sit in - a flat chart under a positive
  // "Total: N". Summing the plotted days makes header == bars by construction:
  // the boundary-day click is outside the drawn `period` calendar days and so
  // is counted by neither. period_*_total stays on the wire but no longer feeds
  // any header here.
  const getChartData = () =>
    buildAnalyticsChartData(analytics?.clicks_by_day, selectedPeriod, analytics?.time_zone || undefined);

  // Get views-only chart data
  const getViewsChartData = () => {
    const data = getChartData();
    return data.map(d => ({ label: d.label, value: d.views }));
  };

  // Get actions-only chart data
  const getActionsChartData = () => {
    const data = getChartData();
    return data.map(d => ({ label: d.label, value: d.actions }));
  };

  // Get hourly chart data
  const getHourlyData = () => {
    if (!analytics?.clicks_by_hour || !Array.isArray(analytics.clicks_by_hour)) return [];
    
    const hourMap = new Map(analytics.clicks_by_hour.map(h => [h.hour, h.count]));
    const data: Array<{ label: string; value: number }> = [];
    
    for (let h = 0; h < 24; h++) {
      data.push({
        label: `${h}:00`,
        value: hourMap.get(h) || 0
      });
    }
    
    return data;
  };

  // Get weekday chart data
  const getWeekdayData = () => {
    if (!analytics?.clicks_by_weekday || !Array.isArray(analytics.clicks_by_weekday)) return [];
    
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayMap = new Map(analytics.clicks_by_weekday.map(d => [d.weekday_num, d.count]));
    
    return weekdays.map((day, i) => ({
      label: day,
      value: dayMap.get(i) || 0
    }));
  };

  // Redirect if not authenticated
  if (!loading && !user) {
    return <Navigate to="/" replace />;
  }

  // Show loading state
  if (loading || loadingOpportunity) {
    return (
      <div className="loading-container">
        <div className="text-center">
          <div className="spinner-border text-primary" role="status">
            <span className="visually-hidden">Loading...</span>
          </div>
          <p className="mt-3 text-muted">Loading analytics...</p>
        </div>
      </div>
    );
  }

  // Show error state
  if (error || !opportunity) {
    return (
      <div className="container py-5">
        <div className="row">
          <div className="col-12">
            <button
              className="btn btn-outline-secondary mb-4"
              onClick={() => navigate('/admin')}
            >
              <ArrowLeft size={16} className="me-2" />
              Back to Admin Dashboard
            </button>
            <ErrorState 
              title="Unable to Load Analytics"
              message={error || 'Study not found'}
              onAction={() => loadData()}
              actionLabel="Retry"
            />
          </div>
        </div>
      </div>
    );
  }

  const chartData = getChartData();
  const viewsChartData = getViewsChartData();
  const actionsChartData = getActionsChartData();
  const hourlyData = getHourlyData();
  const weekdayData = getWeekdayData();

  // Totals DERIVED from the plotted series (see getChartData's note on #124):
  // each chart header reads exactly the sum of the bars beneath it, and each
  // empty state is gated on that same sum, so a chart can never read "No views
  // recorded" under a positive total or vice versa.
  const viewsSeriesTotal = viewsChartData.reduce((sum, day) => sum + day.value, 0);
  const actionsSeriesTotal = actionsChartData.reduce((sum, day) => sum + day.value, 0);
  const clicksSeriesTotal = chartData.reduce((sum, day) => sum + day.value, 0);
  const avgClicksPerDay =
    selectedPeriod > 0 ? Math.round((clicksSeriesTotal / selectedPeriod) * 10) / 10 : 0;

  // Null means the previous week had nothing, so there is no percentage change
  // to state. `?? 0` here would have been the same lie in a different place.
  const weekChange = analytics?.week_over_week_change ?? null;

  const showsSessions =
    opportunity.type === 'unmoderated' && Boolean(opportunity.firsthand_study_id);

  // A linked study is the condition, NOT `delivery_mode === 'native'`.
  //
  // Switching a survey to external delivery leaves the study linked and leaves
  // every answer already collected exactly where it was - and the backend
  // serves them regardless of delivery mode, deliberately, because they are
  // still this researcher's data. Gating the tab on the mode meant a survey
  // that collected answers natively and later moved to SurveyMonkey lost the
  // only route to its own results, silently, with the rows still in the
  // database and the endpoint still answering. Found by the phase 4e code
  // review, which noticed this contradicted the backend's own comment.
  //
  // An externally-delivered poll that never ran natively has no linked study
  // at all, so it does not reach this either way.
  const showsResults =
    QUESTION_CARRYING_TYPES.has(opportunity.type) &&
    Boolean(opportunity.firsthand_study_id);

  // The two moderated types (#79). Unconditional for them, unlike the two
  // gates above, because a booked roster needs no linked study to exist -
  // the booking system IS their data path, and an empty roster renders as an
  // honest empty state rather than a missing tab.
  const showsParticipants =
    opportunity.type === 'test' || opportunity.type === 'interview';

  return (
    <div className="analytics-page-wrapper" style={{ position: 'relative', minHeight: '100vh' }}>
      {/* Theme-aware Background: Dark Mode gets neural particles on black */}
      {isDark && <SlowNeuralBackground />}
      
      <div className="container-fluid py-4 analytics-container">
      {/* Back Button - Above header */}
      <button
        className="btn btn-outline-secondary btn-sm"
        onClick={() => navigate('/admin')}
        style={{ 
          borderRadius: '6px',
          fontSize: '0.8125rem',
          fontWeight: '500',
          marginBottom: '1.5rem'
        }}
      >
        <ArrowLeft size={14} style={{ marginRight: '6px' }} />
        Back to Dashboard
      </button>

      {/* Header - Cortex Page Header Structure */}
      <div className="cortex-page-header">
        <div className="cortex-title-block">
          <h1 className="cortex-brand-title">
            Cortex<span className="cortex-admin-separator">|</span><span className="cortex-admin-suffix">Analytics</span>
          </h1>
          <p>
            Context: <span className="cortex-highlight-orange">{opportunity.title}</span>
          </p>
          {/* Say which zone the day boundaries are in. These charts are quoted
              at other people, so they are cut in ONE organisation zone rather
              than reshaping themselves for whoever opened them - and a reader
              in another zone needs to be told that, not left to assume. */}
          {analytics?.time_zone && (
            <p className="cortex-stat-subtitle" style={{ marginTop: '-4px' }}>
              Days and hours are counted in {analytics.time_zone.replace(/_/g, ' ')} time
            </p>
          )}
        </div>
        
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {/* Period Selector - only meaningful on the overview tab, but kept
              mounted (just hidden) on the others so it keeps reserving its
              width rather than unmounting and reflowing this row. */}
          <div
            className="cortex-date-selector cortex-period-selector"
            role="group"
            aria-label="Time period"
            aria-hidden={activeTab !== 'overview'}
            style={activeTab !== 'overview' ? { visibility: 'hidden' } : undefined}
          >
            {([7, 14, 30] as AnalyticsPeriod[]).map((period) => (
              <button
                key={period}
                type="button"
                tabIndex={activeTab === 'overview' ? 0 : -1}
                className={`cortex-period-btn ${selectedPeriod === period ? 'cortex-period-btn--active' : ''}`}
                onClick={() => handlePeriodChange(period)}
              >
                {period}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Section tabs - own full-width strip below the header, matching the
          underline tab style used on the main admin dashboard (Admin.tsx)
          rather than the pill/segmented look shared with the Period
          Selector above. A content-switching control reads as a switch
          between whole sections this way, distinct from the date filter
          it used to sit flush against. */}
      {(showsSessions || showsResults || showsParticipants) && (
        <div
          className="admin-tabs-container"
          style={{ borderBottom: '1px solid var(--border-subtle-current)', marginBottom: 'var(--spacing-6)' }}
        >
          <ul className="nav nav-tabs" role="tablist" aria-label="Analytics section" style={{ border: 'none', margin: 0 }}>
            <li className="nav-item" role="presentation">
              <button
                type="button"
                className={`custom-tab-button ${activeTab === 'overview' ? 'active' : ''}`}
                role="tab"
                aria-selected={activeTab === 'overview'}
                onClick={() => setActiveTab('overview')}
              >
                Overview
              </button>
            </li>
            {showsSessions && (
              <li className="nav-item" role="presentation">
                <button
                  type="button"
                  className={`custom-tab-button ${activeTab === 'sessions' ? 'active' : ''}`}
                  role="tab"
                  aria-selected={activeTab === 'sessions'}
                  onClick={() => {
                    setActiveTab('sessions');
                    if (sessionEvents.length === 0) {
                      void loadSessionEvents();
                    }
                  }}
                >
                  Sessions
                </button>
              </li>
            )}
            {showsResults && (
              <li className="nav-item" role="presentation">
                <button
                  type="button"
                  className={`custom-tab-button ${activeTab === 'results' ? 'active' : ''}`}
                  role="tab"
                  aria-selected={activeTab === 'results'}
                  onClick={() => {
                    setActiveTab('results');
                    // Refetched on every visit rather than cached on first
                    // load: answers arrive while the researcher has the page
                    // open, and a stale tally is the one thing this view must
                    // not show.
                    void loadSurveyResults();
                  }}
                >
                  Responses
                </button>
              </li>
            )}
            {showsParticipants && (
              <li className="nav-item" role="presentation">
                <button
                  type="button"
                  className={`custom-tab-button ${activeTab === 'participants' ? 'active' : ''}`}
                  role="tab"
                  aria-selected={activeTab === 'participants'}
                  onClick={() => {
                    setActiveTab('participants');
                    // Refetched on every visit, same reasoning as Responses:
                    // bookings arrive while the page is open, and a stale
                    // roster is the one thing this view must not show.
                    void loadBookings();
                  }}
                >
                  Participants
                </button>
              </li>
            )}
          </ul>
        </div>
      )}

      {activeTab === 'results' ? (
        loadingSurveyResults ? (
          <div className="text-center py-5">
            <div className="spinner-border text-primary" role="status">
              <span className="visually-hidden">Loading responses...</span>
            </div>
          </div>
        ) : surveyResultsError ? (
          <ErrorState
            title="Unable to Load Responses"
            message={surveyResultsError}
            onAction={() => loadSurveyResults()}
            actionLabel="Retry"
          />
        ) : surveyResults ? (
          <SurveyResults
            csvHref={opportunitySurveyResultsCsvUrl(id!)}
            results={surveyResults.results}
          />
        ) : null
      ) : activeTab === 'sessions' ? (
        <SessionsTab
          opportunityId={id!}
          events={sessionEvents}
          loading={loadingSessionEvents}
          onRefresh={loadSessionEvents}
        />
      ) : activeTab === 'participants' ? (
        // Unmounted with the tab, like its siblings. What must NOT die with
        // it - the unsaved note text - is held by this page instead, because
        // the opportunity refetch above early-returns a spinner that unmounts
        // this subtree anyway, so keeping the component mounted across tab
        // switches would have protected the note from one route of loss and
        // not the other.
        <ParticipantsTab
          bookings={bookings}
          loading={loadingBookings}
          error={bookingsError}
          onRefresh={loadBookings}
          onSaveNotes={saveResearcherNotes}
          drafts={noteDrafts}
          onDraftsChange={setNoteDrafts}
          artifacts={bookingArtifacts}
        />
      ) : loadingAnalytics ? (
        <div className="text-center py-5">
          <div className="spinner-border text-primary" role="status">
            <span className="visually-hidden">Loading analytics...</span>
          </div>
        </div>
      ) : analytics ? (
        <>
          {/* The tiles follow the period selector now (DA-19), so say so once:
              a "Study Views" of 6 over the last 7 days should not read as an
              all-time figure. Cards that carry their own 24h/7d window are
              exempted in the same breath. */}
          <p className="cortex-stat-subtitle" style={{ marginBottom: '12px' }}>
            Totals reflect the selected period ({selectedPeriod} days). Cards marked 24h or 7d show their own window.
          </p>

          {/* Primary Stats - Cortex Bento Grid */}
          <div className="cortex-analytics-grid" style={{ marginBottom: '24px' }}>
            {/* Views Card - NEUTRAL color (no inline color) */}
            <div className="cortex-analytics-card">
              <div className="cortex-analytics-card-header">
                <h6 className="cortex-analytics-card-title">Study Views</h6>
                <span className="cortex-analytics-card-icon"><Eye size={18} aria-hidden="true" /></span>
              </div>
              <div className="cortex-analytics-card-content">
                <p className="cortex-stat-subtitle" style={{ marginBottom: '8px' }}>Users who viewed details</p>
                <h2 className="cortex-stat-value">
                  {analytics?.views_total ?? 0}
                </h2>
                <div className="cortex-stat-metrics">
                  <span>24h: <strong>{analytics?.views_24h ?? 0}</strong></span>
                  <span>7d: <strong>{analytics?.views_7d ?? 0}</strong></span>
                  <span>Unique: <strong>{analytics?.unique_viewers ?? 0}</strong></span>
                </div>
              </div>
            </div>

            {/* Actions Card - NEUTRAL color (no inline color) */}
            <div className="cortex-analytics-card">
              <div className="cortex-analytics-card-header">
                <h6 className="cortex-analytics-card-title">Actions Taken</h6>
                <span className="cortex-analytics-card-icon"><MousePointerClick size={18} aria-hidden="true" /></span>
              </div>
              <div className="cortex-analytics-card-content">
                {/* What an action IS depends on the type. This said "Clicked
                    link / Booked" for every study, including recorded ones,
                    which have no link and nothing to book. */}
                <p className="cortex-stat-subtitle" style={{ marginBottom: '8px' }}>
                  {getActionMeaning(opportunity.type)}
                </p>
                <h2 className="cortex-stat-value">
                  {analytics?.actions_total ?? 0}
                </h2>
                <div className="cortex-stat-metrics">
                  <span>24h: <strong>{analytics?.actions_24h ?? 0}</strong></span>
                  <span>7d: <strong>{analytics?.actions_7d ?? 0}</strong></span>
                  <span>Unique: <strong>{analytics?.unique_actors ?? 0}</strong></span>
                </div>
              </div>
            </div>

            {/* Conversion Rate Card - ONLY card with accent color */}
            <div className="cortex-analytics-card">
              <div className="cortex-analytics-card-header">
                <h6 className="cortex-analytics-card-title">Conversion Rate</h6>
                <span className="cortex-analytics-card-icon"><TrendingUp size={18} aria-hidden="true" /></span>
              </div>
              <div className="cortex-analytics-card-content">
                {/* Left as "Actions" deliberately. The line under it reads
                    "N views → N actions", so naming the type's action here
                    instead made the card disagree with itself. The ACTIONS
                    TAKEN card is where an action gets its meaning. */}
                <p className="cortex-stat-subtitle" style={{ marginBottom: '8px' }}>Views → Actions</p>
                <h2 className="cortex-stat-value cortex-stat-value--accent">
                  {analytics?.conversion_rate ?? 0}%
                </h2>
                <div className="cortex-stat-metrics" style={{ flexDirection: 'column', gap: '4px' }}>
                  <span>{analytics?.views_total ?? 0} views → {analytics?.actions_total ?? 0} actions</span>
                  {/* A study with no previous week has no week-over-week figure.
                      It used to render "+100%" in green with an arrow, which is
                      what every study said from its first click, and what two
                      clicks claimed just as loudly as two thousand would. */}
                  <span>
                    Week change:{' '}
                    {weekChange === null ? (
                      <span className="cortex-stat-trend--none">no previous week to compare</span>
                    ) : (
                      <strong
                        className={`cortex-stat-trend ${weekChange >= 0 ? 'cortex-stat-trend--positive' : 'cortex-stat-trend--negative'}`}
                        style={{ marginLeft: '4px' }}
                      >
                        {weekChange >= 0 ? '+' : ''}{weekChange}%
                      </strong>
                    )}
                  </span>
                </div>
              </div>
            </div>

            {/* Unique Users Card - NEUTRAL color (no inline color) */}
            <div className="cortex-analytics-card">
              <div className="cortex-analytics-card-header">
                <h6 className="cortex-analytics-card-title">Unique Users</h6>
                <span className="cortex-analytics-card-icon"><Users size={18} aria-hidden="true" /></span>
              </div>
              <div className="cortex-analytics-card-content">
                <p className="cortex-stat-subtitle" style={{ marginBottom: '8px' }}>Distinct visitors</p>
                <h2 className="cortex-stat-value">
                  {analytics?.unique_users ?? 0}
                </h2>
              </div>
            </div>
          </div>

          {/* Secondary Stats Row - Cortex Grid */}
          <div className="cortex-analytics-grid" style={{ marginBottom: '24px' }}>
            <StatCard 
              title="Total Interactions" 
              value={analytics?.clicks_total ?? 0}
              subtitle="Views + Actions"
              icon={<BarChart3 size={18} aria-hidden="true" />}
            />
            <StatCard 
              title="Last 7 Days" 
              value={analytics?.clicks_7d ?? 0}
              subtitle={weekChange === null ? 'no previous week to compare' : `${weekChange >= 0 ? '+' : ''}${weekChange}% vs prev week`}
              trend={analytics?.week_over_week_change ?? 0}
              icon={<CalendarDays size={18} aria-hidden="true" />}
            />
            <StatCard 
              title="Last 24 Hours" 
              value={analytics?.clicks_24h ?? 0}
              icon={<History size={18} aria-hidden="true" />}
            />
            <StatCard 
              title="Avg Daily" 
              value={analytics?.avg_clicks_per_day ?? 0}
              subtitle="Clicks per day"
              icon={<Activity size={18} aria-hidden="true" />}
            />
          </div>

          {/* Main Charts - Cortex Grid with Spanning */}
          <div className="cortex-analytics-grid" style={{ marginBottom: '24px' }}>
            {/* Views Chart - Span 2 columns */}
            <div className="cortex-analytics-card span-2">
              <div className="cortex-chart-header">
                {/* The total follows the SELECTED period. It was pinned to
                    seven days while the title tracked the selector, so a 30-day
                    chart carried a 7-day number - and at 7d they agreed by
                    coincidence, which is exactly when nobody notices. */}
                <h5 className="cortex-chart-title">Study Views ({selectedPeriod}d)</h5>
                <span className="cortex-chart-subtitle">Total: {viewsSeriesTotal} ({selectedPeriod}d)</span>
              </div>
              <div className="cortex-chart-container">
                {/* Gated on the same total the subtitle prints, so the chart can
                    never read "No views recorded" under "Total: 3". */}
                {viewsSeriesTotal > 0 ? (
                  <BarChart
                    data={viewsChartData}
                    height={180}
                    barColor="var(--color-analytics-blue)"
                    showValues={selectedPeriod <= 14}
                  />
                ) : (
                  <div className="cortex-no-data">
                    <p>No views recorded</p>
                  </div>
                )}
              </div>
            </div>

            {/* Actions Chart - Span 2 columns */}
            <div className="cortex-analytics-card span-2">
              <div className="cortex-chart-header">
                <h5 className="cortex-chart-title">Actions Taken ({selectedPeriod}d)</h5>
                <span className="cortex-chart-subtitle">Total: {actionsSeriesTotal} ({selectedPeriod}d)</span>
              </div>
              <div className="cortex-chart-container">
                {actionsSeriesTotal > 0 ? (
                  <BarChart
                    data={actionsChartData}
                    height={180}
                    barColor="var(--color-analytics-green)"
                    showValues={selectedPeriod <= 14}
                  />
                ) : (
                  <div className="cortex-no-data">
                    <p>No actions recorded</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Combined Chart - Full Width (Span 4) */}
          <div className="cortex-analytics-card" style={{ marginBottom: '24px' }}>
            <div className="cortex-chart-header">
              <h5 className="cortex-chart-title">Total Interactions Over Time ({selectedPeriod} days)</h5>
              <span className="cortex-chart-subtitle">Avg: {avgClicksPerDay}/day</span>
            </div>
            <div className="cortex-chart-container" style={{ minHeight: '220px' }}>
              {clicksSeriesTotal > 0 ? (
                <BarChart
                  data={chartData.map(d => ({ label: d.label, value: d.value }))}
                  height={220}
                  barColor="var(--color-analytics-orange)"
                  showValues={selectedPeriod <= 30}
                />
              ) : (
                <div className="cortex-no-data">
                  <p>No interactions recorded in this period</p>
                </div>
              )}
            </div>
          </div>

          {/* Secondary Charts Row - Cortex Grid */}
          <div className="cortex-analytics-grid" style={{ marginBottom: '24px' }}>
            {/* Hourly Distribution - Span 2 */}
            <div className="cortex-analytics-card span-2">
              <div className="cortex-chart-header">
                <h6 className="cortex-chart-title"><Clock size={14} aria-hidden="true" />Clicks by Hour</h6>
                {analytics?.peak_hour && (
                  <span className="cortex-badge cortex-badge--peak">
                    Peak: {analytics.peak_hour.hour_label}
                  </span>
                )}
              </div>
              <div className="cortex-chart-container">
                {hourlyData.length > 0 && hourlyData.some(d => d.value > 0) ? (
                  <BarChart 
                    data={hourlyData} 
                    height={160}
                    barColor="var(--color-analytics-blue)"
                    showValues={false}
                  />
                ) : (
                  <div className="cortex-no-data">
                    <p>No data yet</p>
                  </div>
                )}
              </div>
            </div>

            {/* Day of Week Distribution - Span 2 */}
            <div className="cortex-analytics-card span-2">
              <div className="cortex-chart-header">
                <h6 className="cortex-chart-title"><Calendar size={14} aria-hidden="true" />Clicks by Day of Week</h6>
                {analytics?.clicks_by_weekday && analytics.clicks_by_weekday.length > 0 && (
                  <span className="cortex-badge cortex-badge--best">
                    Best: {analytics.clicks_by_weekday.reduce((max, d) => d.count > max.count ? d : max, analytics.clicks_by_weekday[0]).weekday}
                  </span>
                )}
              </div>
              <div className="cortex-chart-container">
                {weekdayData.length > 0 && weekdayData.some(d => d.value > 0) ? (
                  <BarChart 
                    data={weekdayData} 
                    height={160}
                    barColor="var(--color-analytics-green)"
                    showValues={true}
                  />
                ) : (
                  <div className="cortex-no-data">
                    <p>No data yet</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Additional Info Row - Cortex Grid */}
          <div className="cortex-analytics-grid">
            {/* Timeline Info - Span 2 */}
            <div className="cortex-analytics-card span-2">
              <h6 className="cortex-chart-title" style={{ marginBottom: '16px' }}><LineChart size={14} aria-hidden="true" />Timeline</h6>
              <div className="d-flex flex-column gap-3">
                <div className="d-flex justify-content-between">
                  <span className="cortex-stat-subtitle">Created:</span>
                  <span style={{ fontSize: '0.85rem', fontVariantNumeric: 'tabular-nums' }}>
                    {formatDate(analytics?.opportunity_created ?? null)}
                  </span>
                </div>
                <div className="d-flex justify-content-between">
                  <span className="cortex-stat-subtitle">First Click:</span>
                  <span style={{ fontSize: '0.85rem', fontVariantNumeric: 'tabular-nums' }}>
                    {formatDate(analytics?.first_click ?? null)}
                  </span>
                </div>
                <div className="d-flex justify-content-between">
                  <span className="cortex-stat-subtitle">Last Click:</span>
                  <span style={{ fontSize: '0.85rem', fontVariantNumeric: 'tabular-nums' }}>
                    {formatDate(analytics?.last_click ?? null)}
                  </span>
                </div>
                {analytics?.peak_day && (
                  <div className="d-flex justify-content-between">
                    <span className="cortex-stat-subtitle">Peak Day:</span>
                    <span style={{ fontSize: '0.85rem', color: 'var(--color-analytics-orange)', fontWeight: '600' }}>
                      {new Date(analytics.peak_day.date).toLocaleDateString('en-GB', { 
                        day: 'numeric', 
                        month: 'short',
                        year: 'numeric'
                      })} ({analytics.peak_day.count} clicks)
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Performance Summary - Span 2 */}
            <div className="cortex-analytics-card span-2">
              <h6 className="cortex-chart-title" style={{ marginBottom: '16px' }}><Zap size={14} aria-hidden="true" />Performance Summary</h6>
              <div className="d-flex flex-column gap-3">
                <div className="d-flex justify-content-between align-items-center">
                  <span className="cortex-stat-subtitle">Average Daily Clicks:</span>
                  <span className="cortex-badge cortex-badge--info">
                    {analytics?.avg_clicks_per_day ?? 0}
                  </span>
                </div>
                <div className="d-flex justify-content-between align-items-center">
                  <span className="cortex-stat-subtitle">Click-to-User Ratio:</span>
                  <span className="cortex-badge cortex-badge--info">
                    {(analytics?.unique_users ?? 0) > 0 
                      ? ((analytics?.clicks_total ?? 0) / (analytics?.unique_users ?? 1)).toFixed(1) 
                      : '0'} clicks/user
                  </span>
                </div>
                {weekChange !== null && (
                  <div className="d-flex justify-content-between align-items-center">
                    <span className="cortex-stat-subtitle">Week-over-Week:</span>
                    <span className={`cortex-badge ${weekChange >= 0 ? 'cortex-badge--best' : ''}`}
                      style={weekChange < 0 ? { background: 'rgba(239, 68, 68, 0.15)', color: '#EF4444' } : undefined}
                    >
                      {weekChange >= 0 ? '+' : ''}{weekChange}%
                    </span>
                  </div>
                )}
                {analytics?.peak_hour && (
                  <div className="d-flex justify-content-between align-items-center">
                    <span className="cortex-stat-subtitle">Peak Hour:</span>
                    <span className="cortex-badge cortex-badge--peak">
                      {analytics.peak_hour.hour_label}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="alert alert-info d-flex align-items-center">
          <Info size={18} className="me-2" />
          No analytics data available
        </div>
      )}
      </div>
    </div>
  );
};

export default OpportunityAnalyticsPage;
