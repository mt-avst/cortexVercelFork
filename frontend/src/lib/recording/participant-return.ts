export type SessionOutcome = "completed" | "declined";

/**
 * The URL to send a participant back to when their session ends.
 *
 * The sender supplies `return_url` and may bake its own outcome marker into it:
 * Cortex builds `${FRONTEND_URL}/opportunities/${id}?completed=1` up front, and
 * its opportunity page shows a completion banner off
 * `searchParams.get('completed') === '1'`. The declined phase returns to that
 * same URL too, so refusing consent would otherwise show "Session complete" -
 * and plausibly corrupt any sender-side reading of the return.
 *
 * So a marker that contradicts the real outcome is removed, and the outcome is
 * always stated explicitly via `firsthand_outcome`.
 *
 * The result is rendered as an `<a href>`, so a non-http(s) scheme is rejected
 * here (returns null, dropping the button) rather than handed to the sink. The
 * contract validates return_url only as `z.string().url()`, which permits
 * `javascript:`/`data:`; this is the second line of defence at the sink, so the
 * anchor never trusts its own input. `callback_url`/`return_url` contract-level
 * refinement is tracked as a pre-flag-flip follow-up.
 */
export function buildParticipantReturnUrl(
  returnUrl: string,
  outcome: SessionOutcome
): string | null {
  let url: URL;

  try {
    url = new URL(returnUrl);
  } catch {
    // Not a parsable absolute URL: drop it rather than strand or mis-render a
    // participant at the end of a session.
    return null;
  }

  // Only ever navigate to http(s): javascript:/data:/other active schemes parse
  // as valid URLs but must never reach an href.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  if (outcome === "declined") {
    url.searchParams.delete("completed");
  }

  url.searchParams.set("firsthand_outcome", outcome);

  return url.toString();
}
