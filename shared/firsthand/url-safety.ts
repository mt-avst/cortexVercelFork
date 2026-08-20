/**
 * Bases used only to decide whether a relative target stays on its own origin.
 *
 * TWO of them, and that is load-bearing. With a single base, an input that
 * NAMES that base satisfies the origin check: `//same-origin.invalid/x`
 * resolved to the base's own origin and was accepted - a hole the string check
 * this replaced did not have, since it rejected anything starting `//`. No
 * input can name both hosts at once, so requiring the origin to be preserved
 * against each in turn closes it without going back to pattern matching.
 *
 * Deliberately `.invalid` hosts (RFC 6761 - guaranteed never resolvable) so
 * they cannot be confused with a real destination if one ever leaks into a
 * message. Nothing is ever fetched from them.
 */
const RELATIVE_RESOLUTION_BASES = [
  "https://a.same-origin.invalid",
  "https://b.same-origin.invalid"
] as const;

/**
 * Whether a study's target_url is safe to open and navigate a window to.
 *
 * The task page is opened with window.open("") - a same-origin about:blank
 * document - and then navigated by assigning location.href. A javascript: (or
 * any other active-scheme) URL assigned there would execute in this app's
 * origin, with access to the participant's session token and stored responses.
 * So only absolute http(s) URLs and same-origin root-relative paths are
 * allowed; protocol-relative ("//host") and every non-http scheme are rejected.
 *
 * This is enforced three times: on the authoring form, at the contract boundary
 * when a session payload is validated, and again at the sink in useTaskWindow,
 * so the window navigation never trusts its own input.
 *
 * THE RELATIVE BRANCH RESOLVES RATHER THAN PATTERN-MATCHES, and must stay that
 * way. It used to be `raw.startsWith("/") && !raw.startsWith("//")`, which the
 * WHATWG parser defeats four ways: it treats `\` as `/` after a special scheme,
 * and strips tab, CR and LF from anywhere in the input. So `/\evil.com/`,
 * `/<TAB>/evil.com/`, `/<CR>/evil.com/` and `/<LF>/evil.com/` all passed while
 * resolving to https://evil.com/. That was worse than an ordinary cross-origin
 * target: `describeTarget` throws on these and falls back to calling the
 * destination "the task page" - copy that exists precisely because a relative
 * target is this app's own origin - so the participant was told they were
 * opening a Cortex page, then asked to screen-share it and start recording. It
 * suppressed the very label that would have let them notice.
 */
export function isSafeTargetUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);

    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    // Not an absolute URL. Resolve it against each sentinel origin and require
    // it to have stayed there every time: anything that escapes -
    // protocol-relative, or the backslash and control-character forms above -
    // lands elsewhere and is rejected. Parsing decides, not the shape of the
    // string.
    //
    // The leading-slash requirement is NOT redundant next to the origin check,
    // and must not be tidied away. A path-relative input ("checkout", "?q=1",
    // "#f") resolves against the sentinel ROOT here but against the OPENER's
    // document URL at the sink - window.open("") yields a same-origin
    // about:blank that inherits a base carrying a path like
    // /participant/session/123. Requiring "/" makes this answer the same
    // question the sink asks, rather than a base-dependent one.
    return (
      raw.startsWith("/") &&
      RELATIVE_RESOLUTION_BASES.every((base) => {
        try {
          return new URL(raw, base).origin === base;
        } catch {
          // Malformed authority forms ("/\", "//") throw here and also throw at
          // the sink, so rejecting them is correct rather than over-strict.
          return false;
        }
      })
    );
  }
}

/**
 * What an author is told when a link's scheme is not one this product will hand
 * a participant.
 *
 * In this module rather than beside the publish rules, and the move was a
 * security gate's finding rather than tidiness. `findPublishProblem` calls the
 * predicate below to answer "does this poll need a link", so with both living in
 * `publish-readiness.ts` a future PRODUCT decision - "a `mailto:` hand-off is
 * fine for a question type" - would read as relaxing a publish rule and would
 * silently widen the create schema, the update schema AND the participant-facing
 * render gate in one edit. Here it sits next to `isSafeTargetUrl`, where a
 * change reads as what it is.
 */
export const EXTERNAL_LINK_PROTOCOL_MESSAGE =
  "The external link must start with http:// or https://";

/**
 * Whether a string is a link this product will hand a participant.
 *
 * `z.string().url()` is NOT a protocol check: on zod 3 it accepts
 * `javascript:alert(1)`, `data:text/html,...` and `vbscript:`, all of which
 * parse as URLs. This field is rendered into an `href` on the participant-facing
 * opportunity page, so a `researcher_admin` could store script in this app's
 * origin. Confirmed by request before it was fixed: a published `question`
 * carrying `javascript:alert(document.domain)` was accepted with **201** and
 * rendered as `<a href="javascript:...">Answer Question</a>`.
 *
 * Protocol only. This is deliberately NOT `isSafeTargetUrl`, which additionally
 * refuses protocol-relative and non-rooted forms because its URL is one Cortex
 * OPENS and then navigates a same-origin window to. An external hand-off is a
 * link the author is publishing on purpose, and where it points is their
 * decision - only whether it can EXECUTE is ours.
 */
export const isPublishableExternalLink = (
  raw: string | null | undefined
): boolean => {
  if (!raw) {
    return false;
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

export const MEETING_LOCATION_SCHEME_MESSAGE =
  "A meeting link must start with http:// or https://";

/**
 * Whether a session's location is safe to show a participant.
 *
 * This field is DUAL-PURPOSE, which is what makes it a different question from
 * the one above: it holds either a joining link or a plain place - "Room 3B",
 * "Zoom, see calendar invite". `MyBookings` renders it as a link when it looks
 * like one and as text otherwise, so requiring a URL would break every
 * room-number booking in the table.
 *
 * So the rule is not "must be a URL", it is "must not be an EXECUTABLE one".
 * Free text that does not parse is fine. Anything that parses with a scheme this
 * product will not navigate to is refused.
 *
 * The check it replaces was a substring test - `str.includes("meet.google.com")`
 * - which meant `javascript:alert(document.cookie)//meet.google.com` rendered as
 * an `href` labelled "Join via Google Meet", the `//` turning the allowlisted
 * host into a JavaScript comment. Set once by a researcher on a session, seen by
 * every participant who booked it. The write side had no check at all.
 */
export const isSafeMeetingLocation = (
  raw: string | null | undefined
): boolean => {
  if (!raw) {
    return true;
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    // Not a URL at all, which is the common case: a room, a building, a note.
    return true;
  }
};
