/**
 * Tests for api/opportunities/[id]/firsthand-handoff.ts
 */

// ─── Mocks (all factories use inline jest.fn() to avoid TDZ) ─────────────────
jest.mock('../db', () => ({ query: jest.fn(), getPool: jest.fn() }));
jest.mock('../utils/auth', () => ({ parseSessionCookie: jest.fn() }));
jest.mock('../utils/firsthand', () => ({
  isFirstHandConfigured: jest.fn(),
  firstHandPost: jest.fn(),
  firstHandGet: jest.fn(),
  verifyCallbackSignature: jest.fn(),
}));
jest.mock('../utils/errors', () => ({
  createErrorResponse: jest.fn((msg: string) => ({ error: msg })),
  createSafeErrorResponse: jest.fn((_err: any, opts: any) => ({ error: opts?.userMessage ?? 'error' })),
}));
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── Subject under test ───────────────────────────────────────────────────────
import handler from '../opportunities/[id]/firsthand-handoff';

// ─── Typed mock references ────────────────────────────────────────────────────
const db = jest.requireMock('../db') as { query: jest.Mock };
const authUtils = jest.requireMock('../utils/auth') as { parseSessionCookie: jest.Mock };
const firsthandUtils = jest.requireMock('../utils/firsthand') as {
  isFirstHandConfigured: jest.Mock;
  firstHandPost: jest.Mock;
};
const mockDbQuery = db.query;
const mockParseSessionCookie = authUtils.parseSessionCookie;
const mockIsFirstHandConfigured = firsthandUtils.isFirstHandConfigured;
const mockFirstHandPost = firsthandUtils.firstHandPost;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeReq(opportunityId: string, method = 'POST') {
  return {
    method,
    headers: {},
    query: { id: opportunityId },
    url: `/api/opportunities/${opportunityId}/firsthand-handoff`,
    body: {},
  } as any;
}

function makeMockRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((b: any) => { res.body = b; return res; });
  return res;
}

const authUser = { id: 'u-1', name: 'Alice', email: 'alice@t.com', role: 'employee' };
const publishedOpp = { firsthand_study_id: 'study-abc', status: 'published' };

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('api/opportunities/[id]/firsthand-handoff handler', () => {
  let res: ReturnType<typeof makeMockRes>;

  beforeEach(() => {
    jest.clearAllMocks();
    res = makeMockRes();
    process.env.FRONTEND_URL = 'https://app.example.com';
    process.env.BACKEND_URL = 'https://api.example.com';
    delete process.env.VERCEL_URL;
  });

  afterEach(() => {
    delete process.env.FRONTEND_URL;
    delete process.env.BACKEND_URL;
    delete process.env.VERCEL_URL;
  });

  it('returns 405 for non-POST request', async () => {
    mockParseSessionCookie.mockReturnValue(authUser);
    await handler(makeReq('opp-1', 'GET'), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('returns 401 when not authenticated', async () => {
    mockParseSessionCookie.mockReturnValue(null);
    await handler(makeReq('opp-1'), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 503 when FirstHand not configured', async () => {
    mockParseSessionCookie.mockReturnValue(authUser);
    mockIsFirstHandConfigured.mockReturnValue(false);
    await handler(makeReq('opp-1'), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('returns 404 when opportunity not found', async () => {
    mockParseSessionCookie.mockReturnValue(authUser);
    mockIsFirstHandConfigured.mockReturnValue(true);
    mockDbQuery.mockResolvedValue({ rows: [] });
    await handler(makeReq('opp-missing'), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 403 when opportunity is not published', async () => {
    mockParseSessionCookie.mockReturnValue(authUser);
    mockIsFirstHandConfigured.mockReturnValue(true);
    mockDbQuery.mockResolvedValue({ rows: [{ firsthand_study_id: 'study-abc', status: 'draft' }] });
    await handler(makeReq('opp-1'), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 400 when opportunity has no firsthand_study_id', async () => {
    mockParseSessionCookie.mockReturnValue(authUser);
    mockIsFirstHandConfigured.mockReturnValue(true);
    mockDbQuery.mockResolvedValue({ rows: [{ firsthand_study_id: null, status: 'published' }] });
    await handler(makeReq('opp-1'), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 200 with session_url on success', async () => {
    mockParseSessionCookie.mockReturnValue(authUser);
    mockIsFirstHandConfigured.mockReturnValue(true);
    mockDbQuery.mockResolvedValue({ rows: [publishedOpp] });
    mockFirstHandPost.mockResolvedValue({ session_url: 'https://fh.example.com/session/xyz' });

    await handler(makeReq('opp-1'), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ session_url: 'https://fh.example.com/session/xyz' });
  });

  it('calls firstHandPost /api/sessions with correct participant payload', async () => {
    mockParseSessionCookie.mockReturnValue(authUser);
    mockIsFirstHandConfigured.mockReturnValue(true);
    mockDbQuery.mockResolvedValue({ rows: [publishedOpp] });
    mockFirstHandPost.mockResolvedValue({ session_url: 'https://fh.example.com/s' });

    await handler(makeReq('opp-42'), res);

    expect(mockFirstHandPost).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({
      study_id: 'study-abc',
      participant: expect.objectContaining({
        participant_id: 'u-1',
        display_name: 'Alice',
        email: 'alice@t.com',
        external_ref: 'opp-42',
      }),
    }));
  });

  it('uses BACKEND_URL for callback_url when set', async () => {
    mockParseSessionCookie.mockReturnValue(authUser);
    mockIsFirstHandConfigured.mockReturnValue(true);
    mockDbQuery.mockResolvedValue({ rows: [publishedOpp] });
    mockFirstHandPost.mockResolvedValue({ session_url: 'https://fh.example.com/s' });

    await handler(makeReq('opp-1'), res);

    const [, payload] = mockFirstHandPost.mock.calls[0];
    expect(payload.callback_url).toBe('https://api.example.com/api/firsthand/callbacks');
  });

  it('prefers BACKEND_URL over VERCEL_URL for callback_url', async () => {
    process.env.VERCEL_URL = 'vercel-preview.vercel.app';
    mockParseSessionCookie.mockReturnValue(authUser);
    mockIsFirstHandConfigured.mockReturnValue(true);
    mockDbQuery.mockResolvedValue({ rows: [publishedOpp] });
    mockFirstHandPost.mockResolvedValue({ session_url: 'https://fh.example.com/s' });

    await handler(makeReq('opp-1'), res);

    const [, payload] = mockFirstHandPost.mock.calls[0];
    expect(payload.callback_url).toContain('https://api.example.com');
    expect(payload.callback_url).not.toContain('vercel-preview');
  });

  it('falls back to VERCEL_URL when BACKEND_URL is absent', async () => {
    delete process.env.BACKEND_URL;
    process.env.VERCEL_URL = 'preview.vercel.app';
    mockParseSessionCookie.mockReturnValue(authUser);
    mockIsFirstHandConfigured.mockReturnValue(true);
    mockDbQuery.mockResolvedValue({ rows: [publishedOpp] });
    mockFirstHandPost.mockResolvedValue({ session_url: 'https://fh.example.com/s' });

    await handler(makeReq('opp-1'), res);

    const [, payload] = mockFirstHandPost.mock.calls[0];
    expect(payload.callback_url).toContain('https://preview.vercel.app');
  });

  it('returns 500 when firstHandPost throws', async () => {
    mockParseSessionCookie.mockReturnValue(authUser);
    mockIsFirstHandConfigured.mockReturnValue(true);
    mockDbQuery.mockResolvedValue({ rows: [publishedOpp] });
    mockFirstHandPost.mockRejectedValue(new Error('upstream error'));

    await handler(makeReq('opp-1'), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
