/**
 * Tests for api/firsthand/studies.ts
 */

// ─── Mocks (all factories use inline jest.fn() to avoid TDZ) ─────────────────
jest.mock('../utils/auth', () => ({ parseSessionCookie: jest.fn() }));

jest.mock('../utils/firsthand', () => ({
  isFirstHandConfigured: jest.fn(),
  firstHandGet: jest.fn(),
  firstHandPost: jest.fn(),
  verifyCallbackSignature: jest.fn(),
}));

jest.mock('../utils/errors', () => ({
  createErrorResponse: jest.fn((msg: string) => ({ error: msg })),
  createSafeErrorResponse: jest.fn((err: any) => ({ error: String(err) })),
}));

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── Subject under test ───────────────────────────────────────────────────────
import handler from '../firsthand/studies';

// ─── Typed mock references ────────────────────────────────────────────────────
const authUtils = jest.requireMock('../utils/auth') as { parseSessionCookie: jest.Mock };
const firsthandUtils = jest.requireMock('../utils/firsthand') as {
  isFirstHandConfigured: jest.Mock;
  firstHandGet: jest.Mock;
};
const mockParseSessionCookie = authUtils.parseSessionCookie;
const mockIsFirstHandConfigured = firsthandUtils.isFirstHandConfigured;
const mockFirstHandGet = firsthandUtils.firstHandGet;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeReq(method = 'GET') {
  return { method, headers: {}, query: {}, url: '/api/firsthand/studies' } as any;
}

function makeMockRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((b: any) => { res.body = b; return res; });
  return res;
}

const adminUser = { id: 'u-1', name: 'Admin', email: 'a@t.com', role: 'researcher_admin' };
const regularUser = { id: 'u-2', name: 'Employee', email: 'e@t.com', role: 'employee' };

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('api/firsthand/studies handler', () => {
  let res: ReturnType<typeof makeMockRes>;

  beforeEach(() => {
    jest.clearAllMocks();
    res = makeMockRes();
  });

  it('returns 405 for non-GET method', async () => {
    mockParseSessionCookie.mockReturnValue(adminUser);
    await handler(makeReq('POST'), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('returns 401 when no session cookie', async () => {
    mockParseSessionCookie.mockReturnValue(null);
    await handler(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 when user is not admin', async () => {
    mockParseSessionCookie.mockReturnValue(regularUser);
    await handler(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('superadmin passes auth → hits configured check → 503 when not configured', async () => {
    mockParseSessionCookie.mockReturnValue({ ...adminUser, role: 'superadmin' });
    mockIsFirstHandConfigured.mockReturnValue(false);
    await handler(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('returns 503 with studies:[] when FirstHand not configured', async () => {
    mockParseSessionCookie.mockReturnValue(adminUser);
    mockIsFirstHandConfigured.mockReturnValue(false);
    await handler(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toMatchObject({ error: 'firsthand_not_configured', studies: [] });
  });

  it('returns 200 with studies array when configured and proxy succeeds', async () => {
    const studies = [{ id: 's-1', title: 'Test Study', status: 'launched' }];
    mockParseSessionCookie.mockReturnValue(adminUser);
    mockIsFirstHandConfigured.mockReturnValue(true);
    mockFirstHandGet.mockResolvedValue({ studies });
    await handler(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ studies });
    expect(mockFirstHandGet).toHaveBeenCalledWith('/api/studies');
  });

  it('returns 502 when FirstHand proxy call fails', async () => {
    mockParseSessionCookie.mockReturnValue(adminUser);
    mockIsFirstHandConfigured.mockReturnValue(true);
    mockFirstHandGet.mockRejectedValue(new Error('connection refused'));
    await handler(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(502);
  });
});
