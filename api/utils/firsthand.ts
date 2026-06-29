import crypto from 'crypto';

const SIGNATURE_HEADER = 'x-firsthand-signature';
const TIMESTAMP_HEADER = 'x-firsthand-timestamp';
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export function isFirstHandConfigured(): boolean {
  return !!(
    process.env.FIRSTHAND_BASE_URL?.trim() &&
    process.env.FIRSTHAND_INTEGRATION_SECRET?.trim()
  );
}

function getSecret(): string {
  return process.env.FIRSTHAND_INTEGRATION_SECRET!.trim();
}

function getBaseUrl(): string {
  return process.env.FIRSTHAND_BASE_URL!.trim();
}

function buildHeaders(body: string): Record<string, string> {
  const secret = getSecret();
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}\n${body}`)
    .digest('hex');
  return {
    'x-firsthand-signature': signature,
    'x-firsthand-timestamp': timestamp,
  };
}

export async function firstHandGet<T>(path: string): Promise<T> {
  const headers = buildHeaders('');
  const res = await fetch(`${getBaseUrl()}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`FirstHand GET ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function firstHandPost<T>(path: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload);
  const headers = buildHeaders(body);
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  if (!res.ok) {
    throw new Error(`FirstHand POST ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function verifyCallbackSignature(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>
): boolean {
  const secret = process.env.FIRSTHAND_INTEGRATION_SECRET?.trim();
  if (!secret) return false;

  const signature = (Array.isArray(headers[SIGNATURE_HEADER])
    ? headers[SIGNATURE_HEADER][0]
    : headers[SIGNATURE_HEADER] as string | undefined)?.trim();

  const timestamp = (Array.isArray(headers[TIMESTAMP_HEADER])
    ? headers[TIMESTAMP_HEADER][0]
    : headers[TIMESTAMP_HEADER] as string | undefined)?.trim();

  if (!signature || !timestamp) return false;

  const timestampMs = parseInt(timestamp, 10);
  if (!Number.isFinite(timestampMs)) return false;
  if (Math.abs(Date.now() - timestampMs) > SIGNATURE_TOLERANCE_MS) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}\n${rawBody}`)
    .digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length === 0 || sigBuf.length !== expBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expBuf);
}
