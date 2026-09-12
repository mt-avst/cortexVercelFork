import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import SessionReview from '../SessionReview';
import { getSessionOutputs, getOpportunitySessionEvents } from '../../api/client';
import { groupEventsBySession } from '../../components/opportunity-analytics/SessionsTab';
import type { SessionEvent } from '../../api/types';

// DA-25: the session review page knew one session and had no way to move
// between the study's others - the only control was "Back to Analytics". These
// pin prev/next with a "Session N of M" ordinal, and - the part that would feel
// random if it drifted - that the ordering matches the Sessions tab's, whether
// the order is handed over in router state (a click from the tab) or rebuilt on
// a cold load from the study's events.

// The load effect depends on `user`, so the mock MUST return a stable
// reference - a fresh object each render would re-fire the effect forever (the
// real AuthContext memoises it).
vi.mock('../../contexts/AuthContext', () => {
  const user = { id: 'a1', role: 'researcher_admin' };
  return { useAuth: () => ({ user, loading: false }) };
});
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
// The review body is not under test here; stub the sections so a minimal
// outputs object is enough and the nav is what renders.
vi.mock('../../components/session-review/SessionSummaryCard', () => ({ default: () => <div data-testid="summary" /> }));
vi.mock('../../components/session-review/ResponsesSection', () => ({ default: () => <div /> }));
vi.mock('../../components/session-review/TranscriptSection', () => ({ default: () => <div /> }));
vi.mock('../../components/session-review/AssetsSection', () => ({ default: () => <div /> }));

vi.mock('../../api/client', () => ({
  getSessionOutputs: vi.fn(),
  getOpportunitySessionEvents: vi.fn(),
}));

const outputsFor = (sessionId: string) => ({
  session: { participant: { display_name: `Participant ${sessionId}` }, transcript_status: 'ready', transcript_failure_message: null },
  steps: [],
  assets: [],
  transcript: null,
});

const event = (sessionId: string, occurredAt: string): SessionEvent => ({
  id: `evt-${sessionId}`,
  opportunity_id: 'opp1',
  participant_user_id: null,
  firsthand_session_id: sessionId,
  event_type: 'session_completed',
  occurred_at: occurredAt,
  received_at: occurredAt,
});

const renderAt = (sessionId: string, state?: unknown) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: `/admin/opportunities/opp1/sessions/${sessionId}/review`, state }]}>
      <Routes>
        <Route path="/admin/opportunities/:id/sessions/:sessionId/review" element={<SessionReview />} />
      </Routes>
    </MemoryRouter>
  );

const settled = async () => {
  for (let i = 0; i < 150 && !screen.queryByTestId('summary'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(screen.queryByTestId('summary')).not.toBeNull();
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(getSessionOutputs).mockImplementation(async (_id, sessionId) => outputsFor(sessionId) as never);
  vi.mocked(getOpportunitySessionEvents).mockResolvedValue([] as never);
});

describe('prev/next when the order is handed over in router state', () => {
  const order = ['s1', 's2', 's3'];

  it('shows the ordinal and moves to the next sibling, carrying the order forward', async () => {
    renderAt('s2', { sessionOrder: order });
    await settled();

    expect(screen.getByText('Session 2 of 3')).toBeTruthy();
    const next = screen.getByRole('button', { name: /next session/i });
    const prev = screen.getByRole('button', { name: /previous session/i });
    expect((next as HTMLButtonElement).disabled).toBe(false);
    expect((prev as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(next);
    await settled();
    // Order carried forward, so the ordinal still resolves against 3 sessions.
    expect(screen.getByText('Session 3 of 3')).toBeTruthy();
    expect((screen.getByRole('button', { name: /next session/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables Previous on the first session', async () => {
    renderAt('s1', { sessionOrder: order });
    await settled();
    expect(screen.getByText('Session 1 of 3')).toBeTruthy();
    expect((screen.getByRole('button', { name: /previous session/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('cold load rebuilds the order from the study events, matching the Sessions tab', () => {
  // Deliberately unsorted, with the newest NOT first, so a wrong ordering shows.
  const events = [
    event('s1', '2026-09-01T09:00:00.000Z'),
    event('s2', '2026-09-03T09:00:00.000Z'),
    event('s3', '2026-09-02T09:00:00.000Z'),
  ];
  // The Sessions tab's own function is the oracle for the expected order.
  const expectedOrder = groupEventsBySession(events).map((s) => s.sessionId); // [s2, s3, s1]

  it('derives "Session N of M" from the same order groupEventsBySession produces', async () => {
    vi.mocked(getOpportunitySessionEvents).mockResolvedValue(events as never);

    // Middle of the derived order is s3 (expectedOrder[1]).
    renderAt(expectedOrder[1]);
    await settled();
    // Wait for the fetched order to land.
    for (let i = 0; i < 150 && !screen.queryByText(/Session \d+ of \d+/); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const ordinal = expectedOrder.indexOf(expectedOrder[1]) + 1;
    expect(screen.getByText(`Session ${ordinal} of ${expectedOrder.length}`)).toBeTruthy();
    expect(screen.getByText('Session 2 of 3')).toBeTruthy();
  });
});
