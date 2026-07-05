import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import {
  CSRF_ERROR_CODE,
  ensureCsrfToken,
  isCsrfError,
  isMutatingMethod,
  resetCsrfTokenCache,
} from '../csrf';

vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  return {
    ...actual,
    default: {
      ...actual.default,
      get: vi.fn(),
      isAxiosError: actual.default.isAxiosError,
    },
  };
});

const mockedGet = vi.mocked(axios.get);

describe('ensureCsrfToken', () => {
  beforeEach(() => {
    resetCsrfTokenCache();
    mockedGet.mockReset();
  });

  afterEach(() => {
    resetCsrfTokenCache();
  });

  it('fetches the token once and caches it', async () => {
    mockedGet.mockResolvedValue({ data: { csrfToken: 'token-1' } });

    expect(await ensureCsrfToken()).toBe('token-1');
    expect(await ensureCsrfToken()).toBe('token-1');
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent fetches', async () => {
    mockedGet.mockResolvedValue({ data: { csrfToken: 'token-1' } });

    const [first, second] = await Promise.all([ensureCsrfToken(), ensureCsrfToken()]);
    expect(first).toBe('token-1');
    expect(second).toBe('token-1');
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('refetches when forced', async () => {
    mockedGet
      .mockResolvedValueOnce({ data: { csrfToken: 'token-1' } })
      .mockResolvedValueOnce({ data: { csrfToken: 'token-2' } });

    expect(await ensureCsrfToken()).toBe('token-1');
    expect(await ensureCsrfToken(true)).toBe('token-2');
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it('returns null when the endpoint is unavailable (CSRF disabled)', async () => {
    mockedGet.mockRejectedValue(new Error('404'));

    expect(await ensureCsrfToken()).toBeNull();
  });
});

describe('isMutatingMethod', () => {
  it('flags mutating methods regardless of case', () => {
    expect(isMutatingMethod('POST')).toBe(true);
    expect(isMutatingMethod('delete')).toBe(true);
    expect(isMutatingMethod('get')).toBe(false);
    expect(isMutatingMethod(undefined)).toBe(false);
  });
});

describe('isCsrfError', () => {
  it('recognises a 403 carrying the CSRF error code', () => {
    const error = new axios.AxiosError('forbidden', undefined, undefined, undefined, {
      status: 403,
      data: { code: CSRF_ERROR_CODE },
    } as never);

    expect(isCsrfError(error)).toBe(true);
  });

  it('rejects other errors', () => {
    const plainError = new Error('nope');
    expect(isCsrfError(plainError)).toBe(false);

    const otherAxios = new axios.AxiosError('forbidden', undefined, undefined, undefined, {
      status: 403,
      data: { code: 'OWNER_ONLY' },
    } as never);
    expect(isCsrfError(otherAxios)).toBe(false);
  });
});
