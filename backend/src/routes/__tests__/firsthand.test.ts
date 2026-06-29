import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';

// ─── Mocks (factories use only inline jest.fn() to avoid TDZ) ────────────────
jest.mock('../../config', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../utils/firsthand-client', () => ({
  isFirstHandConfigured: jest.fn(),
  firstHandGet: jest.fn(),
}));
jest.mock('../../utils/database', () => ({ isDatabaseAvailable: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── Typed references to mocked functions ────────────────────────────────────
import firsthandRouter from '../firsthand';
import { pool } from '../../config';
import { isFirstHandConfigured, firstHandGet } from '../../utils/firsthand-client';
import { isDatabaseAvailable } from '../../utils/database';

const mockQuery = (pool.query as jest.MockedFunction<typeof pool.query>);
const mockIsFirstHandConfigured = (isFirstHandConfigured as jest.MockedFunction<typeof isFirstHandConfigured>);
const mockFirstHandGet = (firstHandGet as jest.MockedFunction<typeof firstHandGet>);
const mockIsDatabaseAvailable = (isDatabaseAvailable as jest.MockedFunction<typeof isDatabaseAvailable>);

// ─── Constants ────────────────────────────────────────────────────────────────
const TEST_SECRET = 'test-firsthand-secret-32charslongXYZ';

function signedBody(body: object): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const sig = crypto
    .createHmac('sha256', TEST_SECRET)
    .update(`${timestamp}\n${rawBody}`)
    .digest('hex');
  return {
    rawBody,
    headers: { 'x-firsthand-signature': sig, 'x-firsthand-timestamp': timestamp },
  };
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(
  express.json({
    verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  })
);
app.use((req: any, _res, next) => {
  req.session = {
    user: { id: 'admin-1', name: 'Admin', email: 'admin@test.com', role: 'researcher_admin' },
  };
  req.user = req.session.user;
  next();
});
app.use('/api/firsthand', firsthandRouter);
app.use((err: any, _req: any, res: any, _next: any) => {
  res.status(err.status || 500).json({ error: err.message || 'server_error' });
});

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('FirstHand Express router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FIRSTHAND_INTEGRATION_SECRET = TEST_SECRET;
    mockIsFirstHandConfigured.mockReturnValue(true);
    mockIsDatabaseAvailable.mockResolvedValue(true);
    (mockQuery as any).mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    delete process.env.FIRSTHAND_INTEGRATION_SECRET;
  });

  // ── GET /studies ──────────────────────────────────────────────────────────
  describe('GET /api/firsthand/studies', () => {
    it('returns 503 when FirstHand not configured', async () => {
      mockIsFirstHandConfigured.mockReturnValue(false);
      const res = await request(app).get('/api/firsthand/studies').expect(503);
      expect(res.body).toMatchObject({ error: 'firsthand_not_configured', studies: [] });
    });

    it('proxies study list from FirstHand and returns it', async () => {
      const studies = [{ id: 's-1', title: 'Usability Study', status: 'launched' }];
      (mockFirstHandGet as any).mockResolvedValue({ studies });
      const res = await request(app).get('/api/firsthand/studies').expect(200);
      expect(res.body).toEqual({ studies });
      expect(mockFirstHandGet).toHaveBeenCalledWith('/api/studies');
    });

    it('propagates FirstHand client errors as 500', async () => {
      (mockFirstHandGet as any).mockRejectedValue(new Error('upstream down'));
      await request(app).get('/api/firsthand/studies').expect(500);
    });
  });

  // ── POST /callbacks ───────────────────────────────────────────────────────
  describe('POST /api/firsthand/callbacks', () => {
    it('rejects bad HMAC → 401', async () => {
      const res = await request(app)
        .post('/api/firsthand/callbacks')
        .set('x-firsthand-signature', 'deadbeefdeadbeef')
        .set('x-firsthand-timestamp', Date.now().toString())
        .send({ event: 'session_started', session_id: 's1', occurred_at: '2026-01-01T00:00:00Z' });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'invalid_signature' });
    });

    it('rejects stale timestamp (>5 min old) → 401', async () => {
      const staleTs = (Date.now() - 400_000).toString();
      const raw = JSON.stringify({
        event: 'session_started', session_id: 's1', occurred_at: '2026-01-01T00:00:00Z',
      });
      const sig = crypto.createHmac('sha256', TEST_SECRET)
        .update(`${staleTs}\n${raw}`)
        .digest('hex');
      const res = await request(app)
        .post('/api/firsthand/callbacks')
        .set('x-firsthand-signature', sig)
        .set('x-firsthand-timestamp', staleTs)
        .type('json').send(raw);
      expect(res.status).toBe(401);
    });

    it('rejects missing timestamp header → 401', async () => {
      const body = { event: 'session_started', session_id: 's1', occurred_at: '2026-01-01T00:00:00Z' };
      const { rawBody, headers } = signedBody(body);
      const res = await request(app)
        .post('/api/firsthand/callbacks')
        .set('x-firsthand-signature', headers['x-firsthand-signature'])
        .type('json').send(rawBody);
      expect(res.status).toBe(401);
    });

    it('returns 401 when FIRSTHAND_INTEGRATION_SECRET not set', async () => {
      delete process.env.FIRSTHAND_INTEGRATION_SECRET;
      const res = await request(app)
        .post('/api/firsthand/callbacks')
        .set('x-firsthand-signature', 'any')
        .set('x-firsthand-timestamp', Date.now().toString())
        .send({ event: 'session_started', session_id: 's1', occurred_at: '2026-01-01T00:00:00Z' });
      expect(res.status).toBe(401);
    });

    it('returns 400 for missing required fields', async () => {
      const body = { event: 'session_started' }; // missing session_id and occurred_at
      const { rawBody, headers } = signedBody(body);
      const res = await request(app)
        .post('/api/firsthand/callbacks')
        .set(headers).type('json').send(rawBody);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'missing_fields' });
    });

    it('returns 400 for unknown event_type', async () => {
      const body = { event: 'mystery_event', session_id: 's1', occurred_at: '2026-01-01T00:00:00Z' };
      const { rawBody, headers } = signedBody(body);
      const res = await request(app)
        .post('/api/firsthand/callbacks')
        .set(headers).type('json').send(rawBody);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'unknown_event_type', event: 'mystery_event' });
    });

    it.each(['session_started', 'session_completed', 'session_abandoned', 'session_failed'])(
      'accepts known event_type "%s" → 200 {received:true}',
      async (event) => {
        const body = {
          event, session_id: `s-${event}`, occurred_at: '2026-01-01T00:00:00Z', external_ref: 'opp-1',
        };
        const { rawBody, headers } = signedBody(body);
        const res = await request(app)
          .post('/api/firsthand/callbacks')
          .set(headers).type('json').send(rawBody);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true });
      }
    );

    it('INSERT SQL includes ON CONFLICT (firsthand_session_id, event_type) DO NOTHING', async () => {
      const body = {
        event: 'session_started', session_id: 's1', occurred_at: '2026-01-01T00:00:00Z',
        external_ref: 'opp-abc', participant_id: 'p-xyz',
      };
      const { rawBody, headers } = signedBody(body);
      await request(app).post('/api/firsthand/callbacks').set(headers).type('json').send(rawBody);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params]: any[] = (mockQuery as any).mock.calls[0];
      expect(sql).toContain('ON CONFLICT (firsthand_session_id, event_type) DO NOTHING');
      expect(params).toContain('opp-abc');
      expect(params).toContain('s1');
      expect(params).toContain('session_started');
    });

    it('skips DB insert when external_ref absent → still 200', async () => {
      const body = { event: 'session_started', session_id: 's1', occurred_at: '2026-01-01T00:00:00Z' };
      const { rawBody, headers } = signedBody(body);
      const res = await request(app)
        .post('/api/firsthand/callbacks')
        .set(headers).type('json').send(rawBody);
      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('swallows DB error and still returns 200', async () => {
      (mockQuery as any).mockRejectedValue(new Error('db connection lost'));
      const body = {
        event: 'session_started', session_id: 's1', occurred_at: '2026-01-01T00:00:00Z', external_ref: 'opp-1',
      };
      const { rawBody, headers } = signedBody(body);
      const res = await request(app)
        .post('/api/firsthand/callbacks')
        .set(headers).type('json').send(rawBody);
      expect(res.status).toBe(200);
    });

    it('skips DB when database is unavailable → still 200', async () => {
      mockIsDatabaseAvailable.mockResolvedValue(false);
      const body = {
        event: 'session_started', session_id: 's1', occurred_at: '2026-01-01T00:00:00Z', external_ref: 'opp-1',
      };
      const { rawBody, headers } = signedBody(body);
      const res = await request(app)
        .post('/api/firsthand/callbacks')
        .set(headers).type('json').send(rawBody);
      expect(res.status).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
