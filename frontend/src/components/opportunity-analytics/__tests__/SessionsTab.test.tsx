import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
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

const renderTab = (events: SessionEvent[]) =>
  render(
    <MemoryRouter>
      <SessionsTab opportunityId="opp-1" events={events} loading={false} onRefresh={() => undefined} />
    </MemoryRouter>
  );

describe('SessionsTab', () => {
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

describe('SessionsTab column sorting (DA-23)', () => {
  // Deliberately picked so timestamp order, name order and status-rank order
  // all disagree with each other - a test that coincidentally reuses the same
  // ordering for two sort modes cannot tell them apart.
  const threeSessions = (): SessionEvent[] => [
    buildEvent({
      id: 'evt-bob',
      firsthand_session_id: 'session_bob',
      participant_name: 'Bob',
      event_type: 'session_failed',
      occurred_at: '2026-07-15T09:00:00.000Z'
    }),
    buildEvent({
      id: 'evt-nina',
      firsthand_session_id: 'session_nina',
      participant_name: 'Nina',
      event_type: 'session_started',
      occurred_at: '2026-07-15T11:00:00.000Z'
    }),
    buildEvent({
      id: 'evt-amy',
      firsthand_session_id: 'session_amy',
      participant_name: 'Amy',
      event_type: 'session_completed',
      occurred_at: '2026-07-15T10:00:00.000Z'
    })
  ];

  const rowOrder = (): string[] =>
    screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent ?? '');

  const namesIn = (rows: string[], names: string[]): string[] =>
    rows.map((rowText) => names.find((name) => rowText.includes(name)) ?? '');

  it('CONTROL: defaults to last-activity descending, unclicked - the ordering that ships today', () => {
    renderTab(threeSessions());

    expect(namesIn(rowOrder(), ['Bob', 'Nina', 'Amy'])).toEqual(['Nina', 'Amy', 'Bob']);
    expect(screen.getByRole('columnheader', { name: 'Last activity' })).toHaveAttribute(
      'aria-sort',
      'descending'
    );
    expect(screen.getByRole('columnheader', { name: 'Status' })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: 'Participant' })).toHaveAttribute(
      'aria-sort',
      'none'
    );
  });

  it('sorts by Status rank ascending on first click, descending on second', async () => {
    const user = userEvent.setup();
    renderTab(threeSessions());

    const statusHeader = screen.getByRole('button', { name: 'Status' });
    await user.click(statusHeader);

    // started(0) < completed(1) < failed(3)
    expect(namesIn(rowOrder(), ['Bob', 'Nina', 'Amy'])).toEqual(['Nina', 'Amy', 'Bob']);
    expect(screen.getByRole('columnheader', { name: 'Status' })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );
    expect(screen.getByRole('columnheader', { name: 'Last activity' })).toHaveAttribute(
      'aria-sort',
      'none'
    );

    await user.click(statusHeader);

    expect(namesIn(rowOrder(), ['Bob', 'Nina', 'Amy'])).toEqual(['Bob', 'Amy', 'Nina']);
    expect(screen.getByRole('columnheader', { name: 'Status' })).toHaveAttribute(
      'aria-sort',
      'descending'
    );
  });

  it('sorts by Participant name ascending on first click, descending on second', async () => {
    const user = userEvent.setup();
    renderTab(threeSessions());

    const participantHeader = screen.getByRole('button', { name: 'Participant' });
    await user.click(participantHeader);

    expect(namesIn(rowOrder(), ['Bob', 'Nina', 'Amy'])).toEqual(['Amy', 'Bob', 'Nina']);
    expect(screen.getByRole('columnheader', { name: 'Participant' })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );

    await user.click(participantHeader);

    expect(namesIn(rowOrder(), ['Bob', 'Nina', 'Amy'])).toEqual(['Nina', 'Bob', 'Amy']);
    expect(screen.getByRole('columnheader', { name: 'Participant' })).toHaveAttribute(
      'aria-sort',
      'descending'
    );
  });

  it('toggles Last activity to ascending on click, since it starts descending by default', async () => {
    const user = userEvent.setup();
    renderTab(threeSessions());

    await user.click(screen.getByRole('button', { name: 'Last activity' }));

    expect(namesIn(rowOrder(), ['Bob', 'Nina', 'Amy'])).toEqual(['Bob', 'Amy', 'Nina']);
    expect(screen.getByRole('columnheader', { name: 'Last activity' })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );
  });
});

describe('SessionsTab hands the CURRENT order to the review page (DA-25)', () => {
  // Reads back the order the review route received in router state.
  const OrderProbe: React.FC = () => {
    const location = useLocation();
    const order = (location.state as { sessionOrder?: string[] } | null)?.sessionOrder ?? [];
    return <div data-testid="landed-order">{order.join(',')}</div>;
  };

  const threeSessions = (): SessionEvent[] => [
    buildEvent({ id: 'evt-bob', firsthand_session_id: 'session_bob', participant_name: 'Bob', event_type: 'session_failed', occurred_at: '2026-07-15T09:00:00.000Z' }),
    buildEvent({ id: 'evt-nina', firsthand_session_id: 'session_nina', participant_name: 'Nina', event_type: 'session_started', occurred_at: '2026-07-15T11:00:00.000Z' }),
    buildEvent({ id: 'evt-amy', firsthand_session_id: 'session_amy', participant_name: 'Amy', event_type: 'session_completed', occurred_at: '2026-07-15T10:00:00.000Z' })
  ];

  const renderWithReviewRoute = (events: SessionEvent[]) =>
    render(
      <MemoryRouter initialEntries={['/tab']}>
        <Routes>
          <Route path="/tab" element={<SessionsTab opportunityId="opp-1" events={events} loading={false} onRefresh={() => undefined} />} />
          <Route path="/admin/opportunities/:id/sessions/:sessionId/review" element={<OrderProbe />} />
        </Routes>
      </MemoryRouter>
    );

  it('carries the sorted order the researcher is looking at, not the default', async () => {
    const user = userEvent.setup();
    renderWithReviewRoute(threeSessions());

    // Re-sort by participant ascending: Amy, Bob, Nina - which is neither the
    // default last-activity order (Nina, Amy, Bob) nor its reverse.
    await user.click(screen.getByRole('button', { name: 'Participant' }));

    // Click the FIRST review link (Amy's row after the sort).
    const links = screen.getAllByRole('link', { name: 'Review session' });
    await user.click(links[0]);

    expect(screen.getByTestId('landed-order')).toHaveTextContent('session_amy,session_bob,session_nina');
  });
});

describe('SessionsTab derives true session status (row 10)', () => {
  it('shows "Transcript failed" for a completed session whose transcript failed', () => {
    renderTab([
      buildEvent({ id: 'e1', event_type: 'session_completed', transcript_status: 'failed' })
    ]);
    expect(screen.getByText('Transcript failed')).toBeInTheDocument();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });

  it('shows "Declined consent", not "Abandoned", when consent was declined', () => {
    renderTab([
      buildEvent({ id: 'e1', event_type: 'session_abandoned', consent_declined: true })
    ]);
    expect(screen.getByText('Declined consent')).toBeInTheDocument();
    expect(screen.queryByText('Abandoned')).not.toBeInTheDocument();
  });

  it('leaves a plain abandon as "Abandoned" when consent was not declined', () => {
    renderTab([
      buildEvent({ id: 'e1', event_type: 'session_abandoned', consent_declined: false })
    ]);
    expect(screen.getByText('Abandoned')).toBeInTheDocument();
    expect(screen.queryByText('Declined consent')).not.toBeInTheDocument();
  });

  it('leaves a cleanly completed session as "Completed"', () => {
    renderTab([
      buildEvent({ id: 'e1', event_type: 'session_completed', transcript_status: 'complete' })
    ]);
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.queryByText('Transcript failed')).not.toBeInTheDocument();
  });
});
