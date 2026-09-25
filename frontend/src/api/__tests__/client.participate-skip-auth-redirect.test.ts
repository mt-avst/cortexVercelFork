import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `checkParticipateVisit` and `markOpportunityOpened` (cto/AdaptaLabs#168)
 * must never bounce the viewer to the login page on a 401.
 * Both are fire-and-forget calls the Participate page and OpportunityDetail make
 * on top of whatever the viewer is already doing - a missed "New" badge or a
 * badge that doesn't clear is cosmetic, and for a poll/survey/recorded/question
 * study `markOpportunityOpened` is often the ONLY session-requiring call on that
 * page, so an expired session there must not evict the viewer from a study they
 * are actively reading.
 *
 * The docblocks said this before it was true - a 401 went straight through the
 * shared response interceptor's redirect-to-login branch on any page other than
 * `/` or `/auth/*`, `OpportunityDetail` included. The fix is a genuine
 * per-request opt-out (`skipAuthRedirect`) rather than a path-based carve-out, so
 * this file proves it two ways: that both calls actually SEND the flag, and that
 * the interceptor actually HONOURS it (a real 401, run through the real
 * registered handler, must not call the redirect).
 *
 * Same `vi.mock('axios')` shape as `client.feedback-contract.test.ts` and
 * `client.booking-consent.test.ts`: a hoisted fake axios instance captures every
 * interceptor `use()` registration, so the response error handler under test is
 * the SAME function `client.ts` installs, not a re-implementation of its logic.
 */

const { instance } = vi.hoisted(() => ({
  instance: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  },
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => instance),
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const { toLogin } = vi.hoisted(() => ({ toLogin: vi.fn() }));

vi.mock('../../utils/navigation', () => ({
  AUTH_ENDPOINTS: {
    DEMO_LOGIN: '/api/auth/demo-login',
    ADMIN_LOGIN: '/api/auth/admin-login',
    SUPERADMIN_LOGIN: '/api/auth/superadmin-login',
    OIDC_LOGIN: '/api/auth/login',
    LOGOUT: '/api/auth/logout',
  },
  isAdminRoute: vi.fn(() => false),
  isProductionEnvironment: vi.fn(() => false),
  redirectTo: vi.fn(),
  authNavigation: {
    toDemoLogin: vi.fn(),
    toAdminLogin: vi.fn(),
    toSuperadminLogin: vi.fn(),
    toOidcLogin: vi.fn(),
    toLogin,
  },
}));

import { checkParticipateVisit, markOpportunityOpened } from '../client';

/**
 * The response error handler client.ts registers - the SAME function a real
 * failed request runs through, captured from the mocked instance's own
 * `interceptors.response.use(onFulfilled, onRejected)` calls.
 *
 * `client.ts` registers TWO response interceptors on `api`: the CSRF-retry one
 * first (`csrf.ts`'s `isCsrfError` branch), then the request-timing/401-redirect
 * one this test is about. `mock.calls[0]` is the CSRF one - captured by index 1,
 * not 0, so this exercises the real redirect logic rather than the unrelated
 * interceptor ahead of it (which, called directly, would silently reject
 * without ever asserting anything about `toLogin`).
 */
const responseErrorHandler = instance.interceptors.response.use.mock.calls[1][1] as (
  error: unknown
) => Promise<never>;

const unauthorized401 = (config: Record<string, unknown>) => ({
  response: { status: 401, headers: {} },
  config,
  message: 'Request failed with status code 401',
});

beforeEach(() => {
  vi.clearAllMocks();
  instance.post.mockReset();
  toLogin.mockClear();
  // Neither the initial-auth-check exemption nor the `/` / `/auth/*` path
  // exemption apply here - OpportunityDetail is the page this bug actually
  // reaches (see the module docblock above).
  window.history.pushState({}, '', '/opportunities/opp-1');
});

describe('checkParticipateVisit and markOpportunityOpened opt out of the login redirect', () => {
  it('checkParticipateVisit sends skipAuthRedirect on its POST', async () => {
    instance.post.mockResolvedValue({ data: { newOpportunityIds: [] } });

    await checkParticipateVisit();

    expect(instance.post).toHaveBeenCalledWith('/participate/visit', undefined, {
      skipAuthRedirect: true,
    });
  });

  it('markOpportunityOpened sends skipAuthRedirect on its POST', async () => {
    instance.post.mockResolvedValue({ data: { ok: true } });

    await markOpportunityOpened('opp-1');

    expect(instance.post).toHaveBeenCalledWith('/participate/opened/opp-1', undefined, {
      skipAuthRedirect: true,
    });
  });

  it('a REAL 401 through the REGISTERED interceptor does not redirect when skipAuthRedirect is set', async () => {
    await expect(
      responseErrorHandler(unauthorized401({ skipAuthRedirect: true }))
    ).rejects.toBeDefined();

    expect(toLogin).not.toHaveBeenCalled();
  });

  // The control: the same 401, on the same page, with the flag absent - proves
  // the arm above is testing the flag and not a page the interceptor already
  // exempts for some other reason.
  it('control: the identical 401 WITHOUT skipAuthRedirect does redirect', async () => {
    await expect(responseErrorHandler(unauthorized401({}))).rejects.toBeDefined();

    expect(toLogin).toHaveBeenCalledTimes(1);
  });
});
