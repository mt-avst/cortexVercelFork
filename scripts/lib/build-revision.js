'use strict';

/**
 * Which commit a frontend build was produced from.
 *
 * WHY THIS EXISTS
 * The frontend and backend pods roll independently, so a green pipeline says
 * nothing about which build either one is serving. The backend answers this at
 * GET /api/health (backend/src/utils/buildInfo.ts); this is the frontend half,
 * written into dist/version.json at build time and served as a static file.
 *
 * Before it, checking a frontend deploy meant extracting the lazy-chunk list
 * from the entry bundle named in index.html and grepping the right chunk for a
 * string unique to the newest release - a method that reports "absent" for code
 * deployed days earlier if you grep the wrong chunk.
 *
 * THE COMMIT AND NOT THE RELEASE VERSION, for the same reason as the backend:
 * images are built on the main-branch pipeline and semantic-release cuts the
 * tag afterwards, so no version exists at build time. `git tag --contains
 * <sha>` recovers it.
 *
 * DUPLICATED RULE, DELIBERATELY. backend/src/utils/buildInfo.ts applies exactly
 * this validation to the same APP_COMMIT_SHA at runtime. The two cannot share
 * code - that one is a TypeScript module compiled into the backend image, this
 * one a CommonJS script run by the frontend build - so the pattern below and
 * the one there must be kept in step. Both test suites spell out the same
 * refused cases so a drift shows up as a failure rather than as two endpoints
 * quietly disagreeing.
 */

/**
 * A git commit sha and nothing else.
 *
 * The value arrives from the build environment and is written into a file
 * served unauthenticated from the public internet. Validating the shape rather
 * than writing the string through means a mis-set or unexpanded build argument
 * reports `unknown` instead of putting arbitrary build-environment text - or a
 * quote that would break the JSON - into a public response.
 */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

const UNKNOWN_REVISION = 'unknown';

function resolveBuildRevision(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';

  if (!trimmed || !COMMIT_SHA.test(trimmed)) {
    return UNKNOWN_REVISION;
  }

  return trimmed;
}

module.exports = { resolveBuildRevision, UNKNOWN_REVISION };
