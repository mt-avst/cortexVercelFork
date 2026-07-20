/**
 * AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY
 * 
 * This file is automatically copied from the shared/ directory during the build process.
 * Any changes should be made to the source file in the shared/ directory.
 * 
 * Source: See copy-shared-types.js for the source path
 * Generated: 2026-07-20T21:07:33.084Z
 */

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
 */
export function isSafeTargetUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);

    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    // Not an absolute URL: allow only a root-relative same-origin path, never a
    // protocol-relative "//host", which resolves to a different origin.
    return raw.startsWith("/") && !raw.startsWith("//");
  }
}
