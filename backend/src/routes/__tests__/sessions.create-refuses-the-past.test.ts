import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// The session-trusting auth double, as every route suite here uses (#14/#37).
jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  redactSensitiveUrl: (url: string) => url,
}));
jest.mock('../../utils/opportunityLifecycle', () => ({
  autoCloseOpportunityIfNeeded: jest.fn(async () => undefined),
}));
// Outside src, so it MUST be mocked; the path is relative to THIS file.
jest.mock('../../../../demo/mock-data', () => ({
  getMockOpportunity: jest.fn(),
  addMockSessions: jest.fn(),
  getMockSessions: jest.fn(),
  getAllMockSessions: jest.fn(),
  updateMockSession: jest.fn(),
  deleteMockSession: jest.fn(),
}));

import sessionsRouter from '../sessions';
import opportunitiesRouter from '../opportunities';
import { pool } from '../../config';
import { getMockOpportunity, addMockSessions, getAllMockSessions, updateMockSession } from '../../../../demo/mock-data';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';
import {
  NEW_SESSION_PAST_GRACE_MS,
  validateNewSessionData,
  validateSessionData,
} from '../../validation/schemas';

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

/**
 * A NEW SESSION MUST NOT START IN THE PAST, AND THE SERVER IS THE ONE SAYING
 * SO. cto/AdaptaLabs#90.
 *
 * The future-time rule used to live in the browser only (the manual add-slot
 * control), so a direct POST created a 1999 session - and the booking route's
 * temporal guard reads END time, so a past-start session with a future end
 * was fully BOOKABLE, not mere clutter (the security gate demonstrated it).
 * `validateNewSessionData` is the create-only home for the rule;
 * `validateSessionData` stays shared with the UPDATE path, where a session
 * KEEPING the past start it already has is legitimate. Moving one INTO the
 * past via PATCH is refused separately - see the retiming describe below.
 *
 * The refusal SENTENCE is asserted at the validator, not on the wire: the
 * errorHandler's AppError branch sends `error.message` and drops the details
 * array, so the route-level proof is the 400/201 pair on bodies identical but
 * for the start time.
 */

const OWNER = { id: 'admin-1', name: 'Olive', email: 'olive@example.com' };
const OPP = 'opp-90';

const inMs = (deltaMs: number) => new Date(Date.now() + deltaMs).toISOString();
const HOUR = 60 * 60 * 1000;

const sessionAt = (startDeltaMs: number) => ({
  start_time: inMs(startDeltaMs),
  end_time: inMs(startDeltaMs + HOUR),
  capacity: 3,
});

const appAsOwner = () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      user: { ...OWNER, role: 'researcher_admin' },
    };
    next();
  });
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
};

const oppAppAsOwner = () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      user: { ...OWNER, role: 'researcher_admin' },
    };
    next();
  });
  app.use('/api/opportunities', opportunitiesRouter);
  app.use(errorHandler);
  return app;
};

/** The batch-create transaction client: no overlaps, INSERT echoes its row. */
const makeClient = () => ({
  query: jest.fn(async (sql: unknown, params?: unknown[]) => {
    if (String(sql).includes('overlap_count')) {
      // checkSessionOverlaps reads rows[0].overlap_count; an empty rows array
      // is a 500, not a "no overlap".
      return { rows: [{ overlap_count: '0' }], rowCount: 1 };
    }
    if (String(sql).toUpperCase().includes('INSERT INTO SESSIONS')) {
      const p = (params ?? []) as [string, string, string, number, number, string | null];
      const now = new Date();
      return {
        rows: [{
          id: 's-created',
          opportunity_id: p[0],
          start_time: new Date(p[1]),
          end_time: new Date(p[2]),
          capacity: p[3],
          booked_count: p[4],
          location_or_meet_link_optional: p[5],
          created_at: now,
          updated_at: now,
          remaining: p[3],
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }),
  release: jest.fn(),
});

describe('POST /api/sessions refuses a session in the past (cto/AdaptaLabs#90)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('FROM opportunities')) {
        return { rows: [{ owner_user_id: OWNER.id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    mockConnect.mockResolvedValue(makeClient() as never);
  });

  it('answers 400 to a past session and opens no transaction', async () => {
    const res = await request(listening(appAsOwner()))
      .post('/api/sessions')
      .send({ opportunity_id: OPP, sessions: [sessionAt(-24 * HOUR)] });

    expect(res.status).toBe(400);
    // THE BOUND ON BLAST RADIUS: refused before any client is taken, so
    // nothing is written and nothing is left half-created.
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('refuses a mixed batch outright rather than creating the valid half', async () => {
    const res = await request(listening(appAsOwner()))
      .post('/api/sessions')
      .send({ opportunity_id: OPP, sessions: [sessionAt(2 * HOUR), sessionAt(-2 * HOUR)] });

    expect(res.status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('control: the same shape with a future start is created', async () => {
    // Without this arm, a handler refusing EVERYTHING would pass both tests
    // above. Identical body but for the start time.
    const res = await request(listening(appAsOwner()))
      .post('/api/sessions')
      .send({ opportunity_id: OPP, sessions: [sessionAt(2 * HOUR)] });

    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
  });

  it('mock branch: the no-database path refuses the past too', async () => {
    // sessions.ts has its own dev-only branch with its own call site; without
    // this arm, reverting THAT one to the shared validator is invisible.
    mockIsDatabaseAvailable.mockResolvedValue(false as never);
    (getMockOpportunity as unknown as jest.Mock).mockReturnValue({
      id: OPP,
      owner_user_id: OWNER.id,
    } as never);

    const res = await request(listening(appAsOwner()))
      .post('/api/sessions')
      .send({ opportunity_id: OPP, sessions: [sessionAt(-24 * HOUR)] });

    expect(res.status).toBe(400);
    expect(addMockSessions).not.toHaveBeenCalled();
  });

  it('stores the instant it validated: the INSERT gets the normalised ISO form', async () => {
    // V8 and Postgres disagree on offset-less strings (an hour apart on this
    // machine), so inserting the raw input could store an instant the
    // past-start rule never saw. The textual form must be the normalised one.
    const client = makeClient();
    mockConnect.mockResolvedValue(client as never);
    const instant = Date.now() + 2 * HOUR;
    const offsetForm = new Date(instant).toISOString().replace('Z', '+00:00');

    await request(listening(appAsOwner()))
      .post('/api/sessions')
      .send({
        opportunity_id: OPP,
        sessions: [{ start_time: offsetForm, end_time: inMs(3 * HOUR), capacity: 2 }],
      })
      .expect(201);

    const insert = client.query.mock.calls.find((c: unknown[]) =>
      String(c[0]).toUpperCase().includes('INSERT INTO SESSIONS')
    ) as unknown[];
    const params = insert[1] as string[];
    expect(params[1]).toBe(new Date(instant).toISOString());
    expect(params[1]).not.toBe(offsetForm);
  });

  it('absorbs clock skew: a start seconds in the past is accepted', async () => {
    // A researcher picking "now" plus a request in flight must not be
    // refused. Thirty seconds is inside the one-minute grace.
    const res = await request(listening(appAsOwner()))
      .post('/api/sessions')
      .send({ opportunity_id: OPP, sessions: [sessionAt(-30 * 1000)] });

    expect(res.status).toBe(201);
  });
});

describe('POST /api/opportunities/:id/sessions refuses the past on both branches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('mock branch: 400 naming the rule, and nothing is added', async () => {
    // This route builds its 400 body directly, so the sentence IS on the wire
    // here - unlike the sessions router, whose errorHandler drops details.
    mockIsDatabaseAvailable.mockResolvedValue(false as never);
    (getMockOpportunity as unknown as jest.Mock).mockReturnValue({
      id: OPP,
      owner_user_id: OWNER.id,
    } as never);

    const res = await request(listening(oppAppAsOwner()))
      .post(`/api/opportunities/${OPP}/sessions`)
      .send([sessionAt(-24 * HOUR)]);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Start time must not be in the past');
    expect(addMockSessions).not.toHaveBeenCalled();
  });

  it('mock branch control: a future session is created', async () => {
    mockIsDatabaseAvailable.mockResolvedValue(false as never);
    (getMockOpportunity as unknown as jest.Mock).mockReturnValue({
      id: OPP,
      owner_user_id: OWNER.id,
    } as never);
    (addMockSessions as unknown as jest.Mock).mockReturnValue([{ id: 's1' }] as never);

    const res = await request(listening(oppAppAsOwner()))
      .post(`/api/opportunities/${OPP}/sessions`)
      .send([sessionAt(2 * HOUR)]);

    expect(res.status).toBe(201);
  });

  it('database branch: 400 before any client is taken', async () => {
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('FROM opportunities')) {
        return { rows: [{ owner_user_id: OWNER.id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    mockConnect.mockResolvedValue(makeClient() as never);

    const res = await request(listening(oppAppAsOwner()))
      .post(`/api/opportunities/${OPP}/sessions`)
      .send([sessionAt(-24 * HOUR)]);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Start time must not be in the past');
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

describe('POST /api/opportunities/:id/sessions normalises what it stores', () => {
  it('database branch: the INSERT gets the normalised ISO form', async () => {
    // The sibling pin to the sessions-router one: without it, reverting THIS
    // route's normalisation passed the whole suite (the re-gate measured it).
    jest.clearAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('FROM opportunities')) {
        return { rows: [{ owner_user_id: OWNER.id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = makeClient();
    mockConnect.mockResolvedValue(client as never);
    const instant = Date.now() + 2 * HOUR;
    const offsetForm = new Date(instant).toISOString().replace('Z', '+00:00');

    await request(listening(oppAppAsOwner()))
      .post(`/api/opportunities/${OPP}/sessions`)
      .send([{ start_time: offsetForm, end_time: inMs(3 * HOUR), capacity: 2 }])
      .expect(201);

    const insert = client.query.mock.calls.find((c: unknown[]) =>
      String(c[0]).toUpperCase().includes('INSERT INTO SESSIONS')
    ) as unknown[];
    const params = insert[1] as string[];
    expect(params[1]).toBe(new Date(instant).toISOString());
    expect(params[1]).not.toBe(offsetForm);
  });
});

describe('the create-only validator itself', () => {
  it('names the refusal', () => {
    expect(validateNewSessionData(sessionAt(-24 * HOUR))).toContain(
      'Start time must not be in the past'
    );
  });

  it('accepts within the grace window and refuses beyond it', () => {
    expect(validateNewSessionData(sessionAt(-NEW_SESSION_PAST_GRACE_MS / 2))).toEqual([]);
    expect(
      validateNewSessionData(sessionAt(-(NEW_SESSION_PAST_GRACE_MS + 5000)))
    ).toContain('Start time must not be in the past');
  });

  it('pins the grace as a literal', () => {
    // A policy constant: widening it silently is a decision a diff must show.
    expect(NEW_SESSION_PAST_GRACE_MS).toBe(60_000);
  });

  it('refuses an absent start or end time with a 400-shaped error, not a 500', () => {
    // Pre-existing hole the gates measured: a create body with no start_time
    // passed both validators silently and died at the NOT NULL constraint -
    // 201 on the mock branch, 500 on the database branch.
    expect(
      validateNewSessionData({ end_time: inMs(HOUR), capacity: 1 } as never)
    ).toContain('Start time is required');
    expect(
      validateNewSessionData({ start_time: inMs(HOUR), capacity: 1 } as never)
    ).toContain('End time is required');
  });

  it('gives a non-string start the type sentence, not the past-start one', () => {
    // new Date(null) is the epoch, not NaN - without the type check, null
    // earned 'must not be in the past', which sends the caller to fix a date
    // they never sent.
    for (const bad of [null, 0, true, ['2999-01-01']]) {
      const errors = validateNewSessionData({
        start_time: bad,
        end_time: inMs(HOUR),
        capacity: 1,
      } as never);
      expect(errors).toContain('Start time must be a valid ISO date string');
      expect(errors).not.toContain('Start time must not be in the past');
    }
  });

  it('does not double-report a malformed start time', () => {
    const errors = validateNewSessionData({
      start_time: 'not-a-date',
      end_time: inMs(HOUR),
      capacity: 1,
    });
    expect(errors).toContain('Start time must be a valid ISO date string');
    expect(errors).not.toContain('Start time must not be in the past');
  });

  it('the SHARED validator still accepts a past start, so the UPDATE path is untouched', () => {
    // The create-only property's other half. Folding the rule into
    // validateSessionData would refuse editing a session that has already
    // started - correcting a capacity mid-session is legitimate.
    expect(validateSessionData(sessionAt(-24 * HOUR))).toEqual([]);
  });
});

describe('PATCH /api/sessions/:id refuses moving a start into the past (mock branch)', () => {
  // The create rule was one request from undone: POST future, PATCH the start
  // to 1999 - and the booking guard reads END time, so the result was
  // bookable. Found by the security gate. A session KEEPING the past start it
  // already has stays editable: that is the legitimate case the create-only
  // exemption exists for.
  const PAST = inMs(-24 * HOUR);
  const NOW_START = inMs(-30 * 60 * 1000); // a session that started 30min ago

  const mockSession = (start: string) => ({
    id: 'sess-1',
    opportunity_id: OPP,
    start_time: start,
    end_time: inMs(2 * HOUR),
    capacity: 3,
    booked_count: 1,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(false as never);
    (getMockOpportunity as unknown as jest.Mock).mockReturnValue({
      id: OPP,
      owner_user_id: OWNER.id,
    } as never);
    (updateMockSession as unknown as jest.Mock).mockImplementation(
      ((_id: string, data: object) => ({ ...mockSession(inMs(2 * HOUR)), ...data })) as never
    );
  });

  it('refuses retiming a future session into the past, and writes nothing', async () => {
    (getAllMockSessions as unknown as jest.Mock).mockReturnValue([mockSession(inMs(2 * HOUR))] as never);

    const res = await request(listening(appAsOwner()))
      .patch('/api/sessions/sess-1')
      .send({ start_time: PAST });

    expect(res.status).toBe(400);
    expect(updateMockSession).not.toHaveBeenCalled();
  });

  it('still allows editing the capacity of a session that has already started', async () => {
    (getAllMockSessions as unknown as jest.Mock).mockReturnValue([mockSession(NOW_START)] as never);

    const res = await request(listening(appAsOwner()))
      .patch('/api/sessions/sess-1')
      .send({ capacity: 5 });

    expect(res.status).toBe(200);
  });

  it('allows a client that echoes the unchanged past start back', async () => {
    // Refusing the echo would break every editor that PATCHes whole objects.
    (getAllMockSessions as unknown as jest.Mock).mockReturnValue([mockSession(NOW_START)] as never);

    const res = await request(listening(appAsOwner()))
      .patch('/api/sessions/sess-1')
      .send({ start_time: NOW_START, capacity: 5 });

    expect(res.status).toBe(200);
  });

  it('control: retiming to a future start is allowed', async () => {
    (getAllMockSessions as unknown as jest.Mock).mockReturnValue([mockSession(inMs(2 * HOUR))] as never);

    const res = await request(listening(appAsOwner()))
      .patch('/api/sessions/sess-1')
      .send({ start_time: inMs(4 * HOUR), end_time: inMs(5 * HOUR) });

    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/sessions/:id refuses moving a start into the past (database branch)', () => {
  // The production path. The re-gate proved the mock-branch arms alone left
  // this guard deletable with the whole suite green - the exact enforcement
  // hole the security gate's finding was about.
  const FUTURE_START = new Date(Date.now() + 2 * HOUR);
  const FUTURE_END = new Date(Date.now() + 3 * HOUR);
  const PAST_STARTED = new Date(Date.now() - 30 * 60 * 1000);

  const dbSessionRow = (start: Date) => ({
    id: 'sess-db',
    opportunity_id: OPP,
    start_time: start,
    end_time: FUTURE_END,
    capacity: 3,
    booked_count: 1,
    location_or_meet_link_optional: null,
    created_at: new Date(),
    updated_at: new Date(),
  });

  const arrangeDb = (start: Date) => {
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('JOIN opportunities')) {
        return { rows: [{ owner_user_id: OWNER.id }], rowCount: 1 };
      }
      if (String(sql).includes('SELECT * FROM sessions')) {
        return { rows: [dbSessionRow(start)], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  };

  /** The update transaction client: no overlap, UPDATE echoes a full row. */
  const makeUpdateClient = () => ({
    query: jest.fn(async (sql: unknown, params?: unknown[]) => {
      if (String(sql).includes('overlap_count')) {
        return { rows: [{ overlap_count: '0' }], rowCount: 1 };
      }
      if (String(sql).toUpperCase().includes('UPDATE SESSIONS')) {
        return { rows: [{ ...dbSessionRow(FUTURE_START), remaining: 2, __params: params }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: jest.fn(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('refuses the retime before any transaction is opened', async () => {
    arrangeDb(FUTURE_START);

    const res = await request(listening(appAsOwner()))
      .patch('/api/sessions/sess-db')
      .send({ start_time: inMs(-24 * HOUR) });

    expect(res.status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('allows the echo of an unchanged past start, Date-typed as Postgres returns it', async () => {
    // currentSessionData.start_time is a pg Date here, not a string - the
    // asymmetry the mock branch cannot see. The client echoes what GET
    // serialised: date.toISOString().
    arrangeDb(PAST_STARTED);
    const client = makeUpdateClient();
    mockConnect.mockResolvedValue(client as never);

    const res = await request(listening(appAsOwner()))
      .patch('/api/sessions/sess-db')
      .send({ start_time: PAST_STARTED.toISOString(), capacity: 2 });

    expect(res.status).toBe(200);
  });

  it('normalises the times it writes: the UPDATE gets ISO forms, not raw input', async () => {
    // Same property as the create INSERT pin, on the update builder: the
    // instant pastRetimingError judged is the instant stored.
    arrangeDb(FUTURE_START);
    const client = makeUpdateClient();
    mockConnect.mockResolvedValue(client as never);
    const instant = Date.now() + 4 * HOUR;
    const offsetForm = new Date(instant).toISOString().replace('Z', '+00:00');

    await request(listening(appAsOwner()))
      .patch('/api/sessions/sess-db')
      .send({ start_time: offsetForm })
      .expect(200);

    const update = client.query.mock.calls.find((c: unknown[]) =>
      String(c[0]).toUpperCase().includes('UPDATE SESSIONS')
    ) as unknown[];
    const params = update[1] as string[];
    expect(params).toContain(new Date(instant).toISOString());
    expect(params).not.toContain(offsetForm);
  });

  it('a null start gets the type sentence, not the retiming one', async () => {
    arrangeDb(FUTURE_START);

    const res = await request(listening(appAsOwner()))
      .patch('/api/sessions/sess-db')
      .send({ start_time: null });

    expect(res.status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });
});
