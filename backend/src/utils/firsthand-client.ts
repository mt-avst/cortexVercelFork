import crypto from 'crypto';

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

export async function firstHandGet<T>(path: string): Promise<T> {
  const headers = buildHeaders('');
  const response = await fetch(`${baseUrl()}${path}`, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FirstHand GET ${path} returned ${response.status}: ${text}`);
  }
  return response.json() as Promise<T>;
}

export async function firstHandPost<T>(path: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload);
  const headers = { ...buildHeaders(body), 'Content-Type': 'application/json' };
  const response = await fetch(`${baseUrl()}${path}`, { method: 'POST', headers, body });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FirstHand POST ${path} returned ${response.status}: ${text}`);
  }
  return response.json() as Promise<T>;
}
