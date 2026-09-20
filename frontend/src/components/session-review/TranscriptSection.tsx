import React from 'react';
import { FirstHandTranscript, FirstHandTranscriptStatus } from '../../api/types';

function formatSegmentTime(value: string): string {
  return new Date(value).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

const PendingState: React.FC<{ onRefresh: () => void }> = ({ onRefresh }) => (
  <div className="cortex-no-data" style={{ padding: '24px 0' }}>
    <p>Transcript is still being processed.</p>
    <button
      type="button"
      className="cortex-period-btn"
      onClick={onRefresh}
      style={{ marginTop: '8px', fontSize: '0.75rem' }}
    >
      Refresh
    </button>
  </div>
);

const TranscriptSection: React.FC<{
  transcript: FirstHandTranscript | null;
  transcriptStatus: FirstHandTranscriptStatus;
  transcriptFailureMessage: string | null;
  onRefresh: () => void;
}> = ({ transcript, transcriptStatus, transcriptFailureMessage, onRefresh }) => (
  <div className="cortex-analytics-card" style={{ marginBottom: '24px' }}>
    <div className="cortex-chart-header">
      <h5 className="cortex-chart-title">Transcript</h5>
    </div>

    {transcript ? (
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {transcript.segments.map((segment) => (
          <li
            key={segment.id}
            style={{
              padding: '10px 0',
              borderBottom: '1px solid var(--border-subtle-current)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
              <span
                style={{
                  fontWeight: 500,
                  fontSize: '0.8rem',
                  color: segment.speaker === 'participant'
                    ? 'var(--color-analytics-orange)'
                    : 'var(--text-muted)'
                }}
              >
                {segment.speaker_label}
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', fontVariantNumeric: 'tabular-nums' }}>
                {formatSegmentTime(segment.timestamp)}
              </span>
            </div>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{segment.text}</p>
          </li>
        ))}
      </ol>
    ) : transcriptStatus === 'queued' || transcriptStatus === 'processing' ? (
      <PendingState onRefresh={onRefresh} />
    ) : transcriptStatus === 'failed' ? (
      <div className="cortex-no-data" style={{ padding: '24px 0' }}>
        <p>Transcript generation failed.</p>
        {transcriptFailureMessage && (
          <p className="cortex-stat-subtitle" style={{ fontSize: '0.8rem', marginTop: '4px' }}>
            {transcriptFailureMessage}
          </p>
        )}
      </div>
    ) : (
      <div className="cortex-no-data" style={{ padding: '24px 0' }}>
        <p>No transcript was requested for this session.</p>
      </div>
    )}
  </div>
);

export default TranscriptSection;
