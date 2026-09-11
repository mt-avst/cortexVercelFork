import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SessionEvent } from '../../api/types';

export const EVENT_TYPE_LABELS: Record<string, string> = {
  session_started: 'Started',
  session_completed: 'Completed',
  session_abandoned: 'Abandoned',
  session_failed: 'Failed'
};

export const EVENT_TYPE_BADGE: Record<string, string> = {
  session_started: 'cortex-badge--info',
  session_completed: 'cortex-badge--best',
  session_abandoned: 'cortex-badge--peak',
  session_failed: ''
};

export interface SessionRow {
  sessionId: string;
  participantName: string | null;
  participantEmail: string | null;
  latestEventType: string;
  latestOccurredAt: string;
}

/**
 * Collapse the raw event stream (one row per lifecycle event) into one row per
 * FirstHand session, keyed by firsthand_session_id, showing the latest event.
 */
export function groupEventsBySession(events: SessionEvent[]): SessionRow[] {
  const bySession = events.reduce((sessions, event) => {
    const existing = sessions.get(event.firsthand_session_id);

    if (existing && existing.latestOccurredAt >= event.occurred_at) {
      return sessions;
    }

    return new Map(sessions).set(event.firsthand_session_id, {
      sessionId: event.firsthand_session_id,
      participantName: event.participant_name ?? existing?.participantName ?? null,
      participantEmail: event.participant_email ?? existing?.participantEmail ?? null,
      latestEventType: event.event_type,
      latestOccurredAt: event.occurred_at
    });
  }, new Map<string, SessionRow>());

  return [...bySession.values()].sort((left, right) =>
    right.latestOccurredAt.localeCompare(left.latestOccurredAt)
  );
}

type SessionSortField = 'participant' | 'status' | 'lastActivity';
type SortDirection = 'asc' | 'desc';

/**
 * Where a session sits in its own lifecycle, not the raw event-type string -
 * a plain alphabetical sort would put "Abandoned" ahead of "Started" for no
 * reason a researcher would recognise. In-progress first, then the outcomes
 * from best to worst.
 */
const STATUS_RANK: Record<string, number> = {
  session_started: 0,
  session_completed: 1,
  session_abandoned: 2,
  session_failed: 3
};

function compareSessions(left: SessionRow, right: SessionRow, field: SessionSortField): number {
  switch (field) {
    case 'participant':
      return (left.participantName ?? 'Unknown').localeCompare(right.participantName ?? 'Unknown');
    case 'status':
      return (STATUS_RANK[left.latestEventType] ?? 99) - (STATUS_RANK[right.latestEventType] ?? 99);
    case 'lastActivity':
    default:
      return left.latestOccurredAt.localeCompare(right.latestOccurredAt);
  }
}

const SessionsTab: React.FC<{
  opportunityId: string;
  events: SessionEvent[];
  loading: boolean;
  onRefresh: () => void;
}> = ({ opportunityId, events, loading, onRefresh }) => {
  // "Last activity, descending" is the ordering that ships today - the
  // default here MUST match groupEventsBySession's own sort, or a first
  // render would silently reorder the table before anyone touches a header.
  const [sortField, setSortField] = useState<SessionSortField>('lastActivity');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSort = (field: SessionSortField) => {
    if (field === sortField) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Only the active column reports asc/descending - the rest report 'none',
  // so the table's aria-sort names exactly one sorted column at a time.
  const ariaSortFor = (field: SessionSortField): 'ascending' | 'descending' | 'none' =>
    sortField === field ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none';

  const sessions = useMemo(() => groupEventsBySession(events), [events]);

  // Hooks run every render regardless of the `loading` early return below.
  const sortedSessions = useMemo(
    () =>
      [...sessions].sort((left, right) => {
        const comparison = compareSessions(left, right, sortField);
        return sortDirection === 'asc' ? comparison : -comparison;
      }),
    [sessions, sortField, sortDirection]
  );

  if (loading) {
    return (
      <div className="text-center py-5">
        <div className="spinner-border text-primary" role="status">
          <span className="visually-hidden">Loading sessions...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="cortex-analytics-card" style={{ marginBottom: '24px' }}>
      <div className="cortex-chart-header">
        <h5 className="cortex-chart-title">Study Sessions</h5>
        <button
          type="button"
          className="cortex-period-btn"
          onClick={onRefresh}
          style={{ fontSize: '0.75rem' }}
        >
          Refresh
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="cortex-no-data" style={{ padding: '32px 0' }}>
          <p>No session events recorded yet.</p>
          <p className="cortex-stat-subtitle" style={{ fontSize: '0.8rem', marginTop: '4px' }}>
            Events are recorded when participants start, complete or abandon a study session.
          </p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--cortex-border, rgba(255,255,255,0.08))' }}>
                <th
                  style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}
                  aria-sort={ariaSortFor('participant')}
                >
                  <button type="button" className="admin-th-sort" onClick={() => handleSort('participant')}>
                    Participant
                    <span className="admin-th-sort-caret" aria-hidden="true">
                      {sortField === 'participant' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}
                    </span>
                  </button>
                </th>
                <th
                  style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}
                  aria-sort={ariaSortFor('status')}
                >
                  <button type="button" className="admin-th-sort" onClick={() => handleSort('status')}>
                    Status
                    <span className="admin-th-sort-caret" aria-hidden="true">
                      {sortField === 'status' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}
                    </span>
                  </button>
                </th>
                <th
                  style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}
                  aria-sort={ariaSortFor('lastActivity')}
                >
                  <button type="button" className="admin-th-sort" onClick={() => handleSort('lastActivity')}>
                    Last activity
                    <span className="admin-th-sort-caret" aria-hidden="true">
                      {sortField === 'lastActivity' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}
                    </span>
                  </button>
                </th>
                <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>Session</th>
              </tr>
            </thead>
            <tbody>
              {sortedSessions.map((session) => (
                <tr
                  key={session.sessionId}
                  style={{ borderBottom: '1px solid var(--cortex-border, rgba(255,255,255,0.04))' }}
                >
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ fontWeight: 500 }}>
                      {session.participantName ?? 'Unknown'}
                    </span>
                    {session.participantEmail && (
                      <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {session.participantEmail}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <span className={`cortex-badge ${EVENT_TYPE_BADGE[session.latestEventType] ?? ''}`}>
                      {EVENT_TYPE_LABELS[session.latestEventType] ?? session.latestEventType}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {new Date(session.latestOccurredAt).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <Link
                      to={`/admin/opportunities/${opportunityId}/sessions/${session.sessionId}/review`}
                      style={{ color: 'var(--color-analytics-orange)', fontSize: '0.8rem' }}
                    >
                      Review session
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default SessionsTab;
