import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { getSessionOutputs } from '../api/client';
import { FirstHandSessionOutputs } from '../api/types';
import ErrorState from '../components/ErrorState';
import SlowNeuralBackground from '../components/SlowNeuralBackground';
import SessionSummaryCard from '../components/session-review/SessionSummaryCard';
import ResponsesSection from '../components/session-review/ResponsesSection';
import TranscriptSection from '../components/session-review/TranscriptSection';
import AssetsSection from '../components/session-review/AssetsSection';
import { ArrowLeft } from 'lucide-react';

function errorMessageForStatus(status: number | undefined): string {
  if (status === 404) {
    return 'Session outputs are not available. The session may not have started yet.';
  }
  if (status === 503) {
    return 'The FirstHand integration is not configured or is currently unavailable.';
  }
  if (status === 403) {
    return 'You do not have permission to review sessions for this opportunity.';
  }
  return 'Failed to load session outputs.';
}

const SessionReviewPage: React.FC = () => {
  const navigate = useNavigate();
  const { id, sessionId } = useParams<{ id: string; sessionId: string }>();
  const { user, loading } = useAuth();
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const [outputs, setOutputs] = useState<FirstHandSessionOutputs | null>(null);
  const [loadingOutputs, setLoadingOutputs] = useState(true);
  const [error, setError] = useState<string>('');
  const [selectedAttempt, setSelectedAttempt] = useState<number | undefined>(undefined);

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
        </div>

        <SessionSummaryCard
          outputs={outputs}
          onSelectAttempt={setSelectedAttempt}
        />
        <ResponsesSection steps={outputs.steps} />
        <TranscriptSection
          transcript={outputs.transcript}
          transcriptStatus={outputs.session.transcript_status}
          transcriptFailureMessage={outputs.session.transcript_failure_message}
          onRefresh={() => loadOutputs(selectedAttempt)}
        />
        <AssetsSection
          assets={outputs.assets}
          onRefresh={() => loadOutputs(selectedAttempt)}
        />
      </div>
    </div>
  );
};

export default SessionReviewPage;
