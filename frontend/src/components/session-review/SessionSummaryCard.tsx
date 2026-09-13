import React from 'react';
import { FirstHandSessionOutputs } from '../../api/types';

import { formatDateTime } from '../../utils/datetime';
const SESSION_STATUS_LABELS: Record<string, string> = {
  created: 'Created',
  link_opened: 'Link opened',
  consent_accepted: 'Consent accepted',
  setup_in_progress: 'Setting up',
  ready_to_start: 'Ready to start',
  recording_in_progress: 'In progress',
  uploading: 'Uploading',
  completed: 'Completed',
  abandoned: 'Abandoned',
  failed: 'Failed'
};

const SESSION_STATUS_BADGE: Record<string, string> = {
  completed: 'cortex-badge--best',
  abandoned: 'cortex-badge--peak',
  recording_in_progress: 'cortex-badge--info',
  failed: ''
};

// Shown alongside the session status. A session can be `completed` while its
// transcript `failed`, and leaving that off the summary let a failed transcript
// read as a wholly successful session ("Completed") with the failure buried far
// down in the Transcript section. Row 8, a71-session-review-transcript-failed.
const TRANSCRIPT_STATUS_LABELS: Record<string, string> = {
  not_requested: 'Not requested',
  queued: 'Queued',
  processing: 'Processing',
  complete: 'Complete',
  failed: 'Failed'
};

const TRANSCRIPT_STATUS_BADGE: Record<string, string> = {
  complete: 'cortex-badge--best',
  processing: 'cortex-badge--info',
  queued: 'cortex-badge--info',
  failed: ''
};

function formatTimestamp(value: string | null): string {
  if (!value) return 'Not recorded';
  // Shared formatter, so a reviewer reading a recording and a participant
  // reading their booking see the same shape of date - and so this one carries
  // a zone, which it did not.
  return formatDateTime(value) ?? 'Not recorded';
}

const SessionSummaryCard: React.FC<{
  outputs: FirstHandSessionOutputs;
  onSelectAttempt: (attempt: number) => void;
}> = ({ outputs, onSelectAttempt }) => {
  const { session, attempts } = outputs;

  return (
    <div className="cortex-analytics-card" style={{ marginBottom: '24px' }}>
      <div className="cortex-chart-header">
        <h5 className="cortex-chart-title">{session.study_title}</h5>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '32px', padding: '8px 0' }}>
        <div>
          <p className="cortex-stat-subtitle" style={{ marginBottom: '4px' }}>Participant</p>
          <span style={{ fontWeight: 500 }}>{session.participant.display_name}</span>
        </div>
        <div>
          <p className="cortex-stat-subtitle" style={{ marginBottom: '4px' }}>Status</p>
          <span className={`cortex-badge ${SESSION_STATUS_BADGE[session.session_status] ?? ''}`}>
            {SESSION_STATUS_LABELS[session.session_status] ?? session.session_status}
          </span>
        </div>
        <div>
          <p className="cortex-stat-subtitle" style={{ marginBottom: '4px' }}>Transcript</p>
          <span className={`cortex-badge ${TRANSCRIPT_STATUS_BADGE[session.transcript_status] ?? ''}`}>
            {TRANSCRIPT_STATUS_LABELS[session.transcript_status] ?? session.transcript_status}
          </span>
        </div>
        <div>
          <p className="cortex-stat-subtitle" style={{ marginBottom: '4px' }}>Started</p>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatTimestamp(session.started_at)}</span>
        </div>
        <div>
          <p className="cortex-stat-subtitle" style={{ marginBottom: '4px' }}>Completed</p>
          {/* Only a completed session has a meaningful completion time. An
              abandoned or failed run can still carry a completed_at from an
              earlier step, and rendering it read as though the session had
              finished (row 10). */}
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {session.session_status === 'completed' ? formatTimestamp(session.completed_at) : 'Not recorded'}
          </span>
        </div>
      </div>

      {attempts.length > 1 && (
        <div style={{ marginTop: '12px' }}>
          <p className="cortex-stat-subtitle" style={{ marginBottom: '8px' }}>Attempts</p>
          <div className="cortex-date-selector" role="group" aria-label="Session attempts">
            {attempts.map((attempt) => (
              <button
                key={attempt.attempt_number}
                type="button"
                className={`cortex-period-btn ${attempt.attempt_number === session.attempt_number ? 'cortex-period-btn--active' : ''}`}
                onClick={() => onSelectAttempt(attempt.attempt_number)}
              >
                Attempt {attempt.attempt_number}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default SessionSummaryCard;
