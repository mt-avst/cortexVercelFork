// Parses the `?attempt=` query used by the participant runtime routes to
// address a specific re-recording attempt. Ported verbatim from FirstHand's
// src/lib/session-attempts.ts (the browser-only href helper is not ported —
// the SPA builds those URLs client-side in Phase B6).
export function parseSessionAttemptNumber(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}
