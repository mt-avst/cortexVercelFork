/**
 * Tests for api/utils/firsthand.ts — pure HMAC utilities used by all Vercel handlers.
 */
import crypto from 'crypto';
import { isFirstHandConfigured, verifyCallbackSignature } from '../utils/firsthand';

const SECRET = 'test-firsthand-secret-for-api-utils-32c';

function makeValidHeaders(
  rawBody: string,
  secret = SECRET,
  tsOverride?: number
): Record<string, string> {
  const timestamp = (tsOverride ?? Date.now()).toString();
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}\n${rawBody}`)
    .digest('hex');
  return { 'x-firsthand-signature': sig, 'x-firsthand-timestamp': timestamp };
}

describe('isFirstHandConfigured()', () => {
  afterEach(() => {
    delete process.env.FIRSTHAND_BASE_URL;
    delete process.env.FIRSTHAND_INTEGRATION_SECRET;
  });

  it('returns false when both vars missing', () => {
    expect(isFirstHandConfigured()).toBe(false);
  });

  it('returns false when only FIRSTHAND_BASE_URL is set', () => {
    process.env.FIRSTHAND_BASE_URL = 'https://fh.example.com';
    expect(isFirstHandConfigured()).toBe(false);
  });

  it('returns false when only FIRSTHAND_INTEGRATION_SECRET is set', () => {
    process.env.FIRSTHAND_INTEGRATION_SECRET = SECRET;
    expect(isFirstHandConfigured()).toBe(false);
  });

  it('returns true when both vars are set', () => {
    process.env.FIRSTHAND_BASE_URL = 'https://fh.example.com';
    process.env.FIRSTHAND_INTEGRATION_SECRET = SECRET;
    expect(isFirstHandConfigured()).toBe(true);
  });

  it('returns false when vars are set to whitespace only', () => {
    process.env.FIRSTHAND_BASE_URL = '   ';
    process.env.FIRSTHAND_INTEGRATION_SECRET = '   ';
    expect(isFirstHandConfigured()).toBe(false);
  });
});

describe('verifyCallbackSignature()', () => {
  beforeEach(() => {
    process.env.FIRSTHAND_INTEGRATION_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.FIRSTHAND_INTEGRATION_SECRET;
  });

  it('returns false when FIRSTHAND_INTEGRATION_SECRET is not set', () => {
    delete process.env.FIRSTHAND_INTEGRATION_SECRET;
    const headers = makeValidHeaders('{"event":"session_started"}');
    expect(verifyCallbackSignature('{"event":"session_started"}', headers)).toBe(false);
  });

  it('returns false when x-firsthand-signature header is missing', () => {
    const ts = Date.now().toString();
    expect(
      verifyCallbackSignature('body', { 'x-firsthand-timestamp': ts })
    ).toBe(false);
  });

  it('returns false when x-firsthand-timestamp header is missing', () => {
    const sig = crypto.createHmac('sha256', SECRET).update('123\nbody').digest('hex');
    expect(
      verifyCallbackSignature('body', { 'x-firsthand-signature': sig })
    ).toBe(false);
  });

  it('returns false when timestamp is non-numeric', () => {
    const headers = { 'x-firsthand-signature': 'abc', 'x-firsthand-timestamp': 'not-a-number' };
    expect(verifyCallbackSignature('body', headers)).toBe(false);
  });

  it('returns false when signature is an empty string', () => {
    const ts = Date.now().toString();
    expect(verifyCallbackSignature('body', {
      'x-firsthand-signature': '',
      'x-firsthand-timestamp': ts,
    })).toBe(false);
  });

  it('returns false for stale timestamp (>5 min old)', () => {
    const rawBody = '{"event":"session_started"}';
    const headers = makeValidHeaders(rawBody, SECRET, Date.now() - 400_000);
    expect(verifyCallbackSignature(rawBody, headers)).toBe(false);
  });

  it('returns false for future timestamp (>5 min ahead)', () => {
    const rawBody = '{"event":"session_started"}';
    const headers = makeValidHeaders(rawBody, SECRET, Date.now() + 400_000);
    expect(verifyCallbackSignature(rawBody, headers)).toBe(false);
  });

  it('returns false when body is tampered (sig computed for different body)', () => {
    const originalBody = '{"event":"session_started"}';
    const tamperedBody = '{"event":"session_completed"}';
    const headers = makeValidHeaders(originalBody);
    expect(verifyCallbackSignature(tamperedBody, headers)).toBe(false);
  });

  it('returns false when secret is wrong', () => {
    const rawBody = '{"event":"session_started"}';
    const headers = makeValidHeaders(rawBody, 'wrong-secret-that-is-32chars-long!!');
    // process.env still has the correct SECRET, so signature doesn't match
    expect(verifyCallbackSignature(rawBody, headers)).toBe(false);
  });

  it('returns true for valid HMAC with correct body and recent timestamp', () => {
    const rawBody = '{"event":"session_started","session_id":"abc-123"}';
    const headers = makeValidHeaders(rawBody);
    expect(verifyCallbackSignature(rawBody, headers)).toBe(true);
  });

  it('accepts timestamp just inside the 5-min window', () => {
    const rawBody = 'test';
    // 4 min 59 sec ago
    const headers = makeValidHeaders(rawBody, SECRET, Date.now() - 299_000);
    expect(verifyCallbackSignature(rawBody, headers)).toBe(true);
  });

  it('accepts array-typed header values (takes first element)', () => {
    const rawBody = 'test-body-for-array-header';
    const ts = Date.now().toString();
    const sig = crypto.createHmac('sha256', SECRET)
      .update(`${ts}\n${rawBody}`)
      .digest('hex');
    expect(
      verifyCallbackSignature(rawBody, {
        'x-firsthand-signature': [sig, 'ignored-second'],
        'x-firsthand-timestamp': [ts, 'ignored-second'],
      } as any)
    ).toBe(true);
  });
});
