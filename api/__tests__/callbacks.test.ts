/**
 * Tests for api/firsthand/callbacks.ts
 * Uses a real Readable stream to exercise readRawBody(), mocks everything else.
 */
import { Readable } from 'stream';

// ─── Mocks (all factories use inline jest.fn() to avoid TDZ) ─────────────────
jest.mock('../db', () => ({ query: jest.fn(), getPool: jest.fn() }));

jest.mock('../utils/firsthand', () => ({
  isFirstHandConfigured: jest.fn(() => true),
  verifyCallbackSignature: jest.fn(),
  firstHandGet: jest.fn(),
  firstHandPost: jest.fn(),
}));

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── Subject under test ───────────────────────────────────────────────────────
import handler from '../firsthand/callbacks';

// ─── Typed mock references (via requireMock to avoid TDZ) ────────────────────
const db = jest.requireMock('../db') as { query: jest.Mock };
const firsthandUtils = jest.requireMock('../utils/firsthand') as {
  verifyCallbackSignature: jest.Mock;
};
const mockDbQuery = db.query;
const mockVerifyCallbackSignature = firsthandUtils.verifyCallbackSignature;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeReq(body: string, method = 'POST') {
  const stream = new Readable({ read() {} });
  setImmediate(() => {
    stream.push(Buffer.from(body, 'utf8'));
    stream.push(null);
  });
  return Object.assign(stream, {
    method,
    headers: { 'content-type': 'application/json' },
    query: {},
    url: '/api/firsthand/callbacks',
    body: null,
  });
}

function makeMockRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((b: any) => { res.body = b; return res; });
  res.end = jest.fn(() => res);
  return res;
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('api/firsthand/callbacks handler', () => {
  let res: ReturnType<typeof makeMockRes>;

  beforeEach(() => {
    jest.clearAllMocks();
    res = makeMockRes();
    mockVerifyCallbackSignature.mockReturnValue(true);
    mockDbQuery.mockResolvedValue({ rows: [] });
  });

  // ── Method guard ─────────────────────────────────────────────────────────
  it('returns 405 for non-POST request (GET)', async () => {
    await handler(makeReq('', 'GET') as any, res);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.body).toMatchObject({ error: 'Method not allowed' });
  });

  // ── HMAC guard ───────────────────────────────────────────────────────────
  it('returns 401 when verifyCallbackSignature returns false', async () => {
    mockVerifyCallbackSignature.mockReturnValue(false);
    const body = JSON.stringify({ event: 'session_started', session_id: 's1', occurred_at: '2026-01-01T00:00:00Z' });
    await handler(makeReq(body) as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ error: 'invalid_signature' });
  });

  // ── Body parsing ─────────────────────────────────────────────────────────
  it('returns 400 for malformed JSON body', async () => {
    await handler(makeReq('not-valid-json') as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ error: 'invalid_json' });
  });

  it('returns 400 when required fields are missing', async () => {
    const body = JSON.stringify({ event: 'session_started' }); // no session_id, occurred_at
    await handler(makeReq(body) as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ error: 'missing_fields' });
  });

  // ── event_type allow-list ─────────────────────────────────────────────────
  it('returns 400 for unknown event_type', async () => {
    const body = JSON.stringify({ event: 'mystery_event', session_id: 's1', occurred_at: '2026-01-01T00:00:00Z' });
    await handler(makeReq(body) as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ error: 'unknown_event_type', event: 'mystery_event' });
  });

  it.each(['session_started', 'session_completed', 'session_abandoned', 'session_failed'])(
    'accepts known event_type "%s" → 200 {received:true}',
    async (event) => {
      const body = JSON.stringify({
        event, session_id: `s-${event}`, occurred_at: '2026-01-01T00:00:00Z', external_ref: 'opp-1',
      });
      await handler(makeReq(body) as any, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.body).toEqual({ received: true });
    }
  );

  // ── DB behaviour ─────────────────────────────────────────────────────────
  it('calls DB query with ON CONFLICT clause when external_ref is present', async () => {
    const body = JSON.stringify({
      event: 'session_started', session_id: 'sid-1', occurred_at: '2026-01-01T00:00:00Z',
      external_ref: 'opp-abc', participant_id: 'p-xyz',
    });
    await handler(makeReq(body) as any, res);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (firsthand_session_id, event_type) DO NOTHING');
    expect(params[0]).toBe('opp-abc');         // opportunity_id
    expect(params[2]).toBe('sid-1');           // firsthand_session_id
    expect(params[3]).toBe('session_started'); // event_type
  });

  it('stores the raw body as payload', async () => {
    const bodyStr = JSON.stringify({
      event: 'session_completed', session_id: 'sid-2', occurred_at: '2026-01-01T00:00:00Z',
      external_ref: 'opp-1',
    });
    await handler(makeReq(bodyStr) as any, res);
    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[5]).toBe(bodyStr); // payload column
  });

  it('skips DB insert when external_ref is absent → still returns 200', async () => {
    const body = JSON.stringify({ event: 'session_started', session_id: 's1', occurred_at: '2026-01-01T00:00:00Z' });
    await handler(makeReq(body) as any, res);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ received: true });
  });

  it('swallows DB error and still returns 200', async () => {
    mockDbQuery.mockRejectedValue(new Error('db connection lost'));
    const body = JSON.stringify({
      event: 'session_started', session_id: 's1', occurred_at: '2026-01-01T00:00:00Z', external_ref: 'opp-1',
    });
    await handler(makeReq(body) as any, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ received: true });
  });

  it('uses participant_id as null when absent', async () => {
    const body = JSON.stringify({
      event: 'session_started', session_id: 's1', occurred_at: '2026-01-01T00:00:00Z', external_ref: 'opp-1',
    });
    await handler(makeReq(body) as any, res);
    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[1]).toBeNull(); // participant_user_id
  });
});
