import crypto from 'crypto';
import { logger } from './logger';

const REQUEST_TIMEOUT_MS = 10_000;

export function isFirstHandConfigured(): boolean {
  return !!(process.env.FIRSTHAND_BASE_URL?.trim() && process.env.FIRSTHAND_INTEGRATION_SECRET?.trim());
}

function buildHeaders(body: string): Record<string, string> {
  const secret = process.env.FIRSTHAND_INTEGRATION_SECRET!.trim();
  const timestamp = Date.now().toString();
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}\n${body}`)
    .digest('hex');
  return {
    'x-firsthand-signature': signature,
    'x-firsthand-timestamp': timestamp,
  };
}

function baseUrl(): string {
  const url = process.env.FIRSTHAND_BASE_URL?.trim();
  if (!url) throw new Error('FIRSTHAND_BASE_URL not configured');
  return url;
}

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

export async function firstHandGet<T>(path: string): Promise<T> {
  const headers = buildHeaders('');
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      headers,
      signal: withTimeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    logger.error('FirstHand GET network error', { path, error: err instanceof Error ? err.message : String(err) });
    throw new Error(`FirstHand GET ${path} failed: network error`);
  }
  if (!response.ok) {
    logger.warn('FirstHand GET non-OK response', { path, status: response.status });
    throw new Error(`FirstHand GET ${path} returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function firstHandPost<T>(path: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload);
  const headers = { ...buildHeaders(body), 'Content-Type': 'application/json' };
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers,
      body,
      signal: withTimeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    logger.error('FirstHand POST network error', { path, error: err instanceof Error ? err.message : String(err) });
    throw new Error(`FirstHand POST ${path} failed: network error`);
  }
  if (!response.ok) {
    logger.warn('FirstHand POST non-OK response', { path, status: response.status });
    throw new Error(`FirstHand POST ${path} returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}
