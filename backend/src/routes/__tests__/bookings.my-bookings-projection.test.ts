import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

import bookingsRouter from '../bookings';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * GET /api/bookings/my/bookings - the participant's own bookings, and the
 * route on which this repository has ALREADY shipped a researcher-only column
 * to the participant it was about (`admin_notes`, recorded at
 * learnings.md:349 and quoted in the route's own docblock).
 *
 * Its sibling `/my/bookings/all` has been pinned both ways since #54
 * (bookings.cleanup-cancelled-is-gone.test.ts). This route was not, and #79
 * added `researcher_notes` - a strictly more sensitive field than the one
 * that leaked - to the same table.
 *
 * A security refute gate measured the gap rather than asserting it: appending
 * `b.researcher_notes` to `participantBookingColumns` passed 93 suites / 1537
 * tests, and the response map spreads the row (`{...booking}`), so the leak
 * would have reached the participant's Network tab with the whole backend
 * suite green. This file closes that.
 */
const CALLER_ID = 'participant-1';

const appAsParticipant = () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user: { id: string; name: string; email: string; role: string } } }).session = {
      user: { id: CALLER_ID, name: 'P', email: 'p@example.com', role: 'employee' },
    };
    next();
  });
  app.use('/api/bookings', bookingsRouter);
  app.use(errorHandler);
  return app;
};

/**
 * A row carrying every researcher-only column, even though the narrowed
 * projection means production never selects them. A fixture built from only
 * the columns the query asks for cannot tell a narrowed projection from a
 * lucky one, and would go green again the moment somebody widened it.
 */
const ROW = {
  id: 'b1',
  user_id: CALLER_ID,
  session_id: 's1',
  status: 'booked',
  completion_status: 'pending',
  completed_at: null,
  cancelled_at: null,
  gcal_event_id: null,
  reminder_sent_at: null,
  created_at: new Date('2026-01-01T09:00:00.000Z'),
  updated_at: new Date('2026-01-01T09:00:00.000Z'),
  session_start_time: new Date('2026-01-02T10:00:00.000Z'),
  session_end_time: new Date('2026-01-02T11:00:00.000Z'),
  session_capacity: 1,
  session_location: null,
  opportunity_title: 'Checkout walk-through',
  opportunity_type: 'test',
  opportunity_purpose: 'See where people stall',
  owner_name: 'Ann Owner',
  owner_email: 'ann@example.com',
  researcher_notes: 'froze up when asked about the dashboard',
  researcher_notes_updated_at: new Date('2026-01-02T11:05:00.000Z'),
  researcher_notes_updated_by: 'researcher-9',
  admin_notes: 'flaky attendance, do not re-invite',
  approved_by: 'researcher-9',
  approved_at: new Date('2026-01-03T09:00:00.000Z'),
};

describe('GET /api/bookings/my/bookings keeps researcher-only columns off the wire', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
  });

  it('sends no researcher-only column to the participant, whatever the row carries', async () => {
    // Two queries: upcoming, then past. Both get the loaded row.
    mockQuery.mockResolvedValue({ rows: [ROW] } as never);

    const res = await request(listening(appAsParticipant()))
      .get('/api/bookings/my/bookings')
      .expect(200);

    // THE CONTROL for the absences below. Without it every assertion passes
    // against an empty response, a 500 body, or a route returning nothing.
    expect(res.body.upcoming).toHaveLength(1);
    expect(res.body.upcoming[0].opportunity_title).toBe('Checkout walk-through');

    // Over the whole serialised body rather than key-by-key, so a field
    // renamed on the way out - `notes`, `internal_notes` - is caught by its
    // VALUE even when its key is not one of the names below.
    const wire = JSON.stringify(res.body);
    for (const secret of [
      'researcher_notes',
      'froze up when asked about the dashboard',
      'admin_notes',
      'flaky attendance, do not re-invite',
      'approved_by',
      'approved_at',
      'researcher-9',
    ]) {
      expect({ secret, onTheWire: wire.includes(secret) }).toEqual({
        secret,
        onTheWire: false,
      });
    }
  });

  it('narrows at the PROJECTION, which is the outer of the two guards', async () => {
    // TWO LAYERS, EACH KILLABLE ALONE. The projection asserted here keeps a
    // researcher-only column out of the handler; the named field map
    // asserted by the test above keeps one off the wire if the projection is
    // ever widened. The map used to be a spread, which is why it was worth
    // nothing - re-spreading it now fails the test above, and widening the
    // projection fails this one.
    mockQuery.mockResolvedValue({ rows: [ROW] } as never);

    await request(listening(appAsParticipant()))
      .get('/api/bookings/my/bookings')
      .expect(200);

    const statements = mockQuery.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(statements).toHaveLength(2);
    for (const sql of statements) {
      expect(sql).not.toContain('b.*');
      expect(sql).toContain(
        'b.id, b.user_id, b.session_id, b.status, b.completion_status, b.completed_at'
      );
      expect(sql).not.toContain('researcher_notes');
      expect(sql).not.toContain('admin_notes');
    }
  });
});
