import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getVisitorNonce } from '../visitorNonce';

// #125: the per-visitor nonce makes anonymous analytics distinct counts survive
// the proxy. These pin the two properties the count depends on - it is a stable
// value shaped to what the server accepts, and storage failure degrades to null
// (the caller then omits it and the server falls back to ip_hash) rather than
// throwing into the click-tracking path.

const STORAGE_KEY = 'cortex.visitor_nonce';
// Must match the server's accepted shape in POST /opportunities/:id/click.
const SERVER_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

describe('getVisitorNonce', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('generates a nonce matching the shape the server accepts and persists it', () => {
    const nonce = getVisitorNonce();
    expect(nonce).not.toBeNull();
    expect(nonce!).toMatch(SERVER_PATTERN);
    // Persisted so a later visit reuses it.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(nonce);
  });

  it('returns the same nonce on repeat calls (stable per visitor)', () => {
    const first = getVisitorNonce();
    const second = getVisitorNonce();
    expect(first).toBe(second);
  });

  it('reuses a valid stored nonce verbatim', () => {
    window.localStorage.setItem(STORAGE_KEY, 'stored-valid-123456');
    expect(getVisitorNonce()).toBe('stored-valid-123456');
  });

  it('replaces a malformed stored value with a fresh valid nonce', () => {
    window.localStorage.setItem(STORAGE_KEY, 'bad nonce!'); // space + '!' + too short
    const nonce = getVisitorNonce();
    expect(nonce).not.toBe('bad nonce!');
    expect(nonce!).toMatch(SERVER_PATTERN);
  });

  it('returns null (no throw) when localStorage is unavailable', () => {
    // Storage methods live on the prototype in jsdom, so spy there.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(getVisitorNonce()).toBeNull();
  });
});
