// A stable, first-party per-visitor id used ONLY to count distinct anonymous
// visitors in study analytics (cto/AdaptaLabs#125). Server-side `ip_hash`
// collapses to one value behind the reverse proxy, so an anonymous nonce the
// client persists and sends is what lets "Distinct visitors" mean what it says.
//
// Privacy: this is an opaque random token with no PII. It is never read back to
// identify or profile a visitor - it only ever travels on the click-tracking
// call and is compared for distinctness server-side. It is not a session or
// auth token. Clearing site data or using a fresh browser yields a new one.

const STORAGE_KEY = 'cortex.visitor_nonce';
// Must match the server's accepted shape in POST /opportunities/:id/click.
const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function generateNonce(): string {
  // Prefer the platform CSPRNG. randomUUID needs a secure context (it is one in
  // production and on the playground); fall back to getRandomValues, then to a
  // last-resort non-crypto token - distinctness, not unguessability, is all this
  // needs, so a weak fallback still serves the count.
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // fall through to the non-crypto path
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The persistent per-visitor nonce, creating and storing one on first use.
 * Returns null when localStorage is unavailable (private mode, storage blocked,
 * SSR) - the caller then omits it and the server falls back to ip_hash.
 */
export function getVisitorNonce(): string | null {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing && NONCE_PATTERN.test(existing)) {
      return existing;
    }
    const nonce = generateNonce();
    window.localStorage.setItem(STORAGE_KEY, nonce);
    return NONCE_PATTERN.test(nonce) ? nonce : null;
  } catch {
    return null;
  }
}
