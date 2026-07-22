import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SessionsTab, { groupEventsBySession } from '../SessionsTab';
import { SessionEvent } from '../../../api/types';

function buildEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: 'evt-1',
    opportunity_id: 'opp-1',
    participant_user_id: 'user-1',
    firsthand_session_id: 'session_abc',
    event_type: 'session_started',
    occurred_at: '2026-07-15T10:00:00.000Z',
    received_at: '2026-07-15T10:00:01.000Z',
    participant_name: 'Jane Doe',
    participant_email: 'jane@example.com',
    ...overrides
  };
}

describe('groupEventsBySession', () => {
  it('collapses multiple events for one session into a single row', () => {
    const events = [
      buildEvent({ id: 'evt-2', event_type: 'session_completed', occurred_at: '2026-07-15T10:14:30.000Z' }),
      buildEvent({ id: 'evt-1', event_type: 'session_started', occurred_at: '2026-07-15T10:00:00.000Z' })
    ];

    const rows = groupEventsBySession(events);

    expect(rows).toHaveLength(1);
    expect(rows[0].latestEventType).toBe('session_completed');
    expect(rows[0].latestOccurredAt).toBe('2026-07-15T10:14:30.000Z');
  });

  it('keeps separate rows for separate sessions, newest first', () => {
    const events = [
      buildEvent({ id: 'evt-1', firsthand_session_id: 'session_old', occurred_at: '2026-07-14T09:00:00.000Z' }),
      buildEvent({ id: 'evt-2', firsthand_session_id: 'session_new', occurred_at: '2026-07-15T10:00:00.000Z' })
    ];

    const rows = groupEventsBySession(events);

    expect(rows.map((row) => row.sessionId)).toEqual(['session_new', 'session_old']);
  });

  it('does not mutate the input events array', () => {
    const events = [buildEvent()];
    const snapshot = JSON.parse(JSON.stringify(events));

    groupEventsBySession(events);

    expect(events).toEqual(snapshot);
  });
});

describe('SessionsTab', () => {
  const renderTab = (events: SessionEvent[]) =>
    render(
      <MemoryRouter>
        <SessionsTab opportunityId="opp-1" events={events} loading={false} onRefresh={() => undefined} />
      </MemoryRouter>
    );

  it('renders one row per session with an internal review link', () => {
    renderTab([
      buildEvent({ id: 'evt-1', event_type: 'session_started', occurred_at: '2026-07-15T10:00:00.000Z' }),
      buildEvent({ id: 'evt-2', event_type: 'session_completed', occurred_at: '2026-07-15T10:14:30.000Z' })
    ]);

    const links = screen.getAllByRole('link', { name: 'Review session' });

    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      'href',
      '/admin/opportunities/opp-1/sessions/session_abc/review'
    );
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
  });

  it('shows the empty state when there are no events', () => {
    renderTab([]);

    expect(screen.getByText('No session events recorded yet.')).toBeInTheDocument();
  });
});
