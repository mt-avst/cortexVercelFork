import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import SessionSummaryCard from '../SessionSummaryCard';
import { FirstHandSessionOutputs } from '../../../api/types';

const outputs = (over: Partial<FirstHandSessionOutputs['session']> = {}): FirstHandSessionOutputs => ({
  contract_version: '1',
  session: {
    session_id: 's1',
    logical_session_id: 'ls1',
    attempt_number: 1,
    study_id: 'study-1',
    study_title: 'Checkout study',
    participant: { participant_id: 'p1', display_name: 'Ada Tester' },
    session_status: 'completed',
    started_at: '2026-07-15T10:00:00.000Z',
    completed_at: '2026-07-15T10:20:00.000Z',
    transcript_status: 'complete',
    transcript_failure_message: null,
    ...over,
  },
  attempts: [],
  steps: [],
  transcript: null,
  assets: [],
});

describe('SessionSummaryCard', () => {
  it('surfaces a failed transcript alongside a completed session, not hidden behind Completed', () => {
    // Row 8: a session can be Completed while its transcript failed. Showing
    // only the session status let the failure read as a wholly successful
    // session. Both must appear.
    const { container } = render(
      <SessionSummaryCard
        outputs={outputs({ session_status: 'completed', transcript_status: 'failed' })}
        onSelectAttempt={() => {}}
      />
    );

    // The two status badges, read as a pair so "Completed" here is the session
    // badge and not the "Completed" timestamp label above it.
    const badges = [...container.querySelectorAll('.cortex-badge')].map((b) => b.textContent?.trim());
    expect(badges).toEqual(['Completed', 'Failed']);
  });

  it('renders the completion time only when the session actually completed (row 10)', () => {
    const { queryByText } = render(
      <SessionSummaryCard
        outputs={outputs({ session_status: 'completed', completed_at: '2026-07-15T10:20:00.000Z' })}
        onSelectAttempt={() => {}}
      />
    );
    // A completed session with a real completed_at shows the formatted time, so
    // no field reads the empty "Not recorded" placeholder.
    expect(queryByText('Not recorded')).not.toBeInTheDocument();
  });

  it('does not render a completion time for an abandoned session even if completed_at is set', () => {
    // An abandoned run can still carry a completed_at from an earlier step;
    // showing it read as though the session had finished.
    const { getByText } = render(
      <SessionSummaryCard
        outputs={outputs({ session_status: 'abandoned', completed_at: '2026-07-15T10:20:00.000Z' })}
        onSelectAttempt={() => {}}
      />
    );
    expect(getByText('Not recorded')).toBeInTheDocument();
  });
});
