import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams, useLocation, Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { getSessionOutputs, getOpportunitySessionEvents } from '../api/client';
import { FirstHandSessionOutputs } from '../api/types';
import ErrorState from '../components/ErrorState';
import SlowNeuralBackground from '../components/SlowNeuralBackground';
import SessionSummaryCard from '../components/session-review/SessionSummaryCard';
import ResponsesSection from '../components/session-review/ResponsesSection';
import TranscriptSection from '../components/session-review/TranscriptSection';
import AssetsSection from '../components/session-review/AssetsSection';
import { groupEventsBySession } from '../components/opportunity-analytics/SessionsTab';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';

function errorMessageForStatus(status: number | undefined): string {
  if (status === 404) {
    return 'Session outputs are not available. The session may not have started yet.';
  }
  if (status === 503) {
    return 'Session outputs are temporarily unavailable. Try again shortly.';
  }
  if (status === 403) {
    return 'You do not have permission to review sessions for this study.';
  }
  return 'Failed to load session outputs.';
}

const SessionReviewPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { id, sessionId } = useParams<{ id: string; sessionId: string }>();
  const { user, loading } = useAuth();
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const [outputs, setOutputs] = useState<FirstHandSessionOutputs | null>(null);
  const [loadingOutputs, setLoadingOutputs] = useState(true);
  const [error, setError] = useState<string>('');
  const [selectedAttempt, setSelectedAttempt] = useState<number | undefined>(undefined);

  // The list of sibling sessions this review sits in, in the same order the
  // Sessions tab shows. A click from the tab hands the exact current order over
  // in router state (so a custom sort is honoured); a cold load (direct link or
  // refresh) has no state, so we rebuild the tab's DEFAULT order from the
  // study's events - both routes use groupEventsBySession, the one ordering
  // function, so prev/next can never disagree with the tab it came from.
  const orderFromState = (location.state as { sessionOrder?: string[] } | null)?.sessionOrder ?? null;
  const [fetchedOrder, setFetchedOrder] = useState<string[] | null>(null);
  const sessionOrder = orderFromState ?? fetchedOrder;

  useEffect(() => {
    if (orderFromState || !id) return;
    let cancelled = false;
    getOpportunitySessionEvents(id)
      .then((events) => {
        if (!cancelled) setFetchedOrder(groupEventsBySession(events).map((s) => s.sessionId));
      })
      .catch(() => {
        // No sibling order is a soft failure: the page still reviews this one
        // session, just without prev/next.
        if (!cancelled) setFetchedOrder(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id, orderFromState]);

  const currentIndex = sessionOrder && sessionId ? sessionOrder.indexOf(sessionId) : -1;
  const totalSessions = sessionOrder?.length ?? 0;
  const hasOrdinal = currentIndex >= 0 && totalSessions > 0;
  const prevSessionId = currentIndex > 0 ? sessionOrder![currentIndex - 1] : null;
  const nextSessionId =
    currentIndex >= 0 && currentIndex < totalSessions - 1 ? sessionOrder![currentIndex + 1] : null;

  const goToSession = (targetSessionId: string) => {
    // Carry the order forward so the ordinal survives the hop.
    navigate(`/admin/opportunities/${id}/sessions/${targetSessionId}/review`, {
      state: sessionOrder ? { sessionOrder } : undefined,
    });
  };

  const loadOutputs = useCallback(async (attempt?: number) => {
    if (!id || !sessionId) return;
    setLoadingOutputs(true);
    setError('');
    try {
      const data = await getSessionOutputs(id, sessionId, attempt);
      setOutputs(data);
    } catch (err: unknown) {
      const axiosError = err as { response?: { status?: number } };
      setError(errorMessageForStatus(axiosError.response?.status));
    } finally {
      setLoadingOutputs(false);
    }
  }, [id, sessionId]);

  useEffect(() => {
    if (!loading && !user) {
      return;
    }
    loadOutputs(selectedAttempt);
  }, [user, loading, loadOutputs, selectedAttempt]);

  // Redirect if not authenticated
  if (!loading && !user) {
    return <Navigate to="/" replace />;
  }

  if (loading || loadingOutputs) {
    return (
      <div className="loading-container">
        <div className="text-center">
          <div className="spinner-border text-primary" role="status">
            <span className="visually-hidden">Loading...</span>
          </div>
          <p className="mt-3 text-muted">Loading session review...</p>
        </div>
      </div>
    );
  }

  if (error || !outputs) {
    return (
      <div className="container py-5">
        <div className="row">
          <div className="col-12">
            <button
              className="btn btn-outline-secondary mb-4"
              onClick={() => navigate(`/admin/opportunities/${id}/analytics`)}
            >
              <ArrowLeft size={16} className="me-2" />
              Back to Analytics
            </button>
            <ErrorState
              title="Unable to Load Session Review"
              message={error || 'Session outputs not found'}
              onAction={() => loadOutputs(selectedAttempt)}
              actionLabel="Retry"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="analytics-page-wrapper" style={{ position: 'relative', minHeight: '100vh' }}>
      {isDark && <SlowNeuralBackground />}

      <div className="container-fluid py-4 analytics-container">
        <button
          className="btn btn-outline-secondary btn-sm"
          onClick={() => navigate(`/admin/opportunities/${id}/analytics`)}
          style={{
            borderRadius: '6px',
            fontSize: '0.8125rem',
            fontWeight: '500',
            marginBottom: '1.5rem'
          }}
        >
          <ArrowLeft size={14} style={{ marginRight: '6px' }} />
          Back to Analytics
        </button>

        <div className="cortex-page-header">
          <div className="cortex-title-block">
            <h1 className="cortex-brand-title">
              Cortex<span className="cortex-admin-separator">|</span><span className="cortex-admin-suffix">Session Review</span>
            </h1>
            <p>
              Participant: <span className="cortex-highlight-orange">{outputs.session.participant.display_name}</span>
            </p>
          </div>

          {hasOrdinal && (
            <div
              className="session-review-nav"
              role="group"
              aria-label="Session navigation"
              style={{ display: 'flex', alignItems: 'center', gap: '10px' }}
            >
              <button
                type="button"
                className="btn btn-outline-secondary btn-sm"
                onClick={() => prevSessionId && goToSession(prevSessionId)}
                disabled={!prevSessionId}
                aria-label="Previous session"
              >
                <ChevronLeft size={14} style={{ marginRight: '4px' }} aria-hidden="true" />
                Previous
              </button>
              <span className="cortex-stat-subtitle" style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                Session {currentIndex + 1} of {totalSessions}
              </span>
              <button
                type="button"
                className="btn btn-outline-secondary btn-sm"
                onClick={() => nextSessionId && goToSession(nextSessionId)}
                disabled={!nextSessionId}
                aria-label="Next session"
              >
                Next
                <ChevronRight size={14} style={{ marginLeft: '4px' }} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        <SessionSummaryCard
          outputs={outputs}
          onSelectAttempt={setSelectedAttempt}
        />
        <AssetsSection
          assets={outputs.assets}
          onRefresh={() => loadOutputs(selectedAttempt)}
        />
        {/* The terminal `end` marker is appended automatically and is never shown
            to the participant, so showing it to the reviewer invents a fifth
            task that nobody was asked to do - and then reports it as having no
            response. Filtered HERE rather than inside ResponsesSection, which
            the unpushed participant-launch branch rewrites. */}
        <ResponsesSection
          steps={outputs.steps.filter((step) => step.type !== 'end')}
          // A recording exists when this session has at least one asset - the
          // same rows AssetsSection shows. Without one, the per-step fallback
          // must not claim the answer is "in the recording".
          hasRecording={outputs.assets.length > 0}
        />
        <TranscriptSection
          transcript={outputs.transcript}
          transcriptStatus={outputs.session.transcript_status}
          transcriptFailureMessage={outputs.session.transcript_failure_message}
          onRefresh={() => loadOutputs(selectedAttempt)}
        />
      </div>
    </div>
  );
};

export default SessionReviewPage;
