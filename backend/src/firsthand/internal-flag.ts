// FIRSTHAND_INTERNAL feature flag (Phase B, correction C1).
//
// When enabled, Cortex serves the recorded-study engine in-process instead of
// proxying the standalone FirstHand app over the HMAC integration. Phase B lands
// the internal paths dark (flag OFF by default) and flips this on at the
// End-of-B gate; an incident can flip it back to the HMAC integration.
//
// Routes read the flag per-request (not the parsed env config) so an operator
// can flip it via env without a code change taking effect only at boot. Accepts
// '1' or 'true', matching the shared backend env schema.
export function isFirstHandInternalEnabled(): boolean {
  const value = process.env.FIRSTHAND_INTERNAL?.trim();
  return value === '1' || value === 'true';
}
