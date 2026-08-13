/**
 * Adds a missing `https://` to a Starting URL typed without one.
 *
 * FORM LAYER ONLY, DELIBERATELY. `isSafeTargetUrl` in shared/firsthand is the
 * security boundary - it is what stops a `javascript:` target being opened
 * into a participant's session while screen and microphone recording is
 * running - and the backend runs it on every save. Normalising inside that
 * function would make the API accept and rewrite scheme-less input too, which
 * widens what the server takes. So this sits above the validator, and the
 * validator stays strict: anything this returns is still checked.
 *
 * Only genuinely scheme-less input is rewritten, which is what keeps it safe:
 *
 * - `example.com/checkout` -> `https://example.com/checkout`
 * - `javascript:alert(1)`  -> unchanged. It carries a scheme, so it is never
 *   prepended, and `isSafeTargetUrl` still rejects it
 * - `/checkout`            -> unchanged. A relative path is a legitimate
 *   same-origin target and has its own branch in the guard
 * - `//evil.com`           -> unchanged. It starts with `/`, so it is left for
 *   the two-sentinel origin check added in !92, which rejects it
 *
 * Known edge: an authority that looks like a scheme, `localhost:3000/x`, is
 * treated as already carrying one and is left alone, so it fails validation
 * with a message rather than being rewritten. That is the honest outcome -
 * a participant cannot reach the researcher's localhost anyway - and it is
 * preferred over heuristics that guess at intent.
 */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function normaliseTargetUrl(raw: string): string {
  const trimmed = raw.trim();

  if (!trimmed || trimmed.startsWith('/') || HAS_SCHEME.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}
