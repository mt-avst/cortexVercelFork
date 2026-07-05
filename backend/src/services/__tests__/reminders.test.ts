import { describe, expect, it, jest } from '@jest/globals';

import { sendDueReminders, ReminderDeps } from '../reminders';

type QueryResult = { rows: unknown[] };

function buildRow(overrides: Record<string, unknown> = {}) {
  return {
    booking_id: 'booking-1',
    user_id: 'user-1',
    session_id: 'session-1',
    start_time: new Date('2026-07-06T10:00:00Z'),
    end_time: new Date('2026-07-06T10:30:00Z'),
    opportunity_title: 'Usability study',
    meeting_location_optional: null,
    owner_user_id: 'owner-1',
    participant_name: 'Pat Participant',
    participant_email: 'pat@example.com',
    owner_name: 'Rowan Researcher',
    ...overrides,
  };
}

function buildDeps(rows: unknown[], emailResult: { success: boolean; error?: string }) {
  const query = jest.fn<(text: string, params?: unknown[]) => Promise<QueryResult>>()
    .mockImplementation(async (text: string) =>
      text.trimStart().startsWith('SELECT') ? { rows } : { rows: [] }
    );
  const sendEmail = jest.fn<ReminderDeps['sendEmail']>().mockResolvedValue(emailResult);
  return { deps: { query, sendEmail } as ReminderDeps, query, sendEmail };
}

describe('sendDueReminders', () => {
  it('sends a reminder for each due booking and marks it sent', async () => {
    const { deps, query, sendEmail } = buildDeps([buildRow()], { success: true });

    const summary = await sendDueReminders(deps);

    expect(summary).toEqual({ sent: 1, errors: 0, total: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual({
      email: 'pat@example.com',
      name: 'Pat Participant',
    });

    const updateCall = query.mock.calls.find(([text]) =>
      String(text).includes('UPDATE bookings SET reminder_sent_at')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toEqual(['booking-1']);
  });

  it('does not mark the booking when the email fails, and counts the error', async () => {
    const { deps, query } = buildDeps([buildRow()], {
      success: false,
      error: 'smtp down',
    });

    const summary = await sendDueReminders(deps);

    expect(summary).toEqual({ sent: 0, errors: 1, total: 1 });
    const updateCall = query.mock.calls.find(([text]) =>
      String(text).includes('UPDATE bookings SET reminder_sent_at')
    );
    expect(updateCall).toBeUndefined();
  });

  it('returns an empty summary when nothing is due', async () => {
    const { deps, sendEmail } = buildDeps([], { success: true });

    const summary = await sendDueReminders(deps);

    expect(summary).toEqual({ sent: 0, errors: 0, total: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('continues past a booking whose send throws', async () => {
    const rows = [buildRow(), buildRow({ booking_id: 'booking-2', participant_email: 'sam@example.com' })];
    const query = jest.fn<(text: string, params?: unknown[]) => Promise<QueryResult>>()
      .mockImplementation(async (text: string) =>
        text.trimStart().startsWith('SELECT') ? { rows } : { rows: [] }
      );
    const sendEmail = jest.fn<ReminderDeps['sendEmail']>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ success: true });

    const summary = await sendDueReminders({ query, sendEmail });

    expect(summary).toEqual({ sent: 1, errors: 1, total: 2 });
  });

  it('queries a window of sessions starting roughly a day out', async () => {
    const { deps, query } = buildDeps([], { success: true });

    await sendDueReminders(deps);

    const [selectText, selectParams] = query.mock.calls[0];
    expect(String(selectText)).toContain('reminder_sent_at IS NULL');
    expect(selectParams?.[0]).toBe('booked');
    const windowStart = new Date(String(selectParams?.[1]));
    const windowEnd = new Date(String(selectParams?.[2]));
    const hoursAhead = (windowStart.getTime() - Date.now()) / 3_600_000;
    expect(hoursAhead).toBeGreaterThan(22);
    expect(hoursAhead).toBeLessThan(24);
    expect((windowEnd.getTime() - windowStart.getTime()) / 3_600_000).toBeCloseTo(2, 0);
  });
});
