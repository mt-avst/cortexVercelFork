/**
 * AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY
 * 
 * This file is automatically copied from the shared/ directory during the build process.
 * Any changes should be made to the source file in the shared/ directory.
 * 
 * Source: See copy-shared-types.js for the source path
 * Generated: 2026-08-13T00:23:33.692Z
 */

/**
 * A base used only to decide whether a relative target stays on its own origin.
 *
 * Deliberately a `.invalid` host (RFC 6761 - guaranteed never resolvable) so it
 * cannot be confused with a real destination if it ever leaks into a message.
 * Nothing is ever fetched from it: it exists so the URL parser, rather than
 * string matching, decides where a relative path actually lands.
 */
const RELATIVE_RESOLUTION_BASE = "https://same-origin.invalid";

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
 * This is enforced twice: at the contract boundary when a session payload is
 * validated, and again at the sink in useTaskWindow, so the window navigation
 * never trusts its own input.
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
    // Not an absolute URL. Resolve it against a sentinel origin and require it
    // to have stayed there: anything that escapes - protocol-relative, or the
    // backslash and control-character forms above - lands on another origin and
    // is rejected. Parsing decides, not the shape of the string.
    try {
      const resolved = new URL(raw, RELATIVE_RESOLUTION_BASE);

      return (
        resolved.origin === RELATIVE_RESOLUTION_BASE && raw.startsWith("/")
      );
    } catch {
      return false;
    }
  }
}
