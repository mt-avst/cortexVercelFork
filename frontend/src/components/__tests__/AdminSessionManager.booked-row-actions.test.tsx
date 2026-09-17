import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { getAvailability } from '../../api/client';

/**
 * Row 20 of the 2026-09-17 study-setup redesign.
 *
 * A booked row's Actions cell rendered three lines of danger-red prose
 * ("Cannot remove: 1 booking") on a perfectly healthy row - a participant has
 * booked it, which is the point of the feature, not a fault. It gets a neutral
 * grey "N booked" tag instead, and no trash control at all (there was never a
 * live one to disable: booked rows cannot be removed from here).
 *
 * The meeting link was also truncated with no way to get the untruncated value
 * - a copy control is added alongside it.
 */

vi.mock('../../api/client', () => ({
  getAvailability: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  createSessions: vi.fn(async () => []),
  deleteSession: vi.fn(async () => undefined),
  deleteAllSessions: vi.fn(async () => undefined),
}));

vi.mock('../../utils/navigation', () => ({
  navigation: { toAdmin: vi.fn() },
}));

type ManagerProps = React.ComponentProps<typeof AdminSessionManager>;

const renderManager = (props: Partial<ManagerProps> = {}) =>
  render(
    <MemoryRouter>
      <AdminSessionManager
        opportunityId="opp-1"
        sessions={[]}
        onSessionsChange={vi.fn()}
        defaultDurationMinutes={30}
        {...props}
      />
    </MemoryRouter>
  );

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

const daysAhead = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};

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

describe('AdminSessionManager - a booked row states its state calmly (row 20)', () => {
  it('shows a grey "N booked" tag and no trash control, not three lines of danger prose', async () => {
    const start = daysAhead(3);
    const end = new Date(start.getTime() + 45 * 60 * 1000);
    renderManager({
      sessions: [
        {
          id: 'booked-1',
          opportunity_id: 'opp-1',
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          capacity: 1,
          booked_count: 1,
          remaining: 0,
          location_or_meet_link_optional: 'https://meet.google.com/abc-defg-hij',
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        },
      ] as never,
    });
    await settle();

    const table = await screen.findByRole('table');
    expect(within(table).queryByText(/Cannot remove/i)).not.toBeInTheDocument();
    expect(within(table).getByText('1 booked')).toBeInTheDocument();
    expect(
      within(table).queryByRole('button', { name: /Remove session on/i })
    ).not.toBeInTheDocument();
  });

  it('offers a control that copies the full meeting link', async () => {
    const start = daysAhead(3);
    const end = new Date(start.getTime() + 45 * 60 * 1000);
    const fullLink = 'https://meet.google.com/abc-defg-hij-a-very-long-meeting-code';
    renderManager({
      sessions: [
        {
          id: 'booked-1',
          opportunity_id: 'opp-1',
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          capacity: 1,
          booked_count: 0,
          remaining: 1,
          location_or_meet_link_optional: fullLink,
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        },
      ] as never,
    });
    await settle();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const copyButton = await screen.findByRole('button', { name: /copy meeting link/i });
    fireEvent.click(copyButton);
    await settle();

    expect(writeText).toHaveBeenCalledWith(fullLink);
  });

  it('announces the copy to a screen reader, not only via the title attribute (follow-up)', async () => {
    // `title` is a mouse-hover-only confirmation - a screen-reader user never
    // gets it. An aria-live region has to actually change text on success.
    const start = daysAhead(3);
    const end = new Date(start.getTime() + 45 * 60 * 1000);
    const fullLink = 'https://meet.google.com/abc-defg-hij-a-very-long-meeting-code';
    renderManager({
      sessions: [
        {
          id: 'booked-1',
          opportunity_id: 'opp-1',
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          capacity: 1,
          booked_count: 0,
          remaining: 1,
          location_or_meet_link_optional: fullLink,
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        },
      ] as never,
    });
    await settle();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const copyButton = await screen.findByRole('button', { name: /copy meeting link/i });
    fireEvent.click(copyButton);

    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});
