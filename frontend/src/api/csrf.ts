import axios, { AxiosError } from 'axios';

import { getApiBaseUrl } from '../config/api';

export const CSRF_HEADER = 'X-CSRF-Token';
export const CSRF_ERROR_CODE = 'INVALID_CSRF_TOKEN';

const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);

let cachedToken: string | null = null;
let inflightFetch: Promise<string | null> | null = null;

async function fetchCsrfToken(): Promise<string | null> {
  try {
    const response = await axios.get(`${getApiBaseUrl()}/api/csrf-token`, {
      withCredentials: true,
      timeout: 10_000,
    });
    const token = response.data?.csrfToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    // Endpoint absent (CSRF disabled server-side) or transient failure -
    // requests proceed without the header and the server decides.
    return null;
  }
}

/**
 * Returns the CSRF token for this browser session, fetching it once and
 * caching it. Pass forceRefresh after a CSRF 403 to get a fresh token.
 */
export async function ensureCsrfToken(forceRefresh = false): Promise<string | null> {
  if (forceRefresh) {
    cachedToken = null;
    inflightFetch = null;
  }
  if (cachedToken) {
    return cachedToken;
  }
  if (!inflightFetch) {
    inflightFetch = fetchCsrfToken().then((token) => {
      cachedToken = token;
      inflightFetch = null;
      return token;
    });
  }
  return inflightFetch;
}

export function resetCsrfTokenCache(): void {
  cachedToken = null;
  inflightFetch = null;
}

export function isMutatingMethod(method: string | undefined): boolean {
  return MUTATING_METHODS.has((method ?? '').toLowerCase());
}

export function isCsrfError(error: unknown): error is AxiosError {
  if (!axios.isAxiosError(error)) {
    return false;
  }
  const data = error.response?.data as { code?: string } | undefined;
  return error.response?.status === 403 && data?.code === CSRF_ERROR_CODE;
}
