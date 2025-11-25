import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getOpportunityAnalytics, getOpportunity, type OpportunityAnalytics, type AnalyticsPeriod } from '../api/client';
import { Opportunity } from '../api/types';
import ErrorState from '../components/ErrorState';

// Simple bar chart component (pure CSS, no dependencies)
const BarChart: React.FC<{
  data: Array<{ label: string; value: number }>;
  maxValue?: number;
  height?: number;
  barColor?: string;
  showValues?: boolean;
}> = ({ data, maxValue, height = 200, barColor = '#ffaa50', showValues = true }) => {
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
                transition: 'height 0.3s ease',
                minHeight: item.value > 0 ? '4px' : '0'
              }}
              title={`${item.label}: ${item.value} clicks`}
            />
            <span style={{ 
              fontSize: '0.6rem', 
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

// Stat card component
const StatCard: React.FC<{
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: string;
  color?: string;
  trend?: number;
}> = ({ title, value, subtitle, icon, color = '#ffaa50', trend }) => (
  <div className="card border-0 shadow-sm h-100" style={{ 
    background: 'var(--card-bg)', 
    borderRadius: '12px' 
  }}>
    <div className="card-body" style={{ padding: '1.25rem' }}>
      <div className="d-flex justify-content-between align-items-start mb-2">
        <h6 className="text-muted mb-0" style={{ fontSize: '1.125rem', fontWeight: '600', textTransform: 'uppercase' }}>
          {title}
        </h6>
        {icon && (
          <span style={{ fontSize: '1.25rem', opacity: 0.7 }}>{icon}</span>
        )}
      </div>
      <div className="d-flex align-items-baseline gap-2">
        <h2 className="mb-0" style={{ fontSize: '2rem', fontWeight: 'bold', color }}>
          {value}
        </h2>
        {trend !== undefined && trend !== 0 && (
          <span style={{ 
            fontSize: '0.8rem', 
            fontWeight: '600',
            color: trend > 0 ? '#198754' : '#dc3545'
          }}>
            {trend > 0 ? '↑' : '↓'} {Math.abs(trend)}%
          </span>
        )}
      </div>
      {subtitle && (
        <p className="text-muted mb-0 mt-1" style={{ fontSize: '0.8rem' }}>
          {subtitle}
        </p>
      )}
    </div>
  </div>
);

const OpportunityAnalyticsPage: React.FC = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useAuth();
  
  const [opportunity, setOpportunity] = useState<Opportunity | null>(null);
  const [analytics, setAnalytics] = useState<OpportunityAnalytics | null>(null);
  const [loadingOpportunity, setLoadingOpportunity] = useState(true);
  const [loadingAnalytics, setLoadingAnalytics] = useState(true);
  const [error, setError] = useState<string>('');
  const [selectedPeriod, setSelectedPeriod] = useState<AnalyticsPeriod>(30);

  const loadAnalytics = useCallback(async (period: AnalyticsPeriod) => {
    if (!id) return;
    setLoadingAnalytics(true);
    try {
      const data = await getOpportunityAnalytics(id, period);
      setAnalytics(data);
    } catch (err: any) {
      console.error('Error loading analytics:', err);
      if (err.response?.status === 403) {
        setError('You do not have permission to view analytics for this opportunity');
      }
    } finally {
      setLoadingAnalytics(false);
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
    } catch (err: any) {
      console.error('Error loading data:', err);
      if (err.response?.status === 404) {
        setError('Opportunity not found');
      } else if (err.response?.status === 403) {
        setError('You do not have permission to view analytics for this opportunity');
      } else {
        setError('Failed to load analytics');
      }
    } finally {
      setLoadingOpportunity(false);
    }
  }, [id, loadAnalytics, selectedPeriod]);

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
      <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '400px' }}>
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
              <i className="bi bi-arrow-left me-2"></i>
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

  return (
    <div className="container-fluid py-4" style={{ maxWidth: '1400px' }}>
      {/* Header */}
      <div className="d-flex flex-wrap justify-content-between align-items-start mb-4 gap-3">
        <div>
          <button
            className="btn btn-outline-secondary mb-3"
            onClick={() => navigate('/admin')}
            style={{ fontSize: '0.9rem' }}
          >
            ← Back to Dashboard
          </button>
          <h1 className="h3 mb-2" style={{ color: 'var(--text-primary)' }}>
            Click Analytics
          </h1>
          <p className="text-muted mb-0" style={{ fontSize: '0.95rem' }}>
            Tracking engagement for <strong>{opportunity.title}</strong>
          </p>
        </div>
        
        {/* Period Selector */}
        <div className="btn-group" role="group" aria-label="Time period">
          {([7, 14, 30] as AnalyticsPeriod[]).map((period) => (
            <button
              key={period}
              type="button"
              className={`btn ${selectedPeriod === period ? 'btn-primary' : 'btn-outline-secondary'}`}
              onClick={() => handlePeriodChange(period)}
              style={{ fontSize: '0.85rem' }}
            >
              {period}d
            </button>
          ))}
        </div>
      </div>

      {loadingAnalytics ? (
        <div className="text-center py-5">
          <div className="spinner-border text-primary" role="status">
            <span className="visually-hidden">Loading analytics...</span>
          </div>
        </div>
      ) : analytics ? (
        <>
          {/* Views & Actions Summary */}
          <div className="row g-3 mb-4">
            {/* Views Card */}
            <div className="col-12 col-md-4">
              <div className="card border-0 shadow-sm h-100" style={{ background: 'var(--card-bg)', borderRadius: '12px' }}>
                <div className="card-body" style={{ padding: '1.25rem' }}>
                  <div className="mb-3">
                    <h6 className="text-muted mb-2" style={{ fontSize: '1.125rem', fontWeight: '600', textTransform: 'uppercase' }}>
                      Study Views
                    </h6>
                    <span className="lozenge lozenge-analytics" style={{ fontSize: '0.65rem', border: '1px solid #FF4E50' }}>Users who viewed details</span>
                  </div>
                  <div className="d-flex align-items-baseline gap-3 mb-2">
                    <h2 className="mb-0" style={{ fontSize: '2.25rem', fontWeight: 'bold', color: '#0d6efd' }}>
                      {analytics?.views_total ?? 0}
                    </h2>
                    <span className="text-muted" style={{ fontSize: '0.85rem' }}>total</span>
                  </div>
                  <div className="d-flex gap-3 text-muted" style={{ fontSize: '0.8rem' }}>
                    <span>24h: <strong>{analytics?.views_24h ?? 0}</strong></span>
                    <span>7d: <strong>{analytics?.views_7d ?? 0}</strong></span>
                    <span>Unique: <strong>{analytics?.unique_viewers ?? 0}</strong></span>
                  </div>
                </div>
              </div>
            </div>

            {/* Actions Card */}
            <div className="col-12 col-md-4">
              <div className="card border-0 shadow-sm h-100" style={{ background: 'var(--card-bg)', borderRadius: '12px' }}>
                <div className="card-body" style={{ padding: '1.25rem' }}>
                  <div className="mb-3">
                    <h6 className="text-muted mb-2" style={{ fontSize: '1.125rem', fontWeight: '600', textTransform: 'uppercase' }}>
                      Actions Taken
                    </h6>
                    <span className="lozenge lozenge-analytics" style={{ fontSize: '0.65rem', border: '1px solid #FF4E50' }}>Clicked link / Booked</span>
                  </div>
                  <div className="d-flex align-items-baseline gap-3 mb-2">
                    <h2 className="mb-0" style={{ fontSize: '2.25rem', fontWeight: 'bold', color: '#198754' }}>
                      {analytics?.actions_total ?? 0}
                    </h2>
                    <span className="text-muted" style={{ fontSize: '0.85rem' }}>total</span>
                  </div>
                  <div className="d-flex gap-3 text-muted" style={{ fontSize: '0.8rem' }}>
                    <span>24h: <strong>{analytics?.actions_24h ?? 0}</strong></span>
                    <span>7d: <strong>{analytics?.actions_7d ?? 0}</strong></span>
                    <span>Unique: <strong>{analytics?.unique_actors ?? 0}</strong></span>
                  </div>
                </div>
              </div>
            </div>

            {/* Conversion Rate Card */}
            <div className="col-12 col-md-4">
              <div className="card border-0 shadow-sm h-100" style={{ background: 'var(--card-bg)', borderRadius: '12px' }}>
                <div className="card-body" style={{ padding: '1.25rem' }}>
                  <div className="mb-3">
                    <h6 className="text-muted mb-2" style={{ fontSize: '1.125rem', fontWeight: '600', textTransform: 'uppercase' }}>
                      Conversion Rate
                    </h6>
                    <span className="lozenge lozenge-analytics" style={{ fontSize: '0.65rem', border: '1px solid #FF4E50' }}>Views → Actions</span>
                  </div>
                  <div className="d-flex align-items-baseline gap-3 mb-2">
                    <h2 className="mb-0" style={{ fontSize: '2.25rem', fontWeight: 'bold', color: '#ffaa50' }}>
                      {analytics?.conversion_rate ?? 0}%
                    </h2>
                  </div>
                  <div className="d-flex flex-column gap-1 text-muted" style={{ fontSize: '0.8rem' }}>
                    <span>
                      {analytics?.views_total ?? 0} views → {analytics?.actions_total ?? 0} actions
                    </span>
                    <span>
                      Week change: <strong className={(analytics?.week_over_week_change ?? 0) >= 0 ? 'text-success' : 'text-danger'}>
                        {(analytics?.week_over_week_change ?? 0) >= 0 ? '+' : ''}{analytics?.week_over_week_change ?? 0}%
                      </strong>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Secondary Stats Row */}
          <div className="row g-3 mb-4">
            <div className="col-6 col-md-3">
              <StatCard 
                title="Total Interactions" 
                value={analytics?.clicks_total ?? 0}
                subtitle="Views + Actions"
                color="#6f42c1"
              />
            </div>
            <div className="col-6 col-md-3">
              <StatCard 
                title="Last 7 Days" 
                value={analytics?.clicks_7d ?? 0}
                subtitle={`${(analytics?.week_over_week_change ?? 0) >= 0 ? '+' : ''}${analytics?.week_over_week_change ?? 0}% vs prev week`}
                color="#198754"
                trend={analytics?.week_over_week_change ?? 0}
              />
            </div>
            <div className="col-6 col-md-3">
              <StatCard 
                title="Last 24 Hours" 
                value={analytics?.clicks_24h ?? 0}
                color="#0d6efd"
              />
            </div>
            <div className="col-6 col-md-3">
              <StatCard 
                title="Unique Users" 
                value={analytics?.unique_users ?? 0}
                subtitle="Distinct visitors"
                color="#ffaa50"
              />
            </div>
          </div>

          {/* Main Charts - Views vs Actions */}
          <div className="row g-3 mb-4">
            {/* Views Chart */}
            <div className="col-12 col-lg-6">
              <div className="card border-0 shadow-sm h-100" style={{ background: 'var(--card-bg)', borderRadius: '12px' }}>
                <div className="card-body" style={{ padding: '1.25rem' }}>
                  <div className="d-flex justify-content-between align-items-center mb-3">
                    <h5 className="mb-0" style={{ color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: '600' }}>
                      Study Views ({selectedPeriod}d)
                    </h5>
                    <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                      Total: {analytics?.views_7d ?? 0} (7d)
                    </span>
                  </div>
                  {viewsChartData.length > 0 && viewsChartData.some(d => d.value > 0) ? (
                    <BarChart 
                      data={viewsChartData} 
                      height={180}
                      barColor="#0d6efd"
                      showValues={selectedPeriod <= 14}
                    />
                  ) : (
                    <div className="text-center py-4 text-muted">
                      <p className="mt-2 mb-0">No views recorded</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Actions Chart */}
            <div className="col-12 col-lg-6">
              <div className="card border-0 shadow-sm h-100" style={{ background: 'var(--card-bg)', borderRadius: '12px' }}>
                <div className="card-body" style={{ padding: '1.25rem' }}>
                  <div className="d-flex justify-content-between align-items-center mb-3">
                    <h5 className="mb-0" style={{ color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: '600' }}>
                      Actions Taken ({selectedPeriod}d)
                    </h5>
                    <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                      Total: {analytics?.actions_7d ?? 0} (7d)
                    </span>
                  </div>
                  {actionsChartData.length > 0 && actionsChartData.some(d => d.value > 0) ? (
                    <BarChart 
                      data={actionsChartData} 
                      height={180}
                      barColor="#198754"
                      showValues={selectedPeriod <= 14}
                    />
                  ) : (
                    <div className="text-center py-4 text-muted">
                      <p className="mt-2 mb-0">No actions recorded</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Combined Chart */}
          <div className="card border-0 shadow-sm mb-4" style={{ background: 'var(--card-bg)', borderRadius: '12px' }}>
            <div className="card-body" style={{ padding: '1.5rem' }}>
              <div className="d-flex justify-content-between align-items-center" style={{ marginBottom: '1.5rem' }}>
                <h5 className="mb-0" style={{ color: 'var(--text-primary)', fontSize: '1rem', fontWeight: '600' }}>
                  Total Interactions Over Time ({selectedPeriod} days)
                </h5>
                <span className="text-muted" style={{ fontSize: '0.85rem' }}>
                  Avg: {analytics?.avg_clicks_per_day ?? 0}/day
                </span>
              </div>
              {chartData.length > 0 && chartData.some(d => d.value > 0) ? (
                <div style={{ paddingTop: '0.5rem' }}>
                  <BarChart 
                    data={chartData.map(d => ({ label: d.label, value: d.value }))} 
                    height={220}
                    barColor="#ffaa50"
                    showValues={selectedPeriod <= 30}
                  />
                </div>
              ) : (
                <div className="text-center py-5 text-muted">
                  <p className="mt-2">No interactions recorded in this period</p>
                </div>
              )}
            </div>
          </div>

            {/* Secondary Charts Row */}
            <div className="row g-3 mb-4">
              {/* Hourly Distribution */}
              <div className="col-md-6">
                <div className="card border-0 shadow-sm h-100" style={{ background: 'var(--card-bg)', borderRadius: '12px' }}>
                  <div className="card-body" style={{ padding: '1.25rem' }}>
                    <div className="d-flex justify-content-between align-items-center mb-3">
                      <h6 className="mb-0" style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: '600' }}>
                        ⏱️ Clicks by Hour
                      </h6>
                      {analytics?.peak_hour && (
                        <span className="badge bg-warning text-dark" style={{ fontSize: '0.7rem' }}>
                          Peak: {analytics.peak_hour.hour_label}
                        </span>
                      )}
                    </div>
                    {hourlyData.length > 0 && hourlyData.some(d => d.value > 0) ? (
                      <BarChart 
                        data={hourlyData} 
                        height={160}
                        barColor="#0d6efd"
                        showValues={false}
                      />
                    ) : (
                      <div className="text-center py-4 text-muted">
                        <p className="mb-0">No data yet</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Day of Week Distribution */}
              <div className="col-md-6">
                <div className="card border-0 shadow-sm h-100" style={{ background: 'var(--card-bg)', borderRadius: '12px' }}>
                  <div className="card-body" style={{ padding: '1.25rem' }}>
                    <div className="d-flex justify-content-between align-items-center mb-3">
                      <h6 className="mb-0" style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: '600' }}>
                        Clicks by Day of Week
                      </h6>
                      {analytics?.clicks_by_weekday && analytics.clicks_by_weekday.length > 0 && (
                        <span className="badge bg-success" style={{ fontSize: '0.7rem' }}>
                          Best: {analytics.clicks_by_weekday.reduce((max, d) => d.count > max.count ? d : max, analytics.clicks_by_weekday[0]).weekday}
                        </span>
                      )}
                    </div>
                    {weekdayData.length > 0 && weekdayData.some(d => d.value > 0) ? (
                      <BarChart 
                        data={weekdayData} 
                        height={160}
                        barColor="#198754"
                        showValues={true}
                      />
                    ) : (
                      <div className="text-center py-4 text-muted">
                        <p className="mb-0">No data yet</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

          {/* Additional Info Row */}
          <div className="row g-3">
            {/* Timeline Info */}
            <div className="col-md-6">
              <div className="card border-0 shadow-sm h-100" style={{ background: 'var(--card-bg)', borderRadius: '12px' }}>
                <div className="card-body" style={{ padding: '1.25rem' }}>
                  <h6 className="mb-3" style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: '600' }}>
                    📌 Timeline
                  </h6>
                  <div className="d-flex flex-column gap-2">
                    <div className="d-flex justify-content-between">
                      <span className="text-muted" style={{ fontSize: '0.85rem' }}>Created:</span>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                        {formatDate(analytics?.opportunity_created ?? null)}
                      </span>
                    </div>
                    <div className="d-flex justify-content-between">
                      <span className="text-muted" style={{ fontSize: '0.85rem' }}>First Click:</span>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                        {formatDate(analytics?.first_click ?? null)}
                      </span>
                    </div>
                    <div className="d-flex justify-content-between">
                      <span className="text-muted" style={{ fontSize: '0.85rem' }}>Last Click:</span>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                        {formatDate(analytics?.last_click ?? null)}
                      </span>
                    </div>
                    {analytics?.peak_day && (
                      <div className="d-flex justify-content-between">
                        <span className="text-muted" style={{ fontSize: '0.85rem' }}>Peak Day:</span>
                        <span style={{ fontSize: '0.85rem', color: '#ffaa50', fontWeight: '600' }}>
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
              </div>
            </div>

            {/* Performance Summary */}
            <div className="col-md-6">
              <div className="card border-0 shadow-sm h-100" style={{ background: 'var(--card-bg)', borderRadius: '12px' }}>
                <div className="card-body" style={{ padding: '1.25rem' }}>
                  <h6 className="mb-3" style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: '600' }}>
                    Performance Summary
                  </h6>
                  <div className="d-flex flex-column gap-2">
                    <div className="d-flex justify-content-between align-items-center">
                      <span className="text-muted" style={{ fontSize: '0.85rem' }}>Average Daily Clicks:</span>
                      <span className="badge bg-primary" style={{ fontSize: '0.8rem' }}>
                        {analytics?.avg_clicks_per_day ?? 0}
                      </span>
                    </div>
                    <div className="d-flex justify-content-between align-items-center">
                      <span className="text-muted" style={{ fontSize: '0.85rem' }}>Click-to-User Ratio:</span>
                      <span className="badge bg-info text-dark" style={{ fontSize: '0.8rem' }}>
                        {(analytics?.unique_users ?? 0) > 0 
                          ? ((analytics?.clicks_total ?? 0) / (analytics?.unique_users ?? 1)).toFixed(1) 
                          : '0'} clicks/user
                      </span>
                    </div>
                    <div className="d-flex justify-content-between align-items-center">
                      <span className="text-muted" style={{ fontSize: '0.85rem' }}>Week-over-Week:</span>
                      <span 
                        className={`badge ${(analytics?.week_over_week_change ?? 0) >= 0 ? 'bg-success' : 'bg-danger'}`}
                        style={{ fontSize: '0.8rem' }}
                      >
                        {(analytics?.week_over_week_change ?? 0) >= 0 ? '+' : ''}{analytics?.week_over_week_change ?? 0}%
                      </span>
                    </div>
                    {analytics?.peak_hour && (
                      <div className="d-flex justify-content-between align-items-center">
                        <span className="text-muted" style={{ fontSize: '0.85rem' }}>Peak Hour:</span>
                        <span className="badge bg-warning text-dark" style={{ fontSize: '0.8rem' }}>
                          {analytics.peak_hour.hour_label}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="alert alert-info">
          <i className="bi bi-info-circle me-2"></i>
          No analytics data available
        </div>
      )}
    </div>
  );
};

export default OpportunityAnalyticsPage;
