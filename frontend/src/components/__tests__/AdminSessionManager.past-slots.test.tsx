import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminSessionManager, {
  slotIsPast,
  PAST_SLOT_GRACE_MS,
} from '../AdminSessionManager';
import { getAvailability } from '../../api/client';

/**
 * cto/AdaptaLabs#101. With #90 the create routes refuse a past start
 * server-side; the grid must not offer one for selection, or a researcher can
 * pick already-past slots and have the whole batch refused at Confirm.
 *
 * The predicate is pinned directly because a render-time proof would depend on
 * the wall-clock hour the suite runs at (which today is past, which future),
 * and jsdom has no layout - so the deterministic assertion is on `slotIsPast`
 * and on the date input's `min`, not on a clicked pixel.
 */

vi.mock('../../api/client', () => ({
  getAvailability: vi.fn(async () => ({
    available_slots: [],
    total_slots: 0,
    duration_minutes: 30,
    time_range: { start: new Date().toISOString(), end: new Date().toISOString() },
  })),
  getMyCalendarEvents: vi.fn(async () => []),
  createSessions: vi.fn(async () => []),
  deleteAllSessions: vi.fn(async () => undefined),
  deleteSession: vi.fn(async () => undefined),
}));

vi.mock('../../utils/navigation', () => ({
  navigation: { toAdmin: vi.fn() },
}));

describe('slotIsPast (#101)', () => {
  it('mirrors the server grace as a literal (NEW_SESSION_PAST_GRACE_MS)', () => {
    expect(PAST_SLOT_GRACE_MS).toBe(60_000);
  });

  it('refuses a start more than the grace in the past', () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    expect(slotIsPast({ start: twoMinutesAgo })).toBe(true);
  });

  it('accepts a start within the grace (clock skew) so "now" is never refused', () => {
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString();
    expect(slotIsPast({ start: thirtySecondsAgo })).toBe(false);
  });

  it('accepts any future start', () => {
    const inOneHour = new Date(Date.now() + 60 * 60_000).toISOString();
    expect(slotIsPast({ start: inOneHour })).toBe(false);
  });
});

describe('AdminSessionManager Start Date input (#101)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    vi.mocked(getAvailability).mockResolvedValue({
      available_slots: [],
      total_slots: 0,
      duration_minutes: 30,
      time_range: { start: new Date().toISOString(), end: new Date().toISOString() },
    } as never);
  });

  it('does not offer a past day: min is today', async () => {
    render(
      <MemoryRouter>
        <AdminSessionManager
          opportunityId="opp-1"
          sessions={[]}
          onSessionsChange={vi.fn()}
          defaultDurationMinutes={30}
        />
      </MemoryRouter>
    );

    const input = (await screen.findByLabelText('Start Date')) as HTMLInputElement;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    expect(input).toHaveAttribute('min', today);
  });
});
