import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { getOpportunityAnalytics, getOpportunity, getOpportunitySessionEvents, getOpportunitySurveyResults, opportunitySurveyResultsCsvUrl, type OpportunityAnalytics, type AnalyticsPeriod } from '../api/client';
import { SurveyResults, type SurveyResultsData } from '../components/survey/SurveyResults';
import { getActionMeaning } from '../utils/opportunityUtils';
import { Opportunity, SessionEvent } from '../api/types';
import ErrorState from '../components/ErrorState';
import SlowNeuralBackground from '../components/SlowNeuralBackground';
import SessionsTab from '../components/opportunity-analytics/SessionsTab';
import { ArrowLeft, Info } from 'lucide-react';

// Cortex Bar Chart component - pure CSS, no dependencies
// Supports CSS variables for theming
const BarChart: React.FC<{
  data: Array<{ label: string; value: number }>;
  maxValue?: number;
  height?: number;
  barColor?: string;
  showValues?: boolean;
}> = ({ data, maxValue, height = 200, barColor = 'var(--color-analytics-orange)', showValues = true }) => {
  const max = maxValue || Math.max(...data.map(d => d.value), 1);
  // Reserve space for value labels at top
  const topPadding = showValues ? 24 : 8;
  const bottomPadding = data.length > 14 ? 55 : 25;
  const availableHeight = height - topPadding - bottomPadding;
  
  return (
    <div style={{ 
      height: `${height}px`, 
      display: 'flex', 
      alignItems: 'flex-end', 
      gap: '2px', 
      padding: `${topPadding}px 4px ${bottomPadding}px`,
      position: 'relative'
    }}>
      {data.map((item, index) => {
        const barHeight = max > 0 ? (item.value / max) * availableHeight : 0;
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
  icon?: string;
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
  const [activeTab, setActiveTab] = useState<'overview' | 'sessions' | 'results'>('overview');
  const [sessionEvents, setSessionEvents] = useState<SessionEvent[]>([]);
  const [loadingSessionEvents, setLoadingSessionEvents] = useState(false);
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
        setError('You do not have permission to view analytics for this opportunity');
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
          ? 'Only the opportunity owner can view these responses'
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
        setError('Opportunity not found');
      } else if (axiosError.response?.status === 403) {
        setError('You do not have permission to view analytics for this opportunity');
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

  // Generate chart data with all days in period (including zeros)
  const getChartData = () => {
    if (!analytics?.clicks_by_day || !Array.isArray(analytics.clicks_by_day)) return [];
    
    const data: Array<{ label: string; value: number; views: number; actions: number }> = [];
    const today = new Date();
    const clicksMap = new Map(analytics.clicks_by_day.map(d => [d.date, { count: d.count, views: d.views || 0, actions: d.actions || 0 }]));
    
    for (let i = selectedPeriod - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const label = date.toLocaleDateString('en-GB', { 
        day: 'numeric', 
        month: 'short' 
      });
      const dayData = clicksMap.get(dateStr) || { count: 0, views: 0, actions: 0 };
      data.push({
        label,
        value: dayData.count,
        views: dayData.views,
        actions: dayData.actions
      });
    }
    
    return data;
  };

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
              message={error || 'Opportunity not found'}
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
    (opportunity.type === 'poll' || opportunity.type === 'survey') &&
    Boolean(opportunity.firsthand_study_id);

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
          {/* Sessions for a FirstHand-linked unmoderated study; Responses for a
              natively-answered poll or survey. Mutually exclusive by type, so
              the strip carries Overview plus whichever applies. */}
          {(showsSessions || showsResults) && (
            <div className="cortex-date-selector" role="tablist" aria-label="Analytics section">
              <button
                role="tab"
                type="button"
                className={`cortex-period-btn ${activeTab === 'overview' ? 'cortex-period-btn--active' : ''}`}
                aria-selected={activeTab === 'overview'}
                onClick={() => setActiveTab('overview')}
              >
                Overview
              </button>
              {showsSessions && (
                <button
                  role="tab"
                  type="button"
                  className={`cortex-period-btn ${activeTab === 'sessions' ? 'cortex-period-btn--active' : ''}`}
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
              )}
              {showsResults && (
                <button
                  role="tab"
                  type="button"
                  className={`cortex-period-btn ${activeTab === 'results' ? 'cortex-period-btn--active' : ''}`}
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
              )}
            </div>
          )}

          {/* Period Selector - only shown in overview tab */}
          {activeTab === 'overview' && (
            <div className="cortex-date-selector cortex-period-selector" role="group" aria-label="Time period">
              {([7, 14, 30] as AnalyticsPeriod[]).map((period) => (
                <button
                  key={period}
                  type="button"
                  className={`cortex-period-btn ${selectedPeriod === period ? 'cortex-period-btn--active' : ''}`}
                  onClick={() => handlePeriodChange(period)}
                >
                  {period}d
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

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
      ) : loadingAnalytics ? (
        <div className="text-center py-5">
          <div className="spinner-border text-primary" role="status">
            <span className="visually-hidden">Loading analytics...</span>
          </div>
        </div>
      ) : analytics ? (
        <>
          {/* Primary Stats - Cortex Bento Grid */}
          <div className="cortex-analytics-grid" style={{ marginBottom: '24px' }}>
            {/* Views Card - NEUTRAL color (no inline color) */}
            <div className="cortex-analytics-card">
              <div className="cortex-analytics-card-header">
                <h6 className="cortex-analytics-card-title">Study Views</h6>
                <span className="cortex-analytics-card-icon">👁️</span>
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
                <span className="cortex-analytics-card-icon">🎯</span>
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
                <span className="cortex-analytics-card-icon">📈</span>
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
                <span className="cortex-analytics-card-icon">👤</span>
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
              icon="📊"
            />
            <StatCard 
              title="Last 7 Days" 
              value={analytics?.clicks_7d ?? 0}
              subtitle={weekChange === null ? 'no previous week to compare' : `${weekChange >= 0 ? '+' : ''}${weekChange}% vs prev week`}
              trend={analytics?.week_over_week_change ?? 0}
              icon="📅"
            />
            <StatCard 
              title="Last 24 Hours" 
              value={analytics?.clicks_24h ?? 0}
              icon="⚡"
            />
            <StatCard 
              title="Avg Daily" 
              value={analytics?.avg_clicks_per_day ?? 0}
              subtitle="Clicks per day"
              icon="📈"
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
                <span className="cortex-chart-subtitle">Total: {analytics?.period_views_total ?? 0} ({selectedPeriod}d)</span>
              </div>
              <div className="cortex-chart-container">
                {viewsChartData.length > 0 && viewsChartData.some(d => d.value > 0) ? (
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
                <span className="cortex-chart-subtitle">Total: {analytics?.period_actions_total ?? 0} ({selectedPeriod}d)</span>
              </div>
              <div className="cortex-chart-container">
                {actionsChartData.length > 0 && actionsChartData.some(d => d.value > 0) ? (
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
              <span className="cortex-chart-subtitle">Avg: {analytics?.avg_clicks_per_day ?? 0}/day</span>
            </div>
            <div className="cortex-chart-container" style={{ minHeight: '220px' }}>
              {chartData.length > 0 && chartData.some(d => d.value > 0) ? (
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
                <h6 className="cortex-chart-title">⏱️ Clicks by Hour</h6>
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
                <h6 className="cortex-chart-title">📅 Clicks by Day of Week</h6>
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
              <h6 className="cortex-chart-title" style={{ marginBottom: '16px' }}>📌 Timeline</h6>
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
              <h6 className="cortex-chart-title" style={{ marginBottom: '16px' }}>⚡ Performance Summary</h6>
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
