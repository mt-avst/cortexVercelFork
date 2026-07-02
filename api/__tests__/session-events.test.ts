/**
 * Tests for api/opportunities/[id]/session-events.ts
 */

// ─── Mocks (all factories use inline jest.fn() to avoid TDZ) ─────────────────
jest.mock('../db', () => ({ query: jest.fn(), getPool: jest.fn() }));
jest.mock('../utils/auth', () => ({ parseSessionCookie: jest.fn() }));
jest.mock('../utils/errors', () => ({
  createErrorResponse: jest.fn((msg: string) => ({ error: msg })),
  createSafeErrorResponse: jest.fn((_err: any, opts: any) => ({ error: opts?.userMessage ?? 'error' })),
}));
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── Subject under test ───────────────────────────────────────────────────────
import handler from '../opportunities/[id]/session-events';

// ─── Typed mock references ────────────────────────────────────────────────────
const db = jest.requireMock('../db') as { query: jest.Mock };
const authUtils = jest.requireMock('../utils/auth') as { parseSessionCookie: jest.Mock };
const mockDbQuery = db.query;
const mockParseSessionCookie = authUtils.parseSessionCookie;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeReq(opportunityId: string, method = 'GET') {
  return {
    method,
    headers: {},
    query: { id: opportunityId },
    url: `/api/opportunities/${opportunityId}/session-events`,
  } as any;
}

function makeMockRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((b: any) => { res.body = b; return res; });
  return res;
}

const adminUser = { id: 'a-1', name: 'Admin', email: 'admin@t.com', role: 'researcher_admin' };
const regularUser = { id: 'e-1', name: 'Employee', email: 'emp@t.com', role: 'employee' };

const dbRow = {
  id: 'ev-1',
  opportunity_id: 'opp-1',
  participant_user_id: 'u-1',
  firsthand_session_id: 'fh-session-abc',
  event_type: 'session_completed',
  occurred_at: new Date('2026-01-01T12:00:00Z'),
  received_at: new Date('2026-01-01T12:00:05Z'),
  participant_name: 'Alice',
  participant_email: 'alice@t.com',
};

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('api/opportunities/[id]/session-events handler', () => {
  let res: ReturnType<typeof makeMockRes>;

  beforeEach(() => {
    jest.clearAllMocks();
    res = makeMockRes();
    delete process.env.FIRSTHAND_BASE_URL;
    mockDbQuery.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    delete process.env.FIRSTHAND_BASE_URL;
  });

  it('returns 405 for non-GET request', async () => {
    mockParseSessionCookie.mockReturnValue(adminUser);
    await handler(makeReq('opp-1', 'POST'), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('returns 401 when not authenticated', async () => {
    mockParseSessionCookie.mockReturnValue(null);
    await handler(makeReq('opp-1'), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for non-admin user', async () => {
    mockParseSessionCookie.mockReturnValue(regularUser);
    await handler(makeReq('opp-1'), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 200 with empty array when no events', async () => {
    mockParseSessionCookie.mockReturnValue(adminUser);
    mockDbQuery.mockResolvedValue({ rows: [] });
    await handler(makeReq('opp-1'), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual([]);
  });

  it('returns 200 with mapped event rows', async () => {
    mockParseSessionCookie.mockReturnValue(adminUser);
    mockDbQuery.mockResolvedValue({ rows: [dbRow] });
    await handler(makeReq('opp-1'), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const [event] = res.body;
    expect(event.id).toBe('ev-1');
    expect(event.event_type).toBe('session_completed');
    expect(event.participant_name).toBe('Alice');
    expect(event.participant_email).toBe('alice@t.com');
  });

  it('converts Date objects to ISO strings', async () => {
    mockParseSessionCookie.mockReturnValue(adminUser);
    mockDbQuery.mockResolvedValue({ rows: [dbRow] });
    await handler(makeReq('opp-1'), res);
    const [event] = res.body;
    expect(typeof event.occurred_at).toBe('string');
    expect(event.occurred_at).toBe('2026-01-01T12:00:00.000Z');
    expect(typeof event.received_at).toBe('string');
  });

  it('sets firsthand_review_url when FIRSTHAND_BASE_URL is configured', async () => {
    process.env.FIRSTHAND_BASE_URL = 'https://fh.example.com';
    mockParseSessionCookie.mockReturnValue(adminUser);
    mockDbQuery.mockResolvedValue({ rows: [dbRow] });
    await handler(makeReq('opp-1'), res);
    const [event] = res.body;
    expect(event.firsthand_review_url).toBe('https://fh.example.com/review/session/fh-session-abc');
  });

  it('sets firsthand_review_url to null when FIRSTHAND_BASE_URL is not set', async () => {
    mockParseSessionCookie.mockReturnValue(adminUser);
    mockDbQuery.mockResolvedValue({ rows: [dbRow] });
    await handler(makeReq('opp-1'), res);
    const [event] = res.body;
    expect(event.firsthand_review_url).toBeNull();
  });

  it('queries by opportunity_id from the route param', async () => {
    mockParseSessionCookie.mockReturnValue(adminUser);
    mockDbQuery.mockResolvedValue({ rows: [] });
    await handler(makeReq('opp-specific-id'), res);
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toContain('WHERE e.opportunity_id = $1');
    expect(params[0]).toBe('opp-specific-id');
  });

  it('allows superadmin role', async () => {
    mockParseSessionCookie.mockReturnValue({ ...adminUser, role: 'superadmin' });
    mockDbQuery.mockResolvedValue({ rows: [] });
    await handler(makeReq('opp-1'), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 500 on DB error', async () => {
    mockParseSessionCookie.mockReturnValue(adminUser);
    mockDbQuery.mockRejectedValue(new Error('db timeout'));
    await handler(makeReq('opp-1'), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
